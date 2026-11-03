import type {
  AppfolioJwks,
  VerifyClassification,
} from "./verify-appfolio-jws.js";
import { verifyAppfolioJws } from "./verify-appfolio-jws.js";
import {
  forwardToGrokBot,
  type UpstreamFetchFailure,
} from "./forward-to-grok-bot.js";

export type HandlerOutcome =
  | {
      kind: "unauthorized";
      reason: string;
      classification: VerifyClassification;
    }
  | { kind: "forwarded"; upstreamStatus: number; outboundDurationMs: number }
  | {
      kind: "upstream_failure";
      error: string;
      upstreamStatus: number;
      outboundDurationMs: number;
    }
  | {
      kind: "upstream_failure";
      error: string;
      failure: UpstreamFetchFailure;
      outboundDurationMs: number;
    };

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
    return {
      kind: "unauthorized",
      reason: verified.reason,
      classification: verified.classification,
    };
  }

  const forwarded = await forwardToGrokBot(
    rawBody,
    deps.grokBotWebhookUrl,
    deps.grokBotBearerToken,
    deps.fetchImpl ?? fetch,
  );

  if (forwarded.ok) {
    return {
      kind: "forwarded",
      upstreamStatus: forwarded.status,
      outboundDurationMs: forwarded.outboundDurationMs,
    };
  }
  if ("status" in forwarded) {
    return {
      kind: "upstream_failure",
      error: forwarded.error,
      upstreamStatus: forwarded.status,
      outboundDurationMs: forwarded.outboundDurationMs,
    };
  }
  return {
    kind: "upstream_failure",
    error: forwarded.error,
    failure: forwarded.failure,
    outboundDurationMs: forwarded.outboundDurationMs,
  };
}
