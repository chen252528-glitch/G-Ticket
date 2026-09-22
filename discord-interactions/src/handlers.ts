import type { Env } from "./env";
import { getJpyToTwdRate } from "./rates";
import {
  createDb,
  deactivateRoutes,
  findActiveRoutes,
  getDailyLowStats,
  getLatestPriceSnapshot,
  listActiveRoutes,
  listJobStates,
  upsertRoute,
  type TrackedRoute
} from "./turso";

const PRICE_WINDOW_DAYS = 60;
// Within this band the fare counts as "around average" rather than cheap/expensive.
const PRICE_VERDICT_BAND_PERCENT = 5;

const VALID_CABINS = ["economy", "premium_economy", "business", "first"];
const VALID_TRIPS = ["round_trip", "one_way"];
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CABIN_ZH: Record<string, string> = {
  economy: "經濟艙",
  premium_economy: "豪華經濟艙",
  business: "商務艙",
  first: "頭等艙"
};

const TRIP_ZH: Record<string, string> = {
  round_trip: "來回",
  one_way: "單程"
};

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
}

export interface Interaction {
  type: number;
  application_id: string;
  token: string;
  data?: {
    name: string;
    options?: CommandOption[];
  };
}

interface FollowUpPayload {
  content: string;
}

// Commands are acknowledged with a deferred response first; this resolves the
// actual answer and edits it into the placeholder message.
export async function handleCommand(interaction: Interaction, env: Env): Promise<void> {
  let payload: FollowUpPayload;

  try {
    payload = await routeCommand(interaction, env);
  } catch (error) {
    console.error("[discord] command failed", error);
    payload = {
      content: `⚠️ 指令執行失敗:${error instanceof Error ? error.message : "未知錯誤"}`
    };
  }

  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    console.error(`[discord] follow-up failed with status ${response.status}`, await response.text());
  }
}

async function routeCommand(interaction: Interaction, env: Env): Promise<FollowUpPayload> {
  const commandName = interaction.data?.name;

  switch (commandName) {
    case "track":
      return handleTrack(interaction, env);
    case "price":
      return handlePrice(interaction, env);
    case "scan":
      return handleScan(interaction, env);
    case "status":
      return handleStatus(env);
    default:
      return { content: `未知的指令:${commandName ?? "<無>"}` };
  }
}

async function handleTrack(interaction: Interaction, env: Env): Promise<FollowUpPayload> {
  const subcommand = interaction.data?.options?.[0];

  if (!subcommand) {
    return { content: "缺少子指令。" };
  }

  const db = createDb(env);

  if (subcommand.name === "list") {
    const routes = await listActiveRoutes(db);

    if (routes.length === 0) {
      return { content: "目前沒有監控中的航線。用 `/track add` 新增。" };
    }

    const today = todayIsoDate();
    const lines = routes.map((route) => {
      const blocker = describeScanBlocker(route, today);
      return `• ${formatRoute(route)}${blocker ? ` ⚠️ ${blocker}` : ""}`;
    });

    return { content: `**目前監控中的航線(${routes.length} 條)**\n${lines.join("\n")}` };
  }

  const origin = requireAirportCode(subcommand.options, "origin");
  const destination = requireAirportCode(subcommand.options, "destination");
  const cabin = normalizeChoice(getStringOption(subcommand.options, "cabin"), VALID_CABINS);

  if (subcommand.name === "add") {
    const trip = normalizeChoice(getStringOption(subcommand.options, "trip"), VALID_TRIPS) ?? "round_trip";
    const cabinClass = cabin ?? "economy";
    const { departDate, returnDate } = requireTravelDates(subcommand.options, trip);
    const id = `td_${origin}_${destination}_${cabinClass}_${trip}`.toLowerCase();

    await upsertRoute(db, { id, origin, destination, cabin: cabinClass, trip, departDate, returnDate });

    const label =
      `${origin} → ${destination}` +
      `(${CABIN_ZH[cabinClass] ?? cabinClass},${TRIP_ZH[trip] ?? trip},${formatTravelDates(trip, departDate, returnDate)})`;

    return {
      content: [
        `✅ 已開始監控 **${label}**。`,
        "下次排程掃描就會開始抓價;同一條航線再下一次 `/track add` 可以更新日期。"
      ].join("\n")
    };
  }

  if (subcommand.name === "remove") {
    const removed = await deactivateRoutes(db, origin, destination, cabin);
    const cabinSuffix = cabin ? `(${CABIN_ZH[cabin] ?? cabin})` : "";

    if (removed === 0) {
      return { content: `沒有找到符合的監控航線 **${origin} → ${destination}**${cabinSuffix}。` };
    }

    return { content: `🛑 已停止監控 ${removed} 條 **${origin} → ${destination}**${cabinSuffix} 航線。` };
  }

  return { content: `未知的子指令:${subcommand.name}` };
}

