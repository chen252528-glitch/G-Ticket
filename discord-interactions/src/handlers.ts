import type { Env } from "./env";
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
      content: `⚠️ Command failed: ${error instanceof Error ? error.message : "unknown error"}`
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
      return { content: `Unknown command: ${commandName ?? "<none>"}` };
  }
}

async function handleTrack(interaction: Interaction, env: Env): Promise<FollowUpPayload> {
  const subcommand = interaction.data?.options?.[0];

  if (!subcommand) {
    return { content: "Missing subcommand." };
  }

  const db = createDb(env);

  if (subcommand.name === "list") {
    const routes = await listActiveRoutes(db);

    if (routes.length === 0) {
      return { content: "No active tracked routes. Add one with `/track add`." };
    }

    const lines = routes.map((route) => `• ${formatRoute(route)}`);
    return { content: `**Active tracked routes (${routes.length})**\n${lines.join("\n")}` };
  }

  const origin = requireAirportCode(subcommand.options, "origin");
  const destination = requireAirportCode(subcommand.options, "destination");
  const cabin = normalizeChoice(getStringOption(subcommand.options, "cabin"), VALID_CABINS);

  if (subcommand.name === "add") {
    const trip = normalizeChoice(getStringOption(subcommand.options, "trip"), VALID_TRIPS) ?? "round_trip";
    const cabinClass = cabin ?? "economy";
    const id = `td_${origin}_${destination}_${cabinClass}_${trip}`.toLowerCase();

    await upsertRoute(db, { id, origin, destination, cabin: cabinClass, trip });

    return {
      content: `✅ Tracking **${origin} → ${destination}** (${cabinClass}, ${trip}). The next normal-fares scan will pick it up.`
    };
  }

  if (subcommand.name === "remove") {
    const removed = await deactivateRoutes(db, origin, destination, cabin);

    if (removed === 0) {
      return { content: `No active tracked route found for **${origin} → ${destination}**${cabin ? ` (${cabin})` : ""}.` };
    }

    return { content: `🛑 Stopped tracking ${removed} route(s) for **${origin} → ${destination}**${cabin ? ` (${cabin})` : ""}.` };
  }

  return { content: `Unknown subcommand: ${subcommand.name}` };
}

async function handlePrice(interaction: Interaction, env: Env): Promise<FollowUpPayload> {
  const options = interaction.data?.options;
  const origin = requireAirportCode(options, "origin");
  const destination = requireAirportCode(options, "destination");
  const cabin = normalizeChoice(getStringOption(options, "cabin"), VALID_CABINS);

  const db = createDb(env);
  const routes = await findActiveRoutes(db, origin, destination, cabin);

  if (routes.length === 0) {
    return {
      content: `No active tracked route for **${origin} → ${destination}**${cabin ? ` (${cabin})` : ""}. Add one with \`/track add\`.`
    };
  }

  if (routes.length > 1) {
    const lines = routes.map((route) => `• ${route.cabin} (${route.trip})`);
    return {
      content: `Multiple tracked routes match **${origin} → ${destination}** — re-run \`/price\` with the \`cabin\` option:\n${lines.join("\n")}`
    };
  }

  const route = routes[0];
  const snapshot = await getLatestPriceSnapshot(db, route.id);

  if (!snapshot) {
    return {
      content: `**${formatRoute(route)}** has no fare observations yet. Trigger a scan with \`/scan normal-fares\` and try again.`
    };
  }

  const stats = await getDailyLowStats(db, route.id, snapshot.latestDate, PRICE_WINDOW_DAYS);
  const currentLine = `Current cheapest (${snapshot.latestDate}): **${formatMoney(route.currencyCode, snapshot.currentLowMinor)}**`;

  if (!stats || stats.sampleDays === 0) {
    return {
      content: [
        `**${formatRoute(route)}**`,
        currentLine,
        `Not enough history for a ${PRICE_WINDOW_DAYS}-day average yet — check back after a few more scans.`
      ].join("\n")
    };
  }

  const deltaPercent = ((snapshot.currentLowMinor - stats.averageMinor) / stats.averageMinor) * 100;

  return {
    content: [
      `**${formatRoute(route)}**`,
      currentLine,
      `${PRICE_WINDOW_DAYS}-day average of daily lows: ${formatMoney(route.currencyCode, stats.averageMinor)} (from ${stats.sampleDays} day(s))`,
      `${PRICE_WINDOW_DAYS}-day low: ${formatMoney(route.currencyCode, stats.windowLowMinor)}`,
      buildVerdictLine(deltaPercent)
    ].join("\n")
  };
}

