import test from "node:test";
import assert from "node:assert/strict";
import type { DiscordEmbed, NormalizedFareObservation, SerpApiFlightResult, TrackedDestination } from "../types/domain.js";

import { NormalFaresJobError, getRouteSkipReason, runNormalFaresJob } from "./normal-fares.js";

const TODAY = "2026-09-22";
const now = () => new Date(`${TODAY}T00:00:00.000Z`);
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function buildDestination(overrides: Partial<TrackedDestination> = {}): TrackedDestination {
  return {
    id: "td_hnd_tpe",
    originAirportCode: "HND",
    destinationAirportCode: "TPE",
    tripType: "round_trip",
    cabinClass: "economy",
    departureDateFrom: "2026-12-26",
    returnDateFrom: "2027-01-10",
    currencyCode: "JPY",
    locale: "ja-JP",
    isActive: true,
    ...overrides
  };
}

interface HarnessOptions {
  destinations: TrackedDestination[];
  searchFlights?: (destination: TrackedDestination) => Promise<SerpApiFlightResult[]>;
  sendEmbed?: (embed: DiscordEmbed) => Promise<{ messageId?: string }>;
}

function createHarness(options: HarnessOptions) {
  const searched: TrackedDestination[] = [];
  const inserted: NormalizedFareObservation[] = [];
  const recordedAlerts: string[] = [];
  const sentEmbeds: DiscordEmbed[] = [];

  const deps = {
    repository: {
      listActiveTrackedDestinations: async () => options.destinations,
      listLowestHistoricalFares: async () => [],
      getAverageDailyLowFare: async () => null,
      insertFareObservation: async (observation: NormalizedFareObservation) => {
        inserted.push(observation);
        return { id: `obs_${inserted.length}` };
      },
      hasSentFareAlert: async () => false,
      recordFareAlert: async (args: { fareObservationId: string }) => {
        recordedAlerts.push(args.fareObservationId);
      }
    },
    serpApiClient: {
      searchFlights: async (destination: TrackedDestination) => {
        searched.push(destination);
        return options.searchFlights
          ? options.searchFlights(destination)
          : [buildResult(destination.originAirportCode, destination.destinationAirportCode)];
      }
    },
    discordClient: {
      sendEmbed: async (embed: DiscordEmbed) => {
        sentEmbeds.push(embed);
        return options.sendEmbed ? options.sendEmbed(embed) : { messageId: "discord_message_1" };
      }
    },
    normalizeObservation: buildObservation,
    now,
    logger: silentLogger
  };

  return { deps, searched, inserted, recordedAlerts, sentEmbeds };
}

function buildObservation(args: {
  trackedDestinationId: string;
  providerQueryKey: string;
  destination: TrackedDestination;
  result: SerpApiFlightResult;
}): NormalizedFareObservation {
  const { trackedDestinationId, providerQueryKey, destination, result } = args;
  const originAirportCode = result.flights[0]?.departure_airport?.id ?? destination.originAirportCode;

  return {
    trackedDestinationId,
    provider: "serpapi",
    providerQueryKey,
    observedAt: `${TODAY}T00:00:00.000Z`,
    originAirportCode,
    destinationAirportCode: destination.destinationAirportCode,
    departDate: destination.departureDateFrom,
    returnDate: destination.returnDateFrom,
    tripType: destination.tripType,
    cabinClass: destination.cabinClass,
    priceAmountMinor: Math.round(result.price * 100),
    currencyCode: result.currency ?? destination.currencyCode,
    deepLink: result.deep_link,
    flightFingerprint: `fp_${originAirportCode}_${result.price}`,
    rawPayloadJson: JSON.stringify(result)
  };
}

function buildResult(originAirportCode: string, destinationAirportCode: string, price = 100): SerpApiFlightResult {
  return {
    price,
    currency: "JPY",
    flights: [
      {
        departure_airport: { id: originAirportCode, time: "2026-12-26 08:00" },
        arrival_airport: { id: destinationAirportCode, time: "2026-12-26 11:00" },
        airline: "Example Air",
        flight_number: "EX 123"
      }
    ],
    layovers: [],
    total_duration: 180,
    departure_date: "2026-12-26",
    return_date: "2027-01-10",
    deep_link: "https://example.com"
  };
}

