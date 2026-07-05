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
  const field = embed.fields.find((entry) => entry.name === "價格 vs 歷史");
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
  assert.ok(value.includes("60 天平均:GBP 200.00(比平均低 50.0%)"), value);
});

test("marks fares above the average as above", () => {
  const embed = buildNormalFareEmbed(fare, {
    averageDailyLowAmountMinor: 8000,
    averageWindowDays: 60
  });

  const value = priceComparisonField(embed);
  assert.ok(value.includes("60 天平均:GBP 80.00(比平均高 25.0%)"), value);
});

test("renders JPY prices with a TWD conversion when a rate is provided", () => {
  const embed = buildNormalFareEmbed(
    { ...fare, currencyCode: "JPY", priceAmountMinor: 1298000 },
    { jpyToTwdRate: 0.208 }
  );

  const priceField = embed.fields.find((entry) => entry.name === "價格");
  assert.ok(priceField, "embed should contain a price field");
  assert.equal(priceField.value, "¥12,980(約 NT$2,700)");
});

test("renders JPY prices without conversion when no rate is provided", () => {
  const embed = buildNormalFareEmbed({ ...fare, currencyCode: "JPY", priceAmountMinor: 1298000 });

  const priceField = embed.fields.find((entry) => entry.name === "價格");
  assert.ok(priceField, "embed should contain a price field");
  assert.equal(priceField.value, "¥12,980");
});

test("includes airline and flight number when the raw payload has flight legs", () => {
  const embed = buildNormalFareEmbed({
    ...fare,
    rawPayloadJson: JSON.stringify({
      flights: [
        {
          airline: "ジェットスター",
          flight_number: "GK 611",
          departure_airport: { id: "NRT", time: "2026-09-16 07:15" },
          arrival_airport: { id: "KMJ", time: "2026-09-16 09:20" }
        }
      ]
    })
  });

  const field = embed.fields.find((entry) => entry.name === "航班");
  assert.ok(field, "embed should contain a flight field");
  assert.equal(field.value, "捷星日本 GK 611 07:15→09:20");
});

test("falls back to the provider airline name for unknown airline codes", () => {
  const embed = buildNormalFareEmbed({
    ...fare,
    rawPayloadJson: JSON.stringify({
      flights: [
        {
          airline: "Some Airline",
          flight_number: "ZZ 123",
          departure_airport: { id: "LHR", time: "2026-11-10 09:00" },
          arrival_airport: { id: "HND", time: "2026-11-11 06:00" }
        }
      ]
    })
  });

  const field = embed.fields.find((entry) => entry.name === "航班");
  assert.ok(field, "embed should contain a flight field");
  assert.equal(field.value, "Some Airline ZZ 123 09:00→06:00");
});

test("shows unknown flight when the raw payload has no flight legs", () => {
  const embed = buildNormalFareEmbed(fare);

  const field = embed.fields.find((entry) => entry.name === "航班");
  assert.ok(field, "embed should contain a flight field");
  assert.equal(field.value, "未知");
});

test("omits the average line when no average is available", () => {
  const embed = buildNormalFareEmbed(fare, {
    historicalLowestPriceAmountMinor: 9000,
    thirdLowestPriceAmountMinor: 12000
  });

  const value = priceComparisonField(embed);
  assert.doesNotMatch(value, /平均/);
});
