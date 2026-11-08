import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { afterAll, expect, it, vi } from "vitest";
import { handleWebhookRequest } from "../api/webhooks/appfolio.js";
import { createBridgeTelemetry, type BridgeTelemetry } from "../src/posthog.js";
import appfolioWebhook from "./fixtures/appfolio-work-order-webhook.json" with { type: "json" };
import {
  localhostTls,
  trustLocalhostCertificate,
} from "./fixtures/localhost-tls.js";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

afterAll(trustLocalhostCertificate());

const DIAGNOSTIC_LOG_ATTRIBUTES = [
  "perf_handler_elapsed_ms",
  "perf_telemetry_setup_duration_ms",
  "perf_input_read_duration_ms",
  "perf_verification_duration_ms",
  "perf_jwks_lookup_duration_ms",
  "perf_jwks_cache_fresh_at_lookup_start",
  "perf_jwks_reloading_at_lookup_start",
  "perf_response_cleanup_duration_ms",
  "perf_response_cleanup_outcome",
  "perf_runtime_id",
  "perf_runtime_request_number",
  "perf_vercel_id",
  "perf_vercel_region",
];

it("exports forwarded payloads and bounds unsigned request logs through real HTTPS", async () => {
  const { rawBody, jwk, detached } =
    await signedSyntheticWebhook("logging-proof");
  const ingested: Array<{ path: string; body: string }> = [];
  const errors: unknown[] = [];
  let forwarded: Buffer | undefined;
  let authorization: string | undefined;

  const server = createServer(localhostTls, (req, res) => {
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
  const origin = `https://127.0.0.1:${address.port}`;
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
    vi.stubEnv("VERCEL_REGION", "iad1");
    const req = Object.assign(Readable.from([rawBody]), {
      method: "POST",
      headers: {
        "x-jws-signature": detached,
        "x-vercel-id": "sfo1::iad1-logging-proof",
      },
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
    for (const key of Object.keys(log.attributes)) {
      if (!key.startsWith("payload.")) {
        expect(key).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      }
    }
    expect(log.attributes).toMatchObject({
      kind: "forwarded",
      reason: "forwarded",
      upstream_status: 204,
      environment: "test",
      service_version: "logging-proof",
      perf_handler_elapsed_ms: expect.any(Number),
      perf_telemetry_setup_duration_ms: expect.any(Number),
      perf_input_read_duration_ms: expect.any(Number),
      perf_verification_duration_ms: expect.any(Number),
      perf_jwks_lookup_duration_ms: expect.any(Number),
      perf_jwks_cache_fresh_at_lookup_start: false,
      perf_jwks_reloading_at_lookup_start: false,
      perf_response_cleanup_duration_ms: expect.any(Number),
      perf_response_cleanup_outcome: "no_body",
      perf_runtime_id: expect.any(String),
      perf_runtime_request_number: expect.any(Number),
      perf_vercel_id: "sfo1::iad1-logging-proof",
      perf_vercel_region: "iad1",
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
    const outboundDurationMs = log.attributes.outbound_duration_ms;
    const durationMs = log.attributes.duration_ms;
    if (
      typeof outboundDurationMs !== "number" ||
      typeof durationMs !== "number"
    ) {
      throw new Error("expected numeric delivery and total durations");
    }
    expect(outboundDurationMs).toBeGreaterThanOrEqual(20);
    expect(durationMs).toBeGreaterThanOrEqual(outboundDurationMs + 40);
    expect(
      numericAttribute(log, "perf_jwks_lookup_duration_ms"),
    ).toBeGreaterThanOrEqual(40);
    expect(
      numericAttribute(log, "perf_verification_duration_ms"),
    ).toBeGreaterThanOrEqual(
      numericAttribute(log, "perf_jwks_lookup_duration_ms"),
    );
    expect(
      numericAttribute(log, "perf_handler_elapsed_ms"),
    ).toBeGreaterThanOrEqual(
      numericAttribute(log, "perf_verification_duration_ms") +
        outboundDurationMs,
    );
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
    expect(analyticsText).toContain("outbound_duration_ms");
    expect(analyticsText).not.toContain(appfolioWebhook.client_id);
    expect(analyticsText).not.toContain(appfolioWebhook.event_id);
    expect(analyticsText).not.toContain(appfolioWebhook.resource_id);
    expect(analyticsText).not.toContain(appfolioWebhook.database_id);
    expect(analyticsText).not.toContain('"payload.');
    for (const attribute of DIAGNOSTIC_LOG_ATTRIBUTES) {
      expect(analyticsText).not.toContain(attribute);
    }

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
      duration_ms: expect.any(Number),
      environment: "test",
      service_version: "logging-proof",
      perf_handler_elapsed_ms: expect.any(Number),
      perf_telemetry_setup_duration_ms: expect.any(Number),
      perf_input_read_duration_ms: expect.any(Number),
      perf_verification_duration_ms: expect.any(Number),
      perf_runtime_id: log.attributes.perf_runtime_id,
      perf_runtime_request_number:
        numericAttribute(log, "perf_runtime_request_number") + 1,
      perf_vercel_region: "iad1",
    });
    expect(errors).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await telemetry.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}, 15_000);

it("exports independent request measurements for shared and cached JWKS lookups", async () => {
  await withSyntheticBridge(async (bridge) => {
    const firstId = "iad1::synthetic-first";
    const secondId = "iad1::synthetic-second";
    const cachedId = "iad1::synthetic-cached";
    const first = bridge.send({ vercelId: firstId });
    await vi.waitFor(() => expect(bridge.jwksFetches()).toBe(1));
    const second = bridge.send({ vercelId: secondId });
    await delay(60);
    expect(bridge.jwksFetches()).toBe(1);
    bridge.releaseJwks();
    expect(await first).toEqual({
      status: 200,
      body: { ok: true, upstreamStatus: 204 },
    });
    expect(await second).toEqual({
      status: 200,
      body: { ok: true, upstreamStatus: 204 },
    });
    expect(await bridge.send({ vercelId: cachedId })).toEqual({
      status: 200,
      body: { ok: true, upstreamStatus: 204 },
    });
    await bridge.finishExports();

    expect(bridge.jwksFetches()).toBe(1);
    expect(bridge.forwardedPaths()).toEqual(["/grok", "/grok", "/grok"]);
    const logs = bridge.logs();
    expect(logs).toHaveLength(3);
    const firstLog = logForRequest(logs, firstId);
    const secondLog = logForRequest(logs, secondId);
    const cachedLog = logForRequest(logs, cachedId);
    expect(firstLog.attributes).toMatchObject({
      perf_jwks_cache_fresh_at_lookup_start: false,
      perf_jwks_reloading_at_lookup_start: false,
    });
    expect(secondLog.attributes).toMatchObject({
      perf_jwks_cache_fresh_at_lookup_start: false,
      perf_jwks_reloading_at_lookup_start: true,
    });
    expect(cachedLog.attributes).toMatchObject({
      perf_jwks_cache_fresh_at_lookup_start: true,
      perf_jwks_reloading_at_lookup_start: false,
    });
    expect(
      numericAttribute(firstLog, "perf_jwks_lookup_duration_ms"),
    ).toBeGreaterThanOrEqual(40);
    expect(
      numericAttribute(secondLog, "perf_jwks_lookup_duration_ms"),
    ).toBeGreaterThanOrEqual(40);
    const firstNumber = numericAttribute(
      firstLog,
      "perf_runtime_request_number",
    );
    for (const [index, log] of [firstLog, secondLog, cachedLog].entries()) {
      expect(log.body).toBe("webhook_handled");
      expect(log.attributes).toMatchObject({
        kind: "forwarded",
        upstream_status: 204,
        perf_response_cleanup_outcome: "no_body",
        perf_runtime_id: firstLog.attributes.perf_runtime_id,
        perf_runtime_request_number: firstNumber + index,
        perf_vercel_region: "iad1",
        "payload.event_id": appfolioWebhook.event_id,
      });
      expect(
        numericAttribute(log, "perf_verification_duration_ms"),
      ).toBeGreaterThanOrEqual(
        numericAttribute(log, "perf_jwks_lookup_duration_ms"),
      );
      expect(
        numericAttribute(log, "outbound_duration_ms"),
      ).toBeGreaterThanOrEqual(20);
      expect(
        numericAttribute(log, "perf_handler_elapsed_ms"),
      ).toBeGreaterThanOrEqual(
        numericAttribute(log, "perf_verification_duration_ms") +
          numericAttribute(log, "outbound_duration_ms") +
          numericAttribute(log, "perf_response_cleanup_duration_ms"),
      );
    }
    expect(firstLog.attributes.perf_runtime_id).toEqual(expect.any(String));
    expect(firstNumber).toBeGreaterThan(0);
    expect(bridge.errors()).toEqual([]);
    expectLogOnlyDiagnostics(bridge.analyticsText());
  });
}, 15_000);

it("exports the stages reached by failed verification, upstream rejection, and accepted stalled bodies", async () => {
  await withSyntheticBridge(async (bridge) => {
    bridge.releaseJwks();
    const verificationId = "iad1::synthetic-jwks-failure";
    const rejectedId = "iad1::synthetic-upstream-503";
    const stalledId = "iad1::synthetic-stalled-200";
    expect(
      await bridge.send({ vercelId: verificationId, jwksPath: "/jwks-failed" }),
    ).toMatchObject({ status: 401 });
    expect(
      await bridge.send({
        vercelId: rejectedId,
        upstreamPath: "/grok-http-error",
      }),
    ).toEqual({
      status: 502,
      body: { error: "upstream returned 503" },
    });
    expect(
      await bridge.send({ vercelId: stalledId, upstreamPath: "/grok-stalled" }),
    ).toEqual({
      status: 200,
      body: { ok: true, upstreamStatus: 200 },
    });
    await bridge.finishExports();

    const logs = bridge.logs();
    expect(logs).toHaveLength(3);
    const verification = logForRequest(logs, verificationId);
    expect(verification.attributes).toMatchObject({
      kind: "unauthorized",
      family: "signing_key",
      reason: "jwks_unavailable",
      perf_verification_duration_ms: expect.any(Number),
      perf_jwks_lookup_duration_ms: expect.any(Number),
      perf_jwks_cache_fresh_at_lookup_start: false,
      perf_jwks_reloading_at_lookup_start: false,
    });
    for (const attribute of [
      "outbound_duration_ms",
      "upstream_status",
      "perf_response_cleanup_duration_ms",
      "perf_response_cleanup_outcome",
    ]) {
      expect(verification.attributes).not.toHaveProperty(attribute);
    }
    expect(
      numericAttribute(verification, "perf_jwks_lookup_duration_ms"),
    ).toBeGreaterThanOrEqual(20);
    const rejected = logForRequest(logs, rejectedId);
    expect(rejected.attributes).toMatchObject({
      kind: "upstream_failure",
      reason: "upstream_http_error",
      upstream_status: 503,
      outbound_duration_ms: expect.any(Number),
      perf_response_cleanup_duration_ms: expect.any(Number),
      perf_response_cleanup_outcome: "drained",
    });
    const stalled = logForRequest(logs, stalledId);
    expect(stalled.attributes).toMatchObject({
      kind: "forwarded",
      reason: "forwarded",
      upstream_status: 200,
      perf_jwks_cache_fresh_at_lookup_start: true,
      perf_response_cleanup_duration_ms: expect.any(Number),
      perf_response_cleanup_outcome: "timeout",
    });
    expect(
      numericAttribute(stalled, "perf_response_cleanup_duration_ms"),
    ).toBeGreaterThanOrEqual(90);
    expect(bridge.forwardedPaths()).toEqual([
      "/grok-http-error",
      "/grok-stalled",
    ]);
    expect(bridge.failedJwksFetches()).toBe(1);
    expect(bridge.jwksFetches()).toBe(1);
    await vi.waitFor(() => expect(bridge.stalledBodyClosed()).toBe(true));
    expect(bridge.errors()).toEqual([]);
    expectLogOnlyDiagnostics(bridge.analyticsText());
  });
}, 15_000);

async function signedSyntheticWebhook(kid: string) {
  const rawBody = Buffer.from(JSON.stringify(appfolioWebhook, null, 2) + "\n");
  const { publicKey, privateKey } = await generateKeyPair("PS256", {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "PS256",
    use: "sig",
    kid,
  };
  const compact = await new CompactSign(rawBody)
    .setProtectedHeader({ alg: "PS256", kid })
    .sign(privateKey);
  const [header, , signature] = compact.split(".");
  return { rawBody, jwk, detached: `${header}..${signature}` };
}

async function withSyntheticBridge(
  run: (bridge: {
    send: (request: {
      vercelId: string;
      jwksPath?: string;
      upstreamPath?: string;
    }) => Promise<{ status: number; body: unknown }>;
    releaseJwks: () => void;
    finishExports: () => Promise<void>;
    logs: () => ExportedLog[];
    analyticsText: () => string;
    jwksFetches: () => number;
    failedJwksFetches: () => number;
    forwardedPaths: () => string[];
    stalledBodyClosed: () => boolean;
    errors: () => unknown[];
  }) => Promise<void>,
): Promise<void> {
  const { rawBody, jwk, detached } = await signedSyntheticWebhook(
    "synthetic-measurements",
  );
  const gate = new EventEmitter();
  let released = false;
  let jwksFetches = 0;
  let failedJwksFetches = 0;
  let stalledBodyClosed = false;
  const forwardedPaths: string[] = [];
  const ingested: Array<{ path: string; body: string }> = [];
  const errors: unknown[] = [];
  const requests: Array<Promise<{ status: number; body: unknown }>> = [];
  const releaseJwks = () => {
    released = true;
    gate.emit("release");
  };
  const server = createServer(localhostTls, (req, res) => {
    void (async () => {
      if (req.url === "/jwks") {
        jwksFetches += 1;
        if (!released) await once(gate, "release");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url === "/jwks-failed") {
        failedJwksFetches += 1;
        await delay(30);
        res.writeHead(503);
        res.end("synthetic key lookup failure");
        return;
      }
      const bytes = await readBody(req);
      if (req.url?.startsWith("/grok")) {
        expect(bytes).toEqual(rawBody);
        forwardedPaths.push(req.url);
        await delay(30);
        if (req.url === "/grok-stalled") {
          res.writeHead(200);
          res.write("synthetic partial body");
          res.once("close", () => {
            stalledBodyClosed = true;
          });
        } else if (req.url === "/grok-http-error") {
          res.writeHead(503);
          res.end("synthetic upstream rejection");
        } else {
          res.writeHead(204);
          res.end();
        }
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
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("expected a synthetic TCP endpoint");
  const origin = `https://127.0.0.1:${address.port}`;
  const telemetry: BridgeTelemetry = createBridgeTelemetry({
    POSTHOG_PROJECT_KEY: "phc_synthetic_measurements",
    POSTHOG_HOST: origin,
    VERCEL_ENV: "test",
    VERCEL_GIT_COMMIT_SHA: "synthetic-measurements",
  });
  const finishExports = async () => {
    expect(waitUntil).toHaveBeenCalledTimes(requests.length);
    await Promise.all(
      vi.mocked(waitUntil).mock.calls.map(([promise]) => promise),
    );
  };
  try {
    expect(telemetry.enabled).toBe(true);
    vi.mocked(waitUntil).mockClear();
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_synthetic_measurements");
    vi.stubEnv("VERCEL_REGION", "iad1");
    await run({
      send({ vercelId, jwksPath = "/jwks", upstreamPath = "/grok" }) {
        vi.stubEnv("APPFOLIO_JWKS_URL", `${origin}${jwksPath}`);
        vi.stubEnv("GROK_BOT_WEBHOOK_URL", `${origin}${upstreamPath}`);
        const req = Object.assign(Readable.from([rawBody]), {
          method: "POST",
          headers: { "x-jws-signature": detached, "x-vercel-id": vercelId },
        });
        let status = 0;
        let body: unknown;
        let headersSent = false;
        const res = {
          get headersSent() {
            return headersSent;
          },
          setHeader() {},
          status(code: number) {
            status = code;
            return res;
          },
          json(value: unknown) {
            body = value;
            headersSent = true;
          },
        };
        const request = handleWebhookRequest(
          req as unknown as VercelRequest,
          res as unknown as VercelResponse,
          telemetry,
        ).then(() => ({ status, body }));
        requests.push(request);
        return request;
      },
      releaseJwks,
      finishExports,
      logs: () =>
        ingested
          .filter(({ path }) => path === "/i/v1/logs")
          .flatMap(({ body }) => readLogs(body)),
      analyticsText: () =>
        ingested
          .filter(({ path }) => path !== "/i/v1/logs")
          .map(({ body }) => body)
          .join("\n"),
      jwksFetches: () => jwksFetches,
      failedJwksFetches: () => failedJwksFetches,
      forwardedPaths: () => forwardedPaths,
      stalledBodyClosed: () => stalledBodyClosed,
      errors: () => errors,
    });
  } finally {
    releaseJwks();
    await Promise.allSettled(requests);
    await Promise.allSettled(
      vi.mocked(waitUntil).mock.calls.map(([promise]) => promise),
    );
    await telemetry.shutdown();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

type ExportedLog = {
  body: string;
  attributes: Record<string, string | number | boolean>;
};

function numericAttribute(log: ExportedLog, key: string): number {
  const value = log.attributes[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected a numeric ${key} OTLP attribute`);
  }
  return value;
}

function logForRequest(logs: ExportedLog[], vercelId: string): ExportedLog {
  const matching = logs.filter(
    (log) => log.attributes.perf_vercel_id === vercelId,
  );
  expect(matching).toHaveLength(1);
  return matching[0];
}

function expectLogOnlyDiagnostics(analyticsText: string): void {
  expect(analyticsText).toContain("webhook_handled");
  expect(analyticsText).toContain("outbound_duration_ms");
  for (const attribute of DIAGNOSTIC_LOG_ATTRIBUTES)
    expect(analyticsText).not.toContain(attribute);
  expect(analyticsText).not.toContain(appfolioWebhook.event_id);
  expect(analyticsText).not.toContain("crsr_synthetic_measurements");
}

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

function readLog(body: string): ExportedLog {
  const logs = readLogs(body);
  expect(logs).toHaveLength(1);
  return logs[0];
}

function readLogs(body: string): ExportedLog[] {
  const parsed: unknown = JSON.parse(body);
  return array(object(parsed).resourceLogs).flatMap((resourceLogs) =>
    array(object(resourceLogs).scopeLogs).flatMap((scopeLogs) =>
      array(object(scopeLogs).logRecords).map(readLogRecord),
    ),
  );
}

function readLogRecord(value: unknown): ExportedLog {
  const record = object(value);
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
import { EventEmitter, once } from "node:events";