async function handlePrice(interaction: Interaction, env: Env): Promise<FollowUpPayload> {
  const options = interaction.data?.options;
  const origin = requireAirportCode(options, "origin");
  const destination = requireAirportCode(options, "destination");
  const cabin = normalizeChoice(getStringOption(options, "cabin"), VALID_CABINS);
  const cabinSuffix = cabin ? `(${CABIN_ZH[cabin] ?? cabin})` : "";

  const db = createDb(env);
  const routes = await findActiveRoutes(db, origin, destination, cabin);

  if (routes.length === 0) {
    return {
      content: `沒有監控中的 **${origin} → ${destination}**${cabinSuffix} 航線。用 \`/track add\` 新增。`
    };
  }

  if (routes.length > 1) {
    const lines = routes.map((route) => `• ${CABIN_ZH[route.cabin] ?? route.cabin}(${TRIP_ZH[route.trip] ?? route.trip})`);
    return {
      content: `**${origin} → ${destination}** 符合多條監控航線 — 請加上 \`cabin\` 選項重查:\n${lines.join("\n")}`
    };
  }

  const route = routes[0];
  const snapshot = await getLatestPriceSnapshot(db, route.id);

  if (!snapshot) {
    return {
      content: `**${formatRoute(route)}** 還沒有票價紀錄。用 \`/scan job:normal-fares\` 觸發掃描後再試。`
    };
  }

  const twdRate = route.currencyCode === "JPY" ? await getJpyToTwdRate() : null;
  const stats = await getDailyLowStats(db, route.id, snapshot.latestDate, PRICE_WINDOW_DAYS);
  const headerLines = [
    `**${formatRoute(route)}**`,
    `最新掃描(${snapshot.latestDate})最低價:**${formatMoney(route.currencyCode, snapshot.currentLowMinor, twdRate)}**`
  ];

  if (snapshot.flightSummary) {
    headerLines.push(`✈️ ${snapshot.flightSummary}`);
  }

  if (!stats || stats.sampleDays === 0) {
    return {
      content: [
        ...headerLines,
        `歷史資料還不夠計算 ${PRICE_WINDOW_DAYS} 天平均 — 之後多掃幾天再查。`
      ].join("\n")
    };
  }

  const deltaPercent = ((snapshot.currentLowMinor - stats.averageMinor) / stats.averageMinor) * 100;

  return {
    content: [
      ...headerLines,
      `${PRICE_WINDOW_DAYS} 天每日最低價平均:${formatMoney(route.currencyCode, stats.averageMinor, twdRate)}(樣本 ${stats.sampleDays} 天)`,
      `${PRICE_WINDOW_DAYS} 天最低:${formatMoney(route.currencyCode, stats.windowLowMinor, twdRate)}`,
      buildVerdictLine(deltaPercent)
    ].join("\n")
  };
}

async function handleScan(interaction: Interaction, env: Env): Promise<FollowUpPayload> {
  const job = getStringOption(interaction.data?.options, "job");

  if (job !== "normal-fares" && job !== "business-deals") {
    return { content: "未知的工作。請選 `normal-fares` 或 `business-deals`。" };
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    return {
      content: "`/scan` 尚未設定:需要在 Worker 上設定 `GITHUB_TOKEN` secret 與 `GITHUB_REPOSITORY` 變數。"
    };
  }

  const ref = env.GITHUB_REF || "main";
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${job}.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "flight-radar-discord-worker"
      },
      body: JSON.stringify({ ref })
    }
  );

  if (response.status !== 204) {
    const body = await response.text();
    return { content: `⚠️ GitHub 觸發失敗(HTTP ${response.status}):${body.slice(0, 300)}` };
  }

  return {
    content: `🚀 已觸發 **${job}**(分支 \`${ref}\`)。進度:https://github.com/${env.GITHUB_REPOSITORY}/actions/workflows/${job}.yml`
  };
}

async function handleStatus(env: Env): Promise<FollowUpPayload> {
  const db = createDb(env);
  const states = await listJobStates(db);

  if (states.length === 0) {
    return { content: "還沒有任何工作執行紀錄。" };
  }

  const lines = states.map((state) => {
    const parts = [
      `上次啟動:${state.lastStartedAt ?? "從未"}`,
      `上次成功:${state.lastSucceededAt ?? "從未"}`,
      `上次失敗:${state.lastFailedAt ?? "從未"}`
    ];

    if (state.lastError) {
      parts.push(`最近錯誤:${state.lastError.split("\n")[0].slice(0, 120)}`);
    }

    return `**${state.jobName}** — ${parts.join("|")}`;
  });

  return { content: lines.join("\n") };
}

