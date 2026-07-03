import { createClient, type Client } from "@libsql/client/web";
import type { Env } from "./env";

export interface TrackedRoute {
  id: string;
  origin: string;
  destination: string;
  cabin: string;
  trip: string;
  currencyCode: string;
}

export interface PriceSnapshot {
  latestDate: string;
  currentLowMinor: number;
}

export interface DailyLowStats {
  averageMinor: number;
  sampleDays: number;
  windowLowMinor: number;
}

export interface JobState {
  jobName: string;
  lastStartedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
  lastError?: string;
}

export function createDb(env: Env): Client {
  return createClient({
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN
  });
}

export async function listActiveRoutes(db: Client): Promise<TrackedRoute[]> {
  const result = await db.execute({
    sql: `
      SELECT id, origin_airport_code, destination_airport_code, cabin_class, trip_type, currency_code
      FROM tracked_destinations
      WHERE is_active = 1
      ORDER BY origin_airport_code, destination_airport_code, cabin_class
    `,
    args: []
  });

  return result.rows.map(mapRouteRow);
}

export async function findActiveRoutes(
  db: Client,
  origin: string,
  destination: string,
  cabin?: string
): Promise<TrackedRoute[]> {
  const filters = ["origin_airport_code = ?", "destination_airport_code = ?", "is_active = 1"];
  const args: string[] = [origin, destination];

  if (cabin) {
    filters.push("cabin_class = ?");
    args.push(cabin);
  }

  const result = await db.execute({
    sql: `
      SELECT id, origin_airport_code, destination_airport_code, cabin_class, trip_type, currency_code
      FROM tracked_destinations
      WHERE ${filters.join(" AND ")}
      ORDER BY cabin_class, trip_type
    `,
    args
  });

  return result.rows.map(mapRouteRow);
}

export async function upsertRoute(db: Client, route: {
  id: string;
  origin: string;
  destination: string;
  cabin: string;
  trip: string;
}): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO tracked_destinations (id, origin_airport_code, destination_airport_code, trip_type, cabin_class, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET is_active = 1, updated_at = CURRENT_TIMESTAMP
    `,
    args: [route.id, route.origin, route.destination, route.trip, route.cabin]
  });
}

export async function deactivateRoutes(
  db: Client,
  origin: string,
  destination: string,
  cabin?: string
): Promise<number> {
  const filters = ["origin_airport_code = ?", "destination_airport_code = ?", "is_active = 1"];
  const args: string[] = [origin, destination];

  if (cabin) {
    filters.push("cabin_class = ?");
    args.push(cabin);
  }

  const result = await db.execute({
    sql: `
      UPDATE tracked_destinations
      SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE ${filters.join(" AND ")}
    `,
    args
  });

  return Number(result.rowsAffected ?? 0);
}

export async function getLatestPriceSnapshot(db: Client, trackedDestinationId: string): Promise<PriceSnapshot | null> {
  const latest = await db.execute({
    sql: `
      SELECT date(MAX(observed_at)) AS latest_date
      FROM fare_observations
      WHERE tracked_destination_id = ?
    `,
    args: [trackedDestinationId]
  });

  const latestDate = latest.rows[0]?.latest_date;

  if (typeof latestDate !== "string") {
    return null;
  }

  const low = await db.execute({
    sql: `
      SELECT MIN(price_amount_minor) AS current_low
      FROM fare_observations
      WHERE tracked_destination_id = ?
        AND date(observed_at) = ?
    `,
    args: [trackedDestinationId, latestDate]
  });

  const currentLow = low.rows[0]?.current_low;

  if (currentLow === null || typeof currentLow === "undefined") {
    return null;
  }

  return {
    latestDate,
    currentLowMinor: Number(currentLow)
  };
}

// Average of each day's cheapest observed fare over the window, excluding the
// latest scan day itself so "current vs average" compares against the past.
export async function getDailyLowStats(
  db: Client,
  trackedDestinationId: string,
  excludeDate: string,
  windowDays: number
): Promise<DailyLowStats | null> {
  const result = await db.execute({
    sql: `
      SELECT
        AVG(daily_low) AS average_minor,
        COUNT(*) AS sample_days,
        MIN(daily_low) AS window_low
      FROM (
        SELECT MIN(price_amount_minor) AS daily_low
        FROM fare_observations
        WHERE tracked_destination_id = ?
          AND date(observed_at) >= date('now', ?)
          AND date(observed_at) < ?
        GROUP BY date(observed_at)
      )
    `,
    args: [trackedDestinationId, `-${windowDays} days`, excludeDate]
  });

  const row = result.rows[0];

  if (!row || row.average_minor === null || typeof row.average_minor === "undefined") {
    return null;
  }

  return {
    averageMinor: Math.round(Number(row.average_minor)),
    sampleDays: Number(row.sample_days ?? 0),
    windowLowMinor: Number(row.window_low ?? 0)
  };
}

export async function listJobStates(db: Client): Promise<JobState[]> {
  const result = await db.execute({
    sql: `
      SELECT job_name, last_started_at, last_succeeded_at, last_failed_at, last_error
      FROM job_scheduler_state
      ORDER BY job_name
    `,
    args: []
  });

  return result.rows.map((row) => ({
    jobName: String(row.job_name),
    lastStartedAt: optionalString(row.last_started_at),
    lastSucceededAt: optionalString(row.last_succeeded_at),
    lastFailedAt: optionalString(row.last_failed_at),
    lastError: optionalString(row.last_error)
  }));
}

function mapRouteRow(row: Record<string, unknown>): TrackedRoute {
  return {
    id: String(row.id),
    origin: String(row.origin_airport_code),
    destination: String(row.destination_airport_code),
    cabin: String(row.cabin_class),
    trip: String(row.trip_type),
    currencyCode: String(row.currency_code)
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
