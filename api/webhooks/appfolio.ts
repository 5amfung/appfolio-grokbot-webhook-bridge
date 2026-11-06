import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { createRemoteJWKSet } from "jose";
import {
  classifyConfigError,
  loadConfig,
  type ConfigReason,
} from "../../src/config.js";
import type { UpstreamFetchFailure } from "../../src/forward-to-grok-bot.js";
import { handleAppfolioWebhook } from "../../src/handle-appfolio-webhook.js";
import {
  createBridgeTelemetry,
  type BridgeTelemetry,
  type WebhookDiagnostics,
  type WebhookHandledEvent,
} from "../../src/posthog.js";
import { readRawBody } from "../../src/raw-body.js";
import type { VerifyClassification } from "../../src/verify-appfolio-jws.js";

/**
 * Disable Vercel JSON body parsing so we receive exact AppFolio bytes
 * for detached JWS verify and for the upstream forward.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksUrl: string | undefined;
let telemetry: BridgeTelemetry | undefined;
// These identify this loaded route module, not a Vercel physical instance.
const runtimeId = randomUUID();
let runtimeRequestCount = 0;

type WebhookRequestTelemetry = Pick<
  BridgeTelemetry,
  "captureException" | "captureWebhookHandled" | "flush"
>;

type PendingWebhook =
  | { kind: "method_not_allowed" }
  | { kind: "config_failure"; reason: ConfigReason }
  | { kind: "body_read_failed" }
  | { kind: "unexpected" }
  | { kind: "unauthorized"; classification: VerifyClassification }
  | { kind: "forwarded"; upstreamStatus: number; outboundDurationMs: number }
  | {
      kind: "upstream_failure";
      upstreamStatus: number;
      outboundDurationMs: number;
    }
  | {
      kind: "upstream_failure";
      failure: UpstreamFetchFailure;
      outboundDurationMs: number;
    };

function bridgeTelemetry(): BridgeTelemetry {
  telemetry ??= createBridgeTelemetry();
  return telemetry;
}

function getJwks(jwksUrl: URL) {
  const href = jwksUrl.href;
  if (!cachedJwks || cachedJwksUrl !== href) {
    cachedJwks = createRemoteJWKSet(jwksUrl);
    cachedJwksUrl = href;
  }
  return cachedJwks;
}

/**
 * POST /api/webhooks/appfolio
 * Verify AppFolio X-JWS-Signature (PS256 detached), then forward raw body
 * to GROK_BOT_WEBHOOK_URL with Bearer token.
 *
 * Status: verify fail → 401; upstream 2xx → 200; upstream fail → 502.
 */
export default function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  return handleWebhookRequest(req, res);
}

