import test from "node:test";
import assert from "node:assert/strict";
import type { NormalizedFareObservation } from "../types/domain.js";
import { buildNormalFareEmbed } from "./normal-fare-embed.js";

const fare: NormalizedFareObservation = {
  trackedDestinationId: "td_lon_hnd",
  observedAt: "2026-07-03T00:00:00.000Z",
  provider: "serpapi",
  providerQueryKey: "serpapi:td_lon_hnd:search-origin=LHR",
  originAirportCode: "LHR",
  destinationAirportCode: "HND",
  departDate: "2026-11-10",
  returnDate: "2026-11-20",
  cabinClass: "economy",
  tripType: "round_trip",
  priceAmountMinor: 10000,
  currencyCode: "GBP",
  flightFingerprint: "fp_test",
  rawPayloadJson: "{}"
};

function priceComparisonField(embed: ReturnType<typeof buildNormalFareEmbed>): string {
  const field = embed.fields.find((entry) => entry.name === "Price vs history");
  assert.ok(field, "embed should contain a price comparison field");
  return field.value;
}

test("includes the average comparison when a 60-day average is provided", () => {
  const embed = buildNormalFareEmbed(fare, {
    historicalLowestPriceAmountMinor: 9000,
    thirdLowestPriceAmountMinor: 12000,
    averageDailyLowAmountMinor: 20000,
    averageWindowDays: 60
  });

  const value = priceComparisonField(embed);
  assert.match(value, /60-day average: GBP 200\.00 \(50\.0% below average\)/);
});

test("marks fares above the average as above", () => {
  const embed = buildNormalFareEmbed(fare, {
    averageDailyLowAmountMinor: 8000,
    averageWindowDays: 60
  });

  const value = priceComparisonField(embed);
  assert.match(value, /60-day average: GBP 80\.00 \(25\.0% above average\)/);
});

test("omits the average line when no average is available", () => {
  const embed = buildNormalFareEmbed(fare, {
    historicalLowestPriceAmountMinor: 9000,
    thirdLowestPriceAmountMinor: 12000
  });

  const value = priceComparisonField(embed);
  assert.doesNotMatch(value, /average/);
});
