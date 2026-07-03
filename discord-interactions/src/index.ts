import type { Env } from "./env";
import { handleCommand, type Interaction } from "./handlers";
import { verifyDiscordSignature } from "./verify";

const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;

const RESPONSE_TYPE_PONG = 1;
const RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
const RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const body = await request.text();

    const verified =
      signature !== null &&
      timestamp !== null &&
      (await verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, body));

    if (!verified) {
      return new Response("Invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body) as Interaction;

    if (interaction.type === INTERACTION_TYPE_PING) {
      return jsonResponse({ type: RESPONSE_TYPE_PONG });
    }

    if (interaction.type === INTERACTION_TYPE_APPLICATION_COMMAND) {
      // Discord requires an answer within 3 seconds; defer immediately and
      // resolve the real reply (DB queries, GitHub API) in the background.
      ctx.waitUntil(handleCommand(interaction, env));
      return jsonResponse({ type: RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE });
    }

    return jsonResponse({
      type: RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: "Unsupported interaction type." }
    });
  }
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" }
  });
}