async function handleScan(interaction: Interaction, env: Env): Promise<FollowUpPayload> {
  const job = getStringOption(interaction.data?.options, "job");

  if (job !== "normal-fares" && job !== "business-deals") {
    return { content: "Unknown job. Choose `normal-fares` or `business-deals`." };
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    return {
      content: "`/scan` is not configured: set the `GITHUB_TOKEN` secret and the `GITHUB_REPOSITORY` var on the Worker."
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
    return { content: `⚠️ GitHub dispatch failed with status ${response.status}: ${body.slice(0, 300)}` };
  }

  return {
    content: `🚀 Triggered **${job}** on \`${ref}\`. Progress: https://github.com/${env.GITHUB_REPOSITORY}/actions/workflows/${job}.yml`
  };
}

async function handleStatus(env: Env): Promise<FollowUpPayload> {
  const db = createDb(env);
  const states = await listJobStates(db);

  if (states.length === 0) {
    return { content: "No job runs recorded yet." };
  }

  const lines = states.map((state) => {
    const parts = [
      `last started: ${state.lastStartedAt ?? "never"}`,
      `last success: ${state.lastSucceededAt ?? "never"}`,
      `last failure: ${state.lastFailedAt ?? "never"}`
    ];

    if (state.lastError) {
      parts.push(`last error: ${state.lastError.split("\n")[0].slice(0, 120)}`);
    }

    return `**${state.jobName}** — ${parts.join(" | ")}`;
  });

  return { content: lines.join("\n") };
}

function buildVerdictLine(deltaPercent: number): string {
  const magnitude = Math.abs(deltaPercent).toFixed(1);

  if (deltaPercent <= -PRICE_VERDICT_BAND_PERCENT) {
    return `✅ **${magnitude}% below** the ${PRICE_WINDOW_DAYS}-day average — 便宜`;
  }

  if (deltaPercent >= PRICE_VERDICT_BAND_PERCENT) {
    return `🔺 **${magnitude}% above** the ${PRICE_WINDOW_DAYS}-day average — 溢價`;
  }

  return `➖ Within ±${PRICE_VERDICT_BAND_PERCENT}% of the ${PRICE_WINDOW_DAYS}-day average — 接近平均`;
}

function formatRoute(route: TrackedRoute): string {
  return `${route.origin} → ${route.destination} (${route.cabin}, ${route.trip})`;
}

function formatMoney(currencyCode: string, amountMinor: number): string {
  return `${currencyCode} ${(amountMinor / 100).toFixed(2)}`;
}

function getStringOption(options: CommandOption[] | undefined, name: string): string | undefined {
  const value = options?.find((option) => option.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}

function requireAirportCode(options: CommandOption[] | undefined, name: string): string {
  const value = getStringOption(options, name)?.trim().toUpperCase();

  if (!value || !/^[A-Z]{3}$/.test(value)) {
    throw new Error(`Option "${name}" must be a 3-letter airport/metro code (e.g. LON).`);
  }

  return value;
}

function normalizeChoice(value: string | undefined, allowed: string[]): string | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (!allowed.includes(normalized)) {
    throw new Error(`Invalid value "${value}". Allowed: ${allowed.join(", ")}.`);
  }

  return normalized;
}
