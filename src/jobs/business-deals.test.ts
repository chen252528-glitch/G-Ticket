import test from "node:test";
import assert from "node:assert/strict";
import type { ExchangeRates } from "../config/exchange-rates.js";
import type { InsertParsedDealArgs } from "../db/repositories.js";
import type { BusinessDealExtraction, DiscordEmbed, RssItem } from "../types/domain.js";
import { runBusinessDealsJob, type BusinessDealsJobDeps } from "./business-deals.js";

const testFeeds = [{ url: "https://example.com/feed.xml", name: "test-feed" }];

const testExchangeRates: ExchangeRates = {
  base: "GBP",
  lastUpdated: "2026-06-01T00:00:00.000Z",
  rates: { USD: 0.8, EUR: 0.85 }
};

function buildItem(overrides: Partial<RssItem> = {}): RssItem {
  return {
    feedName: "test-feed",
    title: "Business class London to Tokyo from £899",
    summary: "Great business class deal",
    link: "https://example.com/deal-1",
    publishedAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

function buildExtraction(overrides: Partial<BusinessDealExtraction> = {}): BusinessDealExtraction {
  return {
    origin: "London",
    destination: "Tokyo",
    priceText: "£899",
    priceAmount: 899,
    currencyCode: "GBP",
    cabinClass: "business",
    isLongHaul: true,
    confidence: 0.95,
    ...overrides
  };
}

interface TestHarness {
  deps: BusinessDealsJobDeps;
  inserted: InsertParsedDealArgs[];
  retentionCalls: number[];
  sentEmbeds: DiscordEmbed[];
  extractionCalls: () => number;
}

function createTestHarness(input: {
  items: RssItem[];
  extract: (item: RssItem) => Promise<BusinessDealExtraction>;
  alreadySeen?: boolean;
}): TestHarness {
  const inserted: InsertParsedDealArgs[] = [];
  const retentionCalls: number[] = [];
  const sentEmbeds: DiscordEmbed[] = [];
  let extractionCallCount = 0;

  const deps: BusinessDealsJobDeps = {
    repository: {
      deleteStaleNonQualifyingDeals: async (retentionDays) => {
        retentionCalls.push(retentionDays);
      },
      hasSeenDealLink: async () => input.alreadySeen ?? false,
      insertParsedDeal: async (args) => {
        inserted.push(args);
      }
    },
    rssClient: {
      fetchFeedItems: async () => input.items
    },
    extractionClient: {
      extractBusinessDeal: async (item) => {
        extractionCallCount += 1;
        return input.extract(item);
      }
    },
    discordClient: {
      sendEmbed: async (embed) => {
        sentEmbeds.push(embed);
        return { messageId: `msg-${sentEmbeds.length}` };
      }
    },
    thresholdGbp: 1000,
    minimumConfidence: 0.8,
    llmModel: "test-model",
    loadRates: async () => testExchangeRates
  };

  return {
    deps,
    inserted,
    retentionCalls,
    sentEmbeds,
    extractionCalls: () => extractionCallCount
  };
}

test("sends a Discord alert and stores the deal when it qualifies", async () => {
  const harness = createTestHarness({
    items: [buildItem()],
    extract: async () => buildExtraction()
  });

  await runBusinessDealsJob(harness.deps, testFeeds);

  assert.equal(harness.sentEmbeds.length, 1);
  assert.match(harness.sentEmbeds[0].title, /^Business class deal/);
  assert.equal(harness.inserted.length, 1);
  assert.equal(harness.inserted[0].qualifiesForAlert, true);
  assert.equal(harness.inserted[0].discordMessageId, "msg-1");
  assert.ok(harness.inserted[0].alertSentAt);
});

test("stores non-qualifying deals without alerting so dedupe keeps working", async () => {
  const harness = createTestHarness({
    items: [buildItem()],
    extract: async () => buildExtraction({ confidence: 0.5 })
  });

  await runBusinessDealsJob(harness.deps, testFeeds);

  assert.equal(harness.sentEmbeds.length, 0);
  assert.equal(harness.inserted.length, 1);
  assert.equal(harness.inserted[0].qualifiesForAlert, false);
  assert.equal(harness.inserted[0].discordMessageId, undefined);
});

test("prunes stale non-qualifying deals with a positive retention window", async () => {
  const harness = createTestHarness({
    items: [],
    extract: async () => buildExtraction()
  });

  await runBusinessDealsJob(harness.deps, testFeeds);

  assert.equal(harness.retentionCalls.length, 1);
  assert.ok(harness.retentionCalls[0] > 0);
});

test("skips already-seen items before calling the LLM", async () => {
  const harness = createTestHarness({
    items: [buildItem()],
    extract: async () => buildExtraction(),
    alreadySeen: true
  });

  await runBusinessDealsJob(harness.deps, testFeeds);

  assert.equal(harness.extractionCalls(), 0);
  assert.equal(harness.sentEmbeds.length, 0);
  assert.equal(harness.inserted.length, 0);
});

test("alerts error fares separately and stores them for dedupe", async () => {
  const harness = createTestHarness({
    items: [buildItem()],
    extract: async () => buildExtraction({ isErrorFare: true })
  });

  await runBusinessDealsJob(harness.deps, testFeeds);

  assert.equal(harness.sentEmbeds.length, 1);
  assert.match(harness.sentEmbeds[0].title, /Error Fare/);
  assert.equal(harness.inserted.length, 1);
  // Error fares do not qualify for the regular alert, but the row must still
  // be stored so the item is not re-alerted on the next run.
  assert.equal(harness.inserted[0].qualifiesForAlert, false);
  assert.ok(harness.inserted[0].alertSentAt);
});

test("continues processing remaining items when one item fails extraction", async () => {
  const failingItem = buildItem({ link: "https://example.com/deal-broken" });
  const workingItem = buildItem({ link: "https://example.com/deal-2", title: "Another deal" });

  const harness = createTestHarness({
    items: [failingItem, workingItem],
    extract: async (item) => {
      if (item.link === failingItem.link) {
        throw new Error("LLM returned malformed JSON");
      }

      return buildExtraction();
    }
  });

  await runBusinessDealsJob(harness.deps, testFeeds);

  assert.equal(harness.extractionCalls(), 2);
  assert.equal(harness.inserted.length, 1);
  assert.equal(harness.inserted[0].sourceLink, workingItem.link);
  assert.equal(harness.sentEmbeds.length, 1);
});
