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

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

it("exports the forwarded payload and separate outbound timing through real HTTP", async () => {
  const payload =
    '{\n  "client_id": "proof-client", "event_id": "proof-event-001",\n  "topic": "work_order_updates", "description": "싱크대 누수",\n  "photo_url": "https://example.test/photo",\n  "details": { "priority": 2, "urgent": true }\n}\n';
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
      "payload.client_id": "proof-client",
      "payload.event_id": "proof-event-001",
      "payload.topic": "work_order_updates",
      "payload.description": "싱크대 누수",
      "payload.photo_url": "https://example.test/photo",
      "payload.details.priority": 2,
      "payload.details.urgent": true,
      environment: "test",
      serviceVersion: "logging-proof",
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
    expect(analyticsText).not.toContain("proof-event-001");
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
