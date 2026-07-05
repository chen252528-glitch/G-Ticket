// Live JPY->TWD rate for dual-currency price replies. Cached in the isolate
// for 6 hours; on any failure we fall back to the last cached value or null
// (callers then show JPY only).
const RATE_TTL_MS = 6 * 60 * 60 * 1000;

let cached: { rate: number; fetchedAt: number } | null = null;

export async function getJpyToTwdRate(): Promise<number | null> {
  if (cached && Date.now() - cached.fetchedAt < RATE_TTL_MS) {
    return cached.rate;
  }

  try {
    const response = await fetch("https://open.er-api.com/v6/latest/JPY");

    if (!response.ok) {
      return cached?.rate ?? null;
    }

    const data = (await response.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.TWD;

    if (typeof rate !== "number" || !(rate > 0)) {
      return cached?.rate ?? null;
    }

    cached = { rate, fetchedAt: Date.now() };
    return rate;
  } catch {
    return cached?.rate ?? null;
  }
}
