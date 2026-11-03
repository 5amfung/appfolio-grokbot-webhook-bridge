import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { expect, it, vi } from "vitest";
import { handleWebhookRequest } from "../api/webhooks/appfolio.js";
import { createBridgeTelemetry } from "../src/posthog.js";
import appfolioWebhook from "./fixtures/appfolio-work-order-webhook.json" with { type: "json" };

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

it("exports forwarded payloads and bounds unsigned request logs through real HTTP", async () => {
  const payload = JSON.stringify(appfolioWebhook, null, 2) + "\n";
  const rawBody = Buffer.from(payload, "utf8");
  const { publicKey, privateKey } = await generateKeyPair("PS256", {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "PS256",
    use: "sig",
    kid: "logging-proof",
  };
  const compact = await new CompactSign(rawBody)
    .setProtectedHeader({ alg: "PS256", kid: jwk.kid })
    .sign(privateKey);
  const [header, , signature] = compact.split(".");
  const detached = `${header}..${signature}`;
  const ingested: Array<{ path: string; body: string }> = [];
  const errors: unknown[] = [];
  let forwarded: Buffer | undefined;
  let authorization: string | undefined;

  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/jwks") {
        await delay(60);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      const bytes = await readBody(req);
      if (req.url === "/grok") {
        forwarded = bytes;
        authorization = req.headers.authorization;
        await delay(30);
        res.writeHead(204);
        res.end();
        return;
      }
      const body =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(bytes).toString("utf8")
          : bytes.toString("utf8");
      ingested.push({ path: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    })().catch((error: unknown) => {
      errors.push(error);
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const telemetry = createBridgeTelemetry({
    POSTHOG_PROJECT_KEY: "phc_synthetic_logging_proof",
    POSTHOG_HOST: origin,
    VERCEL_ENV: "test",
    VERCEL_GIT_COMMIT_SHA: "logging-proof",
  });

  try {
    expect(telemetry.enabled).toBe(true);
    vi.mocked(waitUntil).mockClear();
    vi.stubEnv("GROK_BOT_WEBHOOK_URL", `${origin}/grok`);
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_synthetic_proof");
    vi.stubEnv("APPFOLIO_JWKS_URL", `${origin}/jwks`);
    const req = Object.assign(Readable.from([rawBody]), {
      method: "POST",
      headers: { "x-jws-signature": detached },
    });
    let statusCode = 0;
    let responseBody: unknown;
    let headersSent = false;
    const res = {
      get headersSent() {
        return headersSent;
      },
      setHeader() {},
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(body: unknown) {
        responseBody = body;
        headersSent = true;
      },
    };

    await handleWebhookRequest(
      req as unknown as VercelRequest,
      res as unknown as VercelResponse,
      telemetry,
    );
    expect(waitUntil).toHaveBeenCalledOnce();
    await vi.mocked(waitUntil).mock.calls[0]?.[0];

    expect(errors).toEqual([]);
    expect(statusCode).toBe(200);
    expect(responseBody).toEqual({ ok: true, upstreamStatus: 204 });
    expect(forwarded).toEqual(rawBody);
    expect(authorization).toBe("Bearer crsr_synthetic_proof");
    const logPosts = ingested.filter((entry) => entry.path === "/i/v1/logs");
    expect(logPosts).toHaveLength(1);
    const log = readLog(logPosts[0]?.body ?? "");
    expect(log.body).toBe("webhook_handled");
    expect(log.attributes).toMatchObject({
      kind: "forwarded",
      reason: "forwarded",
      upstreamStatus: 204,
      environment: "test",
      serviceVersion: "logging-proof",
    });
    expect(
      Object.fromEntries(
        Object.entries(log.attributes).filter(([key]) =>
          key.startsWith("payload."),
        ),
      ),
    ).toEqual({
      "payload.client_id": appfolioWebhook.client_id,
      "payload.event_id": appfolioWebhook.event_id,
      "payload.event_timestamp": appfolioWebhook.event_timestamp,
      "payload.event_type": appfolioWebhook.event_type,
      "payload.message_sent_at": appfolioWebhook.message_sent_at,
      "payload.resource_id": appfolioWebhook.resource_id,
      "payload.topic": appfolioWebhook.topic,
      "payload.database_id": appfolioWebhook.database_id,
    });
    expect(log.attributes).not.toHaveProperty("payload");
    const outboundDurationMs = log.attributes.outboundDurationMs;
    const durationMs = log.attributes.durationMs;
    if (
      typeof outboundDurationMs !== "number" ||
      typeof durationMs !== "number"
    ) {
      throw new Error("expected numeric delivery and total durations");
    }
    expect(outboundDurationMs).toBeGreaterThanOrEqual(20);
    expect(durationMs).toBeGreaterThanOrEqual(outboundDurationMs + 40);
    expect(log.attributes).not.toHaveProperty("authorization");
    expect(log.attributes).not.toHaveProperty("signature");
    expect(JSON.stringify(log)).not.toContain("crsr_synthetic_proof");
    expect(JSON.stringify(log)).not.toContain(detached);

    const analyticsPosts = ingested.filter(
      (entry) => entry.path !== "/i/v1/logs",
    );
    expect(analyticsPosts.length).toBeGreaterThan(0);
    const analyticsText = analyticsPosts.map((entry) => entry.body).join("\n");
    expect(analyticsText).toContain("webhook_handled");
    expect(analyticsText).toContain("outboundDurationMs");
    expect(analyticsText).not.toContain(appfolioWebhook.client_id);
    expect(analyticsText).not.toContain(appfolioWebhook.event_id);
    expect(analyticsText).not.toContain(appfolioWebhook.resource_id);
    expect(analyticsText).not.toContain(appfolioWebhook.database_id);
    expect(analyticsText).not.toContain('"payload.');

    console.log(
      "WEBHOOK_LOGGING_EVIDENCE",
      JSON.stringify({
        body: log.body,
        ...log.attributes,
        forwardedPayloadMatches: forwarded?.equals(rawBody),
        analyticsContainsPayload: analyticsText.includes('"payload.'),
      }),
    );

    const rejectedBody = Buffer.from(
      '{"leaf":0,"child":'.repeat(2_000) + "0" + "}".repeat(2_000),
    );
    expect(rejectedBody.byteLength).toBe(38_001);
    const unsigned = Object.assign(Readable.from([rejectedBody]), {
      method: "POST",
      headers: {},
    });
    statusCode = 0;
    headersSent = false;
    vi.mocked(waitUntil).mockClear();
    await handleWebhookRequest(
      unsigned as unknown as VercelRequest,
      res as unknown as VercelResponse,
      telemetry,
    );
    expect(statusCode).toBe(401);
    expect(waitUntil).toHaveBeenCalledOnce();
    await vi.mocked(waitUntil).mock.calls[0]?.[0];

    const rejectedLogPosts = ingested.filter(
      (entry) => entry.path === "/i/v1/logs",
    );
    expect(rejectedLogPosts).toHaveLength(2);
    const rejectedLogBody = rejectedLogPosts[1]?.body ?? "";
    expect(Buffer.byteLength(rejectedLogBody)).toBeLessThan(2_048);
    expect(readLog(rejectedLogBody).attributes).toEqual({
      kind: "unauthorized",
      family: "bad_signature",
      reason: "missing_signature",
      durationMs: expect.any(Number),
      environment: "test",
      serviceVersion: "logging-proof",
    });
    expect(errors).toEqual([]);
    console.log(
      "BOUNDED_UNSIGNED_LOG_EVIDENCE",
      JSON.stringify({
        requestBytes: rejectedBody.byteLength,
        logBytes: Buffer.byteLength(rejectedLogBody),
        statusCode,
      }),
    );
  } finally {
    vi.unstubAllEnvs();
    await telemetry.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}, 15_000);

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object in the exported OTLP record");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("expected an array in the exported OTLP record");
  }
  return value;
}

function readLog(body: string): {
  body: string;
  attributes: Record<string, string | number | boolean>;
} {
  const parsed: unknown = JSON.parse(body);
  const resourceLogs = object(array(object(parsed).resourceLogs)[0]);
  const scopeLogs = object(array(resourceLogs.scopeLogs)[0]);
  const records = array(scopeLogs.logRecords);
  expect(records).toHaveLength(1);
  const record = object(records[0]);
  const logBody = object(record.body).stringValue;
  if (typeof logBody !== "string")
    throw new Error("expected a string log body");
  const attributes: Record<string, string | number | boolean> = {};
  for (const entry of array(record.attributes)) {
    const attribute = object(entry);
    const value = object(attribute.value);
    if (typeof attribute.key !== "string") {
      throw new Error("expected a string attribute key");
    }
    if (typeof value.stringValue === "string") {
      attributes[attribute.key] = value.stringValue;
    } else if (typeof value.boolValue === "boolean") {
      attributes[attribute.key] = value.boolValue;
    } else if (typeof value.doubleValue === "number") {
      attributes[attribute.key] = value.doubleValue;
    } else if (
      typeof value.intValue === "number" ||
      typeof value.intValue === "string"
    ) {
      attributes[attribute.key] = Number(value.intValue);
    } else {
      throw new Error(`unexpected value for OTLP attribute ${attribute.key}`);
    }
  }
  return { body: logBody, attributes };
}