function buildVerdictLine(deltaPercent: number): string {
  const magnitude = Math.abs(deltaPercent).toFixed(1);

  if (deltaPercent <= -PRICE_VERDICT_BAND_PERCENT) {
    return `✅ **比 ${PRICE_WINDOW_DAYS} 天平均便宜 ${magnitude}%** — 可以考慮下手`;
  }

  if (deltaPercent >= PRICE_VERDICT_BAND_PERCENT) {
    return `🔺 **比 ${PRICE_WINDOW_DAYS} 天平均貴 ${magnitude}%** — 屬於溢價`;
  }

  return `➖ 與 ${PRICE_WINDOW_DAYS} 天平均差距在 ±${PRICE_VERDICT_BAND_PERCENT}% 內 — 正常價`;
}

function formatRoute(route: TrackedRoute): string {
  const cabin = CABIN_ZH[route.cabin] ?? route.cabin;
  const trip = TRIP_ZH[route.trip] ?? route.trip;
  const dates = route.departDate ? `,${formatTravelDates(route.trip, route.departDate, route.returnDate)}` : "";
  return `${route.origin} → ${route.destination}(${cabin},${trip}${dates})`;
}

function formatTravelDates(trip: string, departDate: string, returnDate?: string): string {
  if (trip === "round_trip" && returnDate) {
    return `${departDate} ~ ${returnDate}`;
  }

  return `${departDate} 出發`;
}

// Mirrors the scanner's skip rules so /track list shows why a route sits idle.
function describeScanBlocker(route: TrackedRoute, today: string): string | undefined {
  if (!route.departDate) {
    return "沒有出發日,排程不會掃描;請用 /track add 重新加入並填日期";
  }

  if (route.departDate < today) {
    return "出發日已過,排程不會掃描";
  }

  if (route.trip === "round_trip" && !route.returnDate) {
    return "沒有回程日,排程不會掃描;請用 /track add 重新加入並填 return";
  }

  return undefined;
}

// The scanner can only search routes with concrete dates (google_flights
// insists on outbound_date / return_date), so /track add demands them up front.
function requireTravelDates(
  options: CommandOption[] | undefined,
  trip: string
): { departDate: string; returnDate?: string } {
  const departDate = getIsoDateOption(options, "depart", "出發日");

  if (!departDate) {
    throw new Error("請填 `depart`(出發日,YYYY-MM-DD),排程掃描需要確切日期。");
  }

  const returnDate = getIsoDateOption(options, "return", "回程日");
  const today = todayIsoDate();

  if (departDate < today) {
    throw new Error(`出發日 ${departDate} 已經過了,請填今天(${today})或之後的日期。`);
  }

  if (trip === "round_trip") {
    if (!returnDate) {
      throw new Error("來回航線請填 `return`(回程日,YYYY-MM-DD);單程請把 `trip` 設為 one_way。");
    }

    if (returnDate < departDate) {
      throw new Error(`回程日 ${returnDate} 不能早於出發日 ${departDate}。`);
    }

    return { departDate, returnDate };
  }

  if (returnDate) {
    throw new Error("單程航線不用填 `return`;要來回請把 `trip` 設為 round_trip。");
  }

  return { departDate };
}

function getIsoDateOption(options: CommandOption[] | undefined, name: string, label: string): string | undefined {
  const value = getStringOption(options, name)?.trim();

  if (!value) {
    return undefined;
  }

  if (!ISO_DATE_PATTERN.test(value) || !isRealCalendarDate(value)) {
    throw new Error(`${label}「${value}」格式不對,請用 YYYY-MM-DD(例如 2026-12-26)。`);
  }

  return value;
}

function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// JPY renders as ¥ with an optional ≈NT$ conversion; TWD renders as NT$;
// anything else keeps the generic "CODE amount" form.
function formatMoney(currencyCode: string, amountMinor: number, jpyToTwdRate?: number | null): string {
  const amount = amountMinor / 100;

  if (currencyCode === "JPY") {
    const jpy = `¥${Math.round(amount).toLocaleString("en-US")}`;

    if (typeof jpyToTwdRate === "number" && jpyToTwdRate > 0) {
      const twd = Math.round(amount * jpyToTwdRate);
      return `${jpy}(約 NT$${twd.toLocaleString("en-US")})`;
    }

    return jpy;
  }

  if (currencyCode === "TWD") {
    return `NT$${Math.round(amount).toLocaleString("en-US")}`;
  }

  return `${currencyCode} ${amount.toFixed(2)}`;
}

function getStringOption(options: CommandOption[] | undefined, name: string): string | undefined {
  const value = options?.find((option) => option.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}

function requireAirportCode(options: CommandOption[] | undefined, name: string): string {
  const value = getStringOption(options, name)?.trim().toUpperCase();

  if (!value || !/^[A-Z]{3}$/.test(value)) {
    throw new Error(`選項「${name}」必須是 3 碼機場/都會區代碼(例如 TPE)。`);
  }

  return value;
}

function normalizeChoice(value: string | undefined, allowed: string[]): string | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (!allowed.includes(normalized)) {
    throw new Error(`值「${value}」無效。可用:${allowed.join("、")}。`);
  }

  return normalized;
}
