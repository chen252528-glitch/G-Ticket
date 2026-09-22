import type { DiscordWebhookClient } from "../clients/discord.js";
import type { FlightPriceRepository } from "../db/repositories.js";
import { getSerpApiSearchProblem, type SerpApiClient } from "../clients/serpapi.js";
import { loadExchangeRates } from "../config/exchange-rates.js";
import { buildFareAlertFingerprint, qualifiesForTopThreeAlert } from "../logic/fare-ranking.js";
import { buildNormalFareEmbed } from "../notifications/normal-fare-embed.js";
import type { NormalizedFareObservation, SerpApiFlightResult, TrackedDestination } from "../types/domain.js";
import { createStableId } from "../utils/id.js";

const airportSearchExpansions: Readonly<Record<string, readonly string[]>> = {
  LON: ["LHR", "LGW", "LCY", "LTN", "STN", "SEN"]
};

// Two-month window used to tell whether an alerted fare is cheap or expensive
// relative to what this route normally costs.
const FARE_AVERAGE_WINDOW_DAYS = 60;

type JobLogger = Pick<Console, "info" | "warn" | "error">;

export interface NormalFaresJobDeps {
  repository: FlightPriceRepository;
  serpApiClient: SerpApiClient;
  discordClient: DiscordWebhookClient;
  normalizeObservation: (args: {
    trackedDestinationId: string;
    providerQueryKey: string;
    destination: Parameters<SerpApiClient["searchFlights"]>[0];
    result: SerpApiFlightResult;
  }) => NormalizedFareObservation;
  now?: () => Date;
  logger?: JobLogger;
}

export interface NormalFaresJobSummary {
  scanned: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
  alertFailures: number;
}

// Thrown only after every route has been attempted, so one broken route (or a
// broken webhook) gets reported without stopping the others from being scanned.
export class NormalFaresJobError extends Error {
  readonly summary: NormalFaresJobSummary;

  constructor(summary: NormalFaresJobSummary) {
    super(buildFailureMessage(summary));
    this.name = "NormalFaresJobError";
    this.summary = summary;
  }
}

export async function runNormalFaresJob(deps: NormalFaresJobDeps): Promise<void> {
  const logger = deps.logger ?? console;
  const today = toIsoDate(deps.now ? deps.now() : new Date());
  const destinations = await deps.repository.listActiveTrackedDestinations();
  const jpyToTwdRate = await resolveJpyToTwdRate();
  const summary: NormalFaresJobSummary = { scanned: [], skipped: [], failed: [], alertFailures: 0 };

  for (const destination of destinations) {
    const skipReason = getRouteSkipReason(destination, today);

    if (skipReason) {
      logger.warn(`[normal-fares] skipped ${destination.id}: ${skipReason}`);
      summary.skipped.push({ id: destination.id, reason: skipReason });
      continue;
    }

    try {
      summary.alertFailures += await scanDestination(deps, destination, jpyToTwdRate, logger);
      summary.scanned.push(destination.id);
    } catch (error) {
      const message = describeError(error);
      logger.error(`[normal-fares] route ${destination.id} failed: ${message}`);
      summary.failed.push({ id: destination.id, error: message });
    }
  }

  logger.info(
    `[normal-fares] scanned ${summary.scanned.length}, skipped ${summary.skipped.length}, ` +
      `failed ${summary.failed.length}, alert failures ${summary.alertFailures}`
  );

  if (summary.failed.length > 0 || summary.alertFailures > 0) {
    throw new NormalFaresJobError(summary);
  }
}

// A route can only be searched while google_flights would accept it: it needs
// a departure date (plus a return date for round trips) that has not passed.
// Anything else is a configuration gap, not a runtime failure, so it is
// skipped with a warning instead of failing the job.
export function getRouteSkipReason(destination: TrackedDestination, today: string): string | undefined {
  const problem = getSerpApiSearchProblem(destination);

  if (problem) {
    return problem;
  }

  if (destination.departureDateFrom && destination.departureDateFrom < today) {
    return `departure date ${destination.departureDateFrom} has passed`;
  }

  return undefined;
}