test("runNormalFaresJob expands LON searches and only keeps matching London-origin flights", async () => {
  const harness = createHarness({
    destinations: [
      buildDestination({
        id: "td_lon_cph",
        originAirportCode: "LON",
        destinationAirportCode: "CPH",
        currencyCode: "GBP",
        locale: "en-GB"
      })
    ],
    searchFlights: async (destination) =>
      destination.originAirportCode === "LHR" ? [buildResult("LHR", "CPH"), buildResult("CDG", "CPH")] : []
  });

  await runNormalFaresJob(harness.deps as never);

  assert.deepEqual(
    harness.searched.map((destination) => destination.originAirportCode),
    ["LHR", "LGW", "LCY", "LTN", "STN", "SEN"]
  );
  assert.deepEqual(harness.inserted.map((observation) => observation.originAirportCode), ["LHR"]);
});

test("a failing route is reported at the end without stopping the other routes", async () => {
  const harness = createHarness({
    destinations: [buildDestination({ id: "td_broken" }), buildDestination({ id: "td_ok", destinationAirportCode: "TSA" })],
    searchFlights: async (destination) => {
      if (destination.id === "td_broken") {
        throw new Error("SerpApi request failed with status 400");
      }

      return [buildResult(destination.originAirportCode, destination.destinationAirportCode)];
    }
  });

  await assert.rejects(runNormalFaresJob(harness.deps as never), (error: unknown) => {
    assert.ok(error instanceof NormalFaresJobError);
    assert.deepEqual(error.summary.scanned, ["td_ok"]);
    assert.equal(error.summary.failed.length, 1);
    assert.equal(error.summary.failed[0].id, "td_broken");
    assert.ok(error.message.includes("td_broken"));
    assert.ok(error.message.includes("status 400"));
    return true;
  });

  assert.deepEqual(harness.searched.map((destination) => destination.id), ["td_broken", "td_ok"]);
  assert.deepEqual(harness.inserted.map((observation) => observation.trackedDestinationId), ["td_ok"]);
});

test("routes google_flights cannot search are skipped without calling SerpApi or failing the job", async () => {
  const harness = createHarness({
    destinations: [
      buildDestination({ id: "td_no_date", departureDateFrom: undefined, returnDateFrom: undefined }),
      buildDestination({ id: "td_expired", departureDateFrom: "2026-09-16", returnDateFrom: "2026-09-20" }),
      buildDestination({ id: "td_no_return", returnDateFrom: undefined }),
      buildDestination({ id: "td_ok" })
    ]
  });

  await runNormalFaresJob(harness.deps as never);

  assert.deepEqual(harness.searched.map((destination) => destination.id), ["td_ok"]);
  assert.deepEqual(harness.inserted.map((observation) => observation.trackedDestinationId), ["td_ok"]);
});

test("getRouteSkipReason explains why a route will not be scanned", () => {
  assert.equal(getRouteSkipReason(buildDestination(), TODAY), undefined);
  assert.equal(getRouteSkipReason(buildDestination({ departureDateFrom: TODAY }), TODAY), undefined);
  assert.equal(getRouteSkipReason(buildDestination({ tripType: "one_way", returnDateFrom: undefined }), TODAY), undefined);
  assert.match(getRouteSkipReason(buildDestination({ departureDateFrom: "2026-09-21" }), TODAY) ?? "", /has passed/);
  assert.match(getRouteSkipReason(buildDestination({ departureDateFrom: undefined }), TODAY) ?? "", /no departure date/);
  assert.match(getRouteSkipReason(buildDestination({ returnDateFrom: undefined }), TODAY) ?? "", /no return date/);
});

test("a failing webhook keeps observations flowing and is reported at the end", async () => {
  const harness = createHarness({
    destinations: [buildDestination()],
    searchFlights: async (destination) => [
      buildResult(destination.originAirportCode, destination.destinationAirportCode, 120),
      buildResult(destination.originAirportCode, destination.destinationAirportCode, 90)
    ],
    sendEmbed: async () => {
      throw new Error("Discord webhook request failed with status 401");
    }
  });

  await assert.rejects(runNormalFaresJob(harness.deps as never), (error: unknown) => {
    assert.ok(error instanceof NormalFaresJobError);
    assert.deepEqual(error.summary.scanned, ["td_hnd_tpe"]);
    assert.deepEqual(error.summary.failed, []);
    assert.equal(error.summary.alertFailures, 2);
    return true;
  });

  assert.equal(harness.inserted.length, 2);
  assert.equal(harness.sentEmbeds.length, 2);
  assert.deepEqual(harness.recordedAlerts, []);
});
