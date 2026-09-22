import test from "node:test";
import assert from "node:assert/strict";
import type { TrackedDestination } from "../types/domain.js";

import { buildSerpApiUrl, createSerpApiClient, getSerpApiSearchProblem, redactSerpApiKey } from "./serpapi.js";

const API_KEY = "secret-key-123";

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

test("buildSerpApiUrl carries the travel dates, trip type and market", () => {
  const url = new URL(buildSerpApiUrl(buildDestination(), { apiKey: API_KEY }));

  assert.equal(url.searchParams.get("outbound_date"), "2026-12-26");
  assert.equal(url.searchParams.get("return_date"), "2027-01-10");
  assert.equal(url.searchParams.get("type"), "1");
  assert.equal(url.searchParams.get("currency"), "JPY");
  assert.equal(url.searchParams.get("gl"), "jp");
  assert.equal(url.searchParams.get("hl"), "ja");
});

test("getSerpApiSearchProblem flags routes google_flights would reject", () => {
  assert.equal(getSerpApiSearchProblem(buildDestination()), undefined);
  assert.equal(getSerpApiSearchProblem(buildDestination({ tripType: "one_way", returnDateFrom: undefined })), undefined);
  assert.match(getSerpApiSearchProblem(buildDestination({ departureDateFrom: undefined })) ?? "", /no departure date/);
  assert.match(getSerpApiSearchProblem(buildDestination({ returnDateFrom: undefined })) ?? "", /no return date/);
  assert.match(getSerpApiSearchProblem(buildDestination({ departureDateFrom: "26/12/2026" })) ?? "", /invalid departure date/);
});

test("searchFlights refuses a dateless route without calling SerpApi", async () => {
  let calls = 0;
  const client = createSerpApiClient({
    apiKey: API_KEY,
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }
  });

  await assert.rejects(client.searchFlights(buildDestination({ departureDateFrom: undefined })), /no departure date/);
  assert.equal(calls, 0);
});

test("searchFlights error messages never include the API key", async () => {
  const client = createSerpApiClient({
    apiKey: API_KEY,
    fetch: async () => new Response("bad request", { status: 400 })
  });

  await assert.rejects(client.searchFlights(buildDestination()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /status 400/);
    assert.ok(!error.message.includes(API_KEY));
    assert.ok(error.message.includes("api_key=<redacted>"));
    return true;
  });
});

test("redactSerpApiKey masks the key wherever it appears", () => {
  assert.equal(
    redactSerpApiKey("https://serpapi.com/search.json?engine=google_flights&api_key=abc123&departure_id=HND"),
    "https://serpapi.com/search.json?engine=google_flights&api_key=<redacted>&departure_id=HND"
  );
});
