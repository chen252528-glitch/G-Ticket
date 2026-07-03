import type { DiscordEmbed } from "../types/domain.js";

export interface DiscordWebhookClient {
  sendEmbed(embed: DiscordEmbed): Promise<{ messageId?: string }>;
}

export interface DiscordWebhookClientConfig {
  webhookUrl: string;
  fetch?: typeof fetch;
}

interface DiscordWebhookResponse {
  id?: string;
}

/**
 * Build Discord webhook payload directly without validation
 * This matches the approach used in normal-fares which works correctly
 */
export function buildDiscordWebhookPayload(embed: DiscordEmbed): { embeds: DiscordEmbed[] } {
  return { embeds: [embed] };
}

export function createDiscordWebhookClient(config: DiscordWebhookClientConfig): DiscordWebhookClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API is not available for Discord webhook client");
  }

  // wait=true makes Discord return the created message (incl. its id) instead
  // of an empty 204, so discord_message_id can actually be persisted.
  const webhookUrl = appendWaitParameter(config.webhookUrl);

  return {
    async sendEmbed(embed: DiscordEmbed): Promise<{ messageId?: string }> {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(buildDiscordWebhookPayload(embed))
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "No body");
        throw new Error(`Discord webhook request failed with status ${response.status}. Details: ${errorBody}`);
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (!contentType.includes("application/json")) {
        return {};
      }

      const payload = (await response.json()) as DiscordWebhookResponse;
      return {
        messageId: typeof payload.id === "string" ? payload.id : undefined
      };
    }
  };
}

function appendWaitParameter(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  return url.toString();
}