async function scanDestination(
  deps: NormalFaresJobDeps,
  destination: TrackedDestination,
  jpyToTwdRate: number | undefined,
  logger: JobLogger
): Promise<number> {
  let alertFailures = 0;
  const averageDailyLow = await deps.repository.getAverageDailyLowFare(destination.id, FARE_AVERAGE_WINDOW_DAYS);
  const searchDestinations = buildSearchDestinations(destination);

  for (const searchDestination of searchDestinations) {
    const results = await deps.serpApiClient.searchFlights(searchDestination);
    const filteredResults = results.filter((result) =>
      matchesTargetOriginAirport(result, destination.originAirportCode)
    );

    for (const result of filteredResults) {
      const observation = deps.normalizeObservation({
        trackedDestinationId: destination.id,
        providerQueryKey: buildProviderQueryKey(destination.id, searchDestination.originAirportCode),
        destination: searchDestination,
        result
      });

      const historicalLowestFares = await deps.repository.listLowestHistoricalFares(destination.id, 3);

      let observationRecord;
      try {
        observationRecord = await deps.repository.insertFareObservation(observation);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          continue;
        }

        throw error;
      }

      const alertFingerprint = buildFareAlertFingerprint(observation);
      const alreadyAlerted = await deps.repository.hasSentFareAlert(alertFingerprint);

      if (!qualifiesForTopThreeAlert(historicalLowestFares, observation) || alreadyAlerted) {
        continue;
      }

      const sortedHistoricalPrices = historicalLowestFares
        .map((fare) => fare.priceAmountMinor)
        .sort((left, right) => left - right);

      // The observation is already stored. If the webhook fails, the alert is
      // left unrecorded so the next run retries it instead of the scan dying.
      try {
        const { messageId } = await deps.discordClient.sendEmbed(buildNormalFareEmbed(observation, {
          historicalLowestPriceAmountMinor: sortedHistoricalPrices[0],
          thirdLowestPriceAmountMinor: sortedHistoricalPrices[2],
          averageDailyLowAmountMinor: averageDailyLow?.averagePriceAmountMinor,
          averageWindowDays: FARE_AVERAGE_WINDOW_DAYS,
          jpyToTwdRate
        }));

        await deps.repository.recordFareAlert({
          id: createStableId("fare_alert", alertFingerprint),
          fareObservationId: observationRecord.id,
          trackedDestinationId: destination.id,
          alertFingerprint,
          discordMessageId: messageId
        });
      } catch (error) {
        alertFailures += 1;
        logger.error(
          `[normal-fares] alert failed for ${destination.id} ` +
            `(${observation.priceAmountMinor} ${observation.currencyCode} minor units): ${describeError(error)}`
        );
      }
    }
  }

  return alertFailures;
}

// The first line is what Discord /status shows, so it names the first failure.
function buildFailureMessage(summary: NormalFaresJobSummary): string {
  const attempted = summary.scanned.length + summary.failed.length;
  const [firstFailure, ...otherFailures] = summary.failed;
  const headline =
    `${summary.failed.length}/${attempted} routes failed, ${summary.alertFailures} alerts failed` +
    (firstFailure ? `; ${firstFailure.id}: ${firstFailure.error}` : "");

  return [headline, ...otherFailures.map((failure) => `${failure.id}: ${failure.error}`)].join("\n");
}

function buildSearchDestinations(destination: TrackedDestination): TrackedDestination[] {
  const normalizedOriginAirportCode = destination.originAirportCode.toUpperCase();
  const expandedOriginAirportCodes = airportSearchExpansions[normalizedOriginAirportCode] ?? [normalizedOriginAirportCode];

  return expandedOriginAirportCodes.map((originAirportCode) => ({
    ...destination,
    originAirportCode
  }));
}

function matchesTargetOriginAirport(result: SerpApiFlightResult, expectedOriginAirportCode: string): boolean {
  const actualOriginAirportCode = extractActualOriginAirportCode(result);

  if (!actualOriginAirportCode) {
    return false;
  }

  const normalizedExpectedOriginAirportCode = expectedOriginAirportCode.toUpperCase();
  const normalizedActualOriginAirportCode = actualOriginAirportCode.toUpperCase();

  if (normalizedExpectedOriginAirportCode === "LON") {
    return isLondonAirportCode(normalizedActualOriginAirportCode);
  }

  return normalizedActualOriginAirportCode === normalizedExpectedOriginAirportCode;
}

function isLondonAirportCode(airportCode: string): boolean {
  return ["LON", "LGW", "LTN", "STN", "LHR", "LCY", "SEN"].includes(airportCode);
}

function extractActualOriginAirportCode(result?: SerpApiFlightResult): string | undefined {
  return result?.flights?.[0]?.departure_airport?.id;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique|constraint|already exists/i.test(error.message);
}

function buildProviderQueryKey(trackedDestinationId: string, searchOriginAirportCode: string): string {
  return `serpapi:${trackedDestinationId}:search-origin=${searchOriginAirportCode}`;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Cross rate derived from the bundled GBP-based exchange-rates.json; refresh
// it with `npm run update:exchange-rates`. Alerts fall back to JPY-only
// display when the rates file is unavailable.
async function resolveJpyToTwdRate(): Promise<number | undefined> {
  try {
    const rates = await loadExchangeRates();
    const jpy = rates.rates.JPY;
    const twd = rates.rates.TWD;

    if (typeof jpy === "number" && typeof twd === "number" && twd > 0) {
      return jpy / twd;
    }
  } catch {
    // fall through to JPY-only display
  }

  return undefined;
}
