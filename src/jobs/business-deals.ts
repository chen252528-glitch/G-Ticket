import type { DiscordWebhookClient } from "../clients/discord.js";
import type { DealExtractionClient } from "../clients/llm.js";
import type { RssClient } from "../clients/rss.js";
import type { BusinessDealRepository } from "../db/repositories.js";
import { qualifiesBusinessDealForAlert } from "../logic/business-deals.js";
import { buildBusinessDealEmbed, buildErrorFareDealEmbed } from "../notifications/business-deal-embed.js";
import { hashString } from "../utils/hash.js";
import { createStableId } from "../utils/id.js";
import {
  loadExchangeRates,
  updateExchangeRatesIfStale,
  type ExchangeRates,
} from "../config/exchange-rates.js";
import type { RssItem } from "../types/domain.js";

// Non-qualifying deals are kept for dedupe so feed items are not re-sent to the
// LLM on every run; they only need to outlive the item's lifetime in the feed.
const NON_QUALIFYING_DEAL_RETENTION_DAYS = 30;

export interface BusinessDealsJobDeps {
  repository: BusinessDealRepository;
  rssClient: RssClient;
  extractionClient: DealExtractionClient;
  discordClient: DiscordWebhookClient;
  thresholdGbp: number;
  minimumConfidence: number;
  llmModel?: string;
  loadRates?: () => Promise<ExchangeRates>;
}

export async function runBusinessDealsJob(
  deps: BusinessDealsJobDeps,
  feeds: Array<{ url: string; name: string }>
): Promise<void> {
  const exchangeRates = await (deps.loadRates ?? loadFreshExchangeRates)();

  await deps.repository.deleteStaleNonQualifyingDeals(NON_QUALIFYING_DEAL_RETENTION_DAYS);

  for (const feed of feeds) {
    let items;

    try {
      items = await deps.rssClient.fetchFeedItems(feed.url, feed.name);
      console.log(`[jobs] business-deals successfully fetched ${items.length} items from ${feed.name}`);
    } catch (error) {
      console.error(`[jobs] business-deals failed to fetch RSS feed ${feed.name} (${feed.url})`);
      console.error(`[jobs] Error details:`, error);
      // 繼續處理其他 feeds，不要因為一個 feed 失敗就中斷整個 job
      continue;
    }

    for (const item of items) {
      try {
        await processFeedItem(deps, item, exchangeRates);
      } catch (error) {
        // 逐項容錯：單一項目失敗（LLM 解析、Discord 送出等）不阻擋其餘項目
        console.error(`[jobs] business-deals failed to process item "${item.title}" (${item.link})`, error);
      }
    }
  }
}

async function loadFreshExchangeRates(): Promise<ExchangeRates> {
  await updateExchangeRatesIfStale();
  return loadExchangeRates();
}

async function processFeedItem(
  deps: BusinessDealsJobDeps,
  item: RssItem,
  exchangeRates: ExchangeRates
): Promise<void> {
  const sourceLinkHash = hashString(item.link);
  const alreadySeen = await deps.repository.hasSeenDealLink(sourceLinkHash);

  if (alreadySeen) {
    return;
  }

  const parsed = await deps.extractionClient.extractBusinessDeal(item);
  const isErrorFare = parsed.isErrorFare === true;

  const qualifiesForAlert = qualifiesBusinessDealForAlert(
    parsed,
    deps.thresholdGbp,
    deps.minimumConfidence,
    exchangeRates
  );
  let discordMessageId: string | undefined;
  let alertSentAt: string | undefined;

  if (isErrorFare) {
    // Send a red-marked error fare notification separately
    console.log(`[jobs] business-deals detected error fare: ${parsed.origin} -> ${parsed.destination} (${parsed.priceText})`);
    const response = await deps.discordClient.sendEmbed(buildErrorFareDealEmbed(item, parsed));
    discordMessageId = response.messageId;
    alertSentAt = new Date().toISOString();
  } else if (qualifiesForAlert) {
    const response = await deps.discordClient.sendEmbed(buildBusinessDealEmbed(item, parsed));
    discordMessageId = response.messageId;
    alertSentAt = new Date().toISOString();
  }

  await deps.repository.insertParsedDeal({
    id: createStableId("business_deal", sourceLinkHash),
    sourceFeed: item.feedName,
    sourceTitle: item.title,
    sourceSummary: item.summary,
    sourceLink: item.link,
    sourceLinkHash,
    publishedAt: item.publishedAt,
    llmModel: deps.llmModel,
    parsed,
    qualifiesForAlert,
    discordMessageId,
    alertSentAt
  });
}
