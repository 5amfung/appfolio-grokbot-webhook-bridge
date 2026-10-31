import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createRemoteJWKSet } from "jose";
import { loadConfig } from "../../src/config.js";
import { handleAppfolioWebhook } from "../../src/handle-appfolio-webhook.js";
import {
  createBridgeTelemetry,
  type BridgeTelemetry,
} from "../../src/posthog.js";
import { readRawBody } from "../../src/raw-body.js";

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
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const telemetry = bridgeTelemetry();
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.status(405).json({ error: "method not allowed" });
      return;
    }

    let bridgeConfig;
    try {
      bridgeConfig = loadConfig();
    } catch (err) {
      telemetry.captureException(err, "config");
      const message = err instanceof Error ? err.message : "misconfigured";
      res.status(500).json({ error: message });
      return;
    }

    const rawBody = await readRawBody(req);
    const signatureHeader =
      (req.headers["x-jws-signature"] as string | undefined) ?? undefined;

    const outcome = await handleAppfolioWebhook(rawBody, signatureHeader, {
      jwks: getJwks(bridgeConfig.appfolioJwksUrl),
      grokBotWebhookUrl: bridgeConfig.grokBotWebhookUrl,
      grokBotBearerToken: bridgeConfig.grokBotBearerToken,
    });

    switch (outcome.kind) {
      case "unauthorized":
        res.status(401).json({ error: outcome.reason });
        return;
      case "forwarded":
        res.status(200).json({ ok: true, upstreamStatus: outcome.upstreamStatus });
        return;
      case "upstream_failure":
        telemetry.captureException(new Error(outcome.error), "upstream");
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
    await telemetry.flush();
  }
}