export async function handleWebhookRequest(
  req: VercelRequest,
  res: VercelResponse,
  providedTelemetry?: WebhookRequestTelemetry,
): Promise<void> {
  const entered = performance.now();
  const runtimeRequestNumber = ++runtimeRequestCount;
  const telemetrySetupStarted = performance.now();
  const telemetry = providedTelemetry ?? bridgeTelemetry();
  const telemetrySetupDurationMs = performance.now() - telemetrySetupStarted;
  // Preserve the existing timer's boundary after lazy telemetry construction.
  const started = Date.now();
  const vercelId = allowedVercelId(req.headers["x-vercel-id"]);
  const vercelRegion = process.env.VERCEL_REGION;
  const diagnostics: Omit<WebhookDiagnostics, "handlerElapsedMs"> = {
    telemetrySetupDurationMs,
    runtimeId,
    runtimeRequestNumber,
    ...(vercelId ? { vercelId } : {}),
    ...(vercelRegion ? { vercelRegion } : {}),
  };
  let pending: PendingWebhook = { kind: "unexpected" };
  let rawBody: Uint8Array | undefined;
  try {
    if (req.method !== "POST") {
      pending = { kind: "method_not_allowed" };
      res.setHeader("Allow", "POST");
      res.status(405).json({ error: "method not allowed" });
      return;
    }

    let bridgeConfig;
    try {
      bridgeConfig = loadConfig();
    } catch (err) {
      const classified = classifyConfigError(err);
      pending = { kind: "config_failure", reason: classified.reason };
      telemetry.captureException(err, "config");
      res.status(500).json({ error: classified.message });
      return;
    }

    const inputReadStarted = performance.now();
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      pending = { kind: "body_read_failed" };
      throw err;
    } finally {
      diagnostics.inputReadDurationMs = performance.now() - inputReadStarted;
    }

    const signatureHeader =
      (req.headers["x-jws-signature"] as string | undefined) ?? undefined;

    const jwks = getJwks(bridgeConfig.appfolioJwksUrl);
    const outcome = await handleAppfolioWebhook(rawBody, signatureHeader, {
      jwks: async (...args: Parameters<typeof jwks>) => {
        const lookupStarted = performance.now();
        const cacheFreshAtLookupStart = jwks.fresh;
        const reloadingAtLookupStart = jwks.reloading;
        try {
          return await jwks(...args);
        } finally {
          diagnostics.jwksLookup = {
            durationMs: performance.now() - lookupStarted,
            cacheFreshAtLookupStart,
            reloadingAtLookupStart,
          };
        }
      },
      grokBotWebhookUrl: bridgeConfig.grokBotWebhookUrl,
      grokBotBearerToken: bridgeConfig.grokBotBearerToken,
    });
    diagnostics.verificationDurationMs = outcome.verificationDurationMs;
    if ("responseCleanup" in outcome) {
      diagnostics.responseCleanup = outcome.responseCleanup;
    }

    switch (outcome.kind) {
      case "unauthorized":
        pending = {
          kind: "unauthorized",
          classification: outcome.classification,
        };
        res.status(401).json({ error: outcome.reason });
        return;
      case "forwarded":
        pending = {
          kind: "forwarded",
          upstreamStatus: outcome.upstreamStatus,
          outboundDurationMs: outcome.outboundDurationMs,
        };
        res.status(200).json({
          ok: true,
          upstreamStatus: outcome.upstreamStatus,
        });
        return;
      case "upstream_failure":
        pending =
          "upstreamStatus" in outcome
            ? {
                kind: "upstream_failure",
                upstreamStatus: outcome.upstreamStatus,
                outboundDurationMs: outcome.outboundDurationMs,
              }
            : {
                kind: "upstream_failure",
                failure: outcome.failure,
                outboundDurationMs: outcome.outboundDurationMs,
              };
        res.status(502).json({ error: outcome.error });
        return;
      default: {
        const unexpected: never = outcome;
        throw unexpected;
      }
    }
  } catch (err) {
    telemetry.captureException(err, "webhook");
    if (!res.headersSent) {
      res.status(500).json({ error: "internal error" });
    }
  } finally {
    telemetry.captureWebhookHandled(toHandledEvent(pending, started), rawBody, {
      ...diagnostics,
      handlerElapsedMs: performance.now() - entered,
    });
    waitUntil(telemetry.flush());
  }
}

function allowedVercelId(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9:._-]{1,256}$/.test(value)
    ? value
    : undefined;
}

function toHandledEvent(
  pending: PendingWebhook,
  started: number,
): WebhookHandledEvent {
  const durationMs = Math.max(0, Date.now() - started);
  switch (pending.kind) {
    case "method_not_allowed":
      return {
        kind: "method_not_allowed",
        reason: "method_not_allowed",
        durationMs,
      };
    case "config_failure":
      return { kind: "config_failure", reason: pending.reason, durationMs };
    case "body_read_failed":
      return {
        kind: "body_read_failed",
        reason: "body_read_failed",
        durationMs,
      };
    case "unexpected":
      return { kind: "unexpected", reason: "unexpected", durationMs };
    case "unauthorized":
      return unauthorizedEvent(pending.classification, durationMs);
    case "forwarded":
      return {
        kind: "forwarded",
        reason: "forwarded",
        durationMs,
        upstreamStatus: pending.upstreamStatus,
        outboundDurationMs: pending.outboundDurationMs,
      };
    case "upstream_failure":
      if ("upstreamStatus" in pending) {
        return {
          kind: "upstream_failure",
          reason: "upstream_http_error",
          durationMs,
          upstreamStatus: pending.upstreamStatus,
          outboundDurationMs: pending.outboundDurationMs,
        };
      }
      return {
        kind: "upstream_failure",
        reason: "upstream_fetch_failed",
        durationMs,
        failure: pending.failure,
        outboundDurationMs: pending.outboundDurationMs,
      };
    default: {
      const unexpected: never = pending;
      return unexpected;
    }
  }
}

function unauthorizedEvent(
  classification: VerifyClassification,
  durationMs: number,
): Extract<WebhookHandledEvent, { kind: "unauthorized" }> {
  switch (classification.family) {
    case "signing_key":
      return {
        kind: "unauthorized",
        durationMs,
        family: classification.family,
        reason: classification.failure,
      };
    case "bad_signature":
      return {
        kind: "unauthorized",
        durationMs,
        family: classification.family,
        reason: classification.failure,
      };
    case "unclassified":
      return {
        kind: "unauthorized",
        durationMs,
        family: classification.family,
        reason: classification.failure,
      };
    default: {
      const unexpected: never = classification;
      return unexpected;
    }
  }
}
