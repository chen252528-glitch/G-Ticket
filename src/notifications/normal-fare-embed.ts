import type { DiscordEmbed, NormalizedFareObservation } from "../types/domain.js";

export interface NormalFarePriceComparison {
  thirdLowestPriceAmountMinor?: number;
  historicalLowestPriceAmountMinor?: number;
  averageDailyLowAmountMinor?: number;
  averageWindowDays?: number;
  /** JPY->TWD rate for dual-currency display; omit to show JPY only. */
  jpyToTwdRate?: number;
}

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

export function buildNormalFareEmbed(
  fare: NormalizedFareObservation,
  comparison: NormalFarePriceComparison = {}
): DiscordEmbed {
  return {
    title: `發現便宜票價:${fare.originAirportCode} → ${fare.destinationAirportCode}`,
    description: buildDescription(comparison),
    url: fare.deepLink,
    color: 0x2ecc71,
    fields: [
      { name: "價格", value: formatMoney(fare.currencyCode, fare.priceAmountMinor, comparison.jpyToTwdRate), inline: true },
      { name: "行程", value: TRIP_ZH[fare.tripType] ?? fare.tripType, inline: true },
      { name: "艙等", value: CABIN_ZH[fare.cabinClass] ?? fare.cabinClass, inline: true },
      { name: "航班", value: buildFlightLabel(fare), inline: true },
      { name: "來源", value: buildSourceLabel(fare), inline: true },
      { name: "出發", value: fare.departDate ?? "未知", inline: true },
      { name: "回程", value: fare.returnDate ?? "未知", inline: true },
      { name: "價格 vs 歷史", value: buildPriceComparison(fare, comparison), inline: false }
    ],
    timestamp: fare.observedAt
  };
}

function buildDescription(comparison: NormalFarePriceComparison): string {
  if (typeof comparison.thirdLowestPriceAmountMinor === "number") {
    return "新票價進入這條航線的歷史前三低!";
  }

  return "還在累積歷史基準,先記錄這筆新票價。";
}

function buildSourceLabel(fare: NormalizedFareObservation): string {
  return fare.providerQueryKey;
}

interface RawFlightLeg {
  airline?: string;
  flight_number?: string;
  departure_airport?: { id?: string; time?: string };
  arrival_airport?: { id?: string; time?: string };
}

// Traditional-Chinese airline names keyed by IATA code (from the flight
// number prefix, which is locale-independent). Unknown codes fall back to
// the provider's original airline name.
const AIRLINE_NAMES_ZH: Record<string, string> = {
  GK: "捷星日本",
  MM: "樂桃航空",
  "6J": "索拉西德航空",
  BC: "天馬航空",
  "7G": "星悅航空",
  IJ: "春秋航空日本",
  NH: "全日空",
  JL: "日本航空",
  NU: "日本越洋航空",
  HD: "AIRDO",
  CI: "中華航空",
  AE: "華信航空",
  BR: "長榮航空",
  B7: "立榮航空",
  IT: "台灣虎航",
  JX: "星宇航空",
  CX: "國泰航空",
  TR: "酷航"
};

function localizeAirlineName(leg: RawFlightLeg): string {
  const iataCode = leg.flight_number?.trim().split(/\s+/)[0]?.toUpperCase();
  return (iataCode && AIRLINE_NAMES_ZH[iataCode]) || leg.airline || "未知航空公司";
}

function buildFlightLabel(fare: NormalizedFareObservation): string {
  return summarizeFlightLegs(fare.rawPayloadJson) ?? "未知";
}

// The SerpApi result stored in rawPayloadJson carries the flight legs;
// condense them to "airline flight-number dep→arr" for the alert embed.
function summarizeFlightLegs(rawPayloadJson: string): string | undefined {
  try {
    const raw = JSON.parse(rawPayloadJson) as { flights?: RawFlightLeg[] };
    const legs = Array.isArray(raw.flights) ? raw.flights : [];

    if (legs.length === 0) {
      return undefined;
    }

    const parts = legs.map((leg) => {
      const airline = localizeAirlineName(leg);
      const flightNumber = leg.flight_number ?? "";
      const departureTime = extractClockTime(leg.departure_airport?.time);
      const arrivalTime = extractClockTime(leg.arrival_airport?.time);
      const times = departureTime && arrivalTime ? ` ${departureTime}→${arrivalTime}` : "";
      return `${airline} ${flightNumber}${times}`.replace(/\s+/g, " ").trim();
    });

    return parts.join(" ➔ ");
  } catch {
    return undefined;
  }
}

function extractClockTime(value: string | undefined): string | undefined {
  return value?.split(" ")[1];
}

function buildPriceComparison(
  fare: NormalizedFareObservation,
  comparison: NormalFarePriceComparison
): string {
  const lines: string[] = [];
  const rate = comparison.jpyToTwdRate;

  if (typeof comparison.historicalLowestPriceAmountMinor === "number") {
    const delta = fare.priceAmountMinor - comparison.historicalLowestPriceAmountMinor;
    const direction = delta <= 0 ? "低" : "高";
    lines.push(
      `歷史最低:${formatMoney(fare.currencyCode, comparison.historicalLowestPriceAmountMinor, rate)}(比它${direction} ${formatMoney(fare.currencyCode, Math.abs(delta))})`
    );
  }

  if (typeof comparison.thirdLowestPriceAmountMinor === "number") {
    const delta = comparison.thirdLowestPriceAmountMinor - fare.priceAmountMinor;
    const percentage = comparison.thirdLowestPriceAmountMinor > 0
      ? ((delta / comparison.thirdLowestPriceAmountMinor) * 100).toFixed(1)
      : "0.0";

    lines.push(
      `前三低門檻:${formatMoney(fare.currencyCode, comparison.thirdLowestPriceAmountMinor, rate)}(便宜 ${formatMoney(fare.currencyCode, Math.abs(delta))},低 ${percentage}%)`
    );
  }

  if (typeof comparison.averageDailyLowAmountMinor === "number" && comparison.averageDailyLowAmountMinor > 0) {
    const windowDays = comparison.averageWindowDays ?? 60;
    const delta = fare.priceAmountMinor - comparison.averageDailyLowAmountMinor;
    const percentage = (Math.abs(delta) / comparison.averageDailyLowAmountMinor * 100).toFixed(1);
    const direction = delta <= 0 ? "低" : "高";

    lines.push(
      `${windowDays} 天平均:${formatMoney(fare.currencyCode, comparison.averageDailyLowAmountMinor, rate)}(比平均${direction} ${percentage}%)`
    );
  }

  if (lines.length === 0) {
    return "歷史票價還不夠多。";
  }

  return lines.join("\n");
}

// JPY renders as ¥ with an optional ≈NT$ conversion; TWD renders as NT$;
// anything else keeps the generic "CODE amount" form.
function formatMoney(currencyCode: string, amountMinor: number, jpyToTwdRate?: number): string {
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
