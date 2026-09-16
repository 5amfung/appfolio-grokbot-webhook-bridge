import type { AppfolioJwks } from "./verify-appfolio-jws.js";
import { verifyAppfolioJws } from "./verify-appfolio-jws.js";
import { forwardToGrokBot } from "./forward-to-grok-bot.js";

export type HandlerOutcome =
  | { kind: "unauthorized"; reason: string }
  | { kind: "forwarded"; upstreamStatus: number }
  | { kind: "upstream_failure"; error: string };

export type HandleDeps = {
  jwks: AppfolioJwks;
  grokBotWebhookUrl: URL | string;
  grokBotBearerToken: string;
  fetchImpl?: typeof fetch;
};

/**
 * Verify detached JWS then forward the same raw bytes to Grok Bot.
 */
export async function handleAppfolioWebhook(
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  deps: HandleDeps,
): Promise<HandlerOutcome> {
  const verified = await verifyAppfolioJws(
    rawBody,
    signatureHeader ?? "",
    deps.jwks,
  );
  if (!verified.ok) {
    return { kind: "unauthorized", reason: verified.reason };
  }

  const forwarded = await forwardToGrokBot(
    rawBody,
    deps.grokBotWebhookUrl,
    deps.grokBotBearerToken,
    deps.fetchImpl ?? fetch,
  );

  if (forwarded.ok) {
    return { kind: "forwarded", upstreamStatus: forwarded.status };
  }
  return { kind: "upstream_failure", error: forwarded.error };
}
