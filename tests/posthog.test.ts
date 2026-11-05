import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import type { PostHogOptions } from "posthog-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import {
  DEFAULT_DEPLOYMENT_ENVIRONMENT,
  DEFAULT_POSTHOG_HOST,
  POSTHOG_DISTINCT_ID,
  POSTHOG_FLUSH_TIMEOUT_MS,
  POSTHOG_SERVICE_NAME,
  createBridgeTelemetry,
  type BridgeTelemetry,
  type BridgeTelemetryDeps,
  type LogExporterOptions,
} from "../src/posthog.js";
import appfolioWebhook from "./fixtures/appfolio-work-order-webhook.json" with { type: "json" };

const started: BridgeTelemetry[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const telemetry = started.pop();
    if (telemetry) await telemetry.shutdown();
  }
});

function track(telemetry: BridgeTelemetry): BridgeTelemetry {
  started.push(telemetry);
  return telemetry;
}

async function stop(telemetry: BridgeTelemetry): Promise<void> {
  const index = started.lastIndexOf(telemetry);
  if (index >= 0) started.splice(index, 1);
  await telemetry.shutdown();
}

describe("createBridgeTelemetry", () => {
  it("keeps the exporter timeout budget at most two seconds", () => {
    expect(POSTHOG_FLUSH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(POSTHOG_FLUSH_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it("is a no-op when POSTHOG_PROJECT_KEY is unset, empty, or whitespace", async () => {
    const createAnalyticsClient = vi.fn();
    const startLogs = vi.fn();
    for (const env of [
      {},
      { POSTHOG_PROJECT_KEY: "" },
      { POSTHOG_PROJECT_KEY: "   " },
      { POSTHOG_API_KEY: "phc_not_read" },
    ]) {
      const telemetry = createBridgeTelemetry(env, {
        createAnalyticsClient,
        startLogs,
      });
      expect(telemetry.enabled).toBe(false);
      expect(telemetry.serviceName).toBe(POSTHOG_SERVICE_NAME);
      telemetry.captureException(new Error("unused"), "config");
      telemetry.captureWebhookHandled({
        kind: "method_not_allowed",
        reason: "method_not_allowed",
        durationMs: 1,
      });
      await telemetry.flush();
      await telemetry.shutdown();
    }
    expect(createAnalyticsClient).not.toHaveBeenCalled();
    expect(startLogs).not.toHaveBeenCalled();
  });

  it("configures analytics and logs without console autocapture", () => {
    const createAnalyticsClient = vi.fn<
      NonNullable<BridgeTelemetryDeps["createAnalyticsClient"]>
    >(() => ({
      flush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    }));
    const startLogs = vi.fn<NonNullable<BridgeTelemetryDeps["startLogs"]>>(
      () => ({
        forceFlush: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => undefined),
      }),
    );

    const telemetry = createBridgeTelemetry(
      {
        POSTHOG_PROJECT_KEY: "  phc_test  ",
        VERCEL_ENV: " preview ",
        VERCEL_GIT_COMMIT_SHA: " abc123 ",
      },
      { createAnalyticsClient, startLogs },
    );

    expect(telemetry.enabled).toBe(true);
    expect(telemetry.environment).toBe("preview");
    expect(telemetry.serviceVersion).toBe("abc123");
    expect(createAnalyticsClient).toHaveBeenCalledOnce();
    const [apiKey, options] = createAnalyticsClient.mock.calls[0];
    expect(apiKey).toBe("phc_test");
    expect(options).toMatchObject({
      host: DEFAULT_POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
      disableGeoip: true,
      requestTimeout: POSTHOG_FLUSH_TIMEOUT_MS,
      fetchRetryCount: 0,
      preloadFeatureFlags: false,
      metrics: {
        serviceName: POSTHOG_SERVICE_NAME,
        environment: "preview",
        serviceVersion: "abc123",
      },
    });
    expect(options.enableExceptionAutocapture).toBe(true);

    expect(startLogs).toHaveBeenCalledOnce();
    expect(startLogs.mock.calls[0]?.[0]).toEqual({
      url: `${DEFAULT_POSTHOG_HOST}/i/v1/logs`,
      headers: { Authorization: "Bearer phc_test" },
      timeoutMillis: POSTHOG_FLUSH_TIMEOUT_MS,
      resourceAttributes: {
        "service.name": POSTHOG_SERVICE_NAME,
        "service.version": "abc123",
        "deployment.environment": "preview",
      },
      consoleLogAutocapture: false,
      maxExportBatchSize: 64,
      exportTimeoutMillis: POSTHOG_FLUSH_TIMEOUT_MS,
      scheduledDelayMillis: POSTHOG_FLUSH_TIMEOUT_MS,
    });
    const logsConfig = startLogs.mock.calls[0]?.[0];
    expect(logsConfig?.url).not.toContain("phc_test");
    expect(JSON.stringify(logsConfig?.resourceAttributes)).not.toContain(
      "phc_test",
    );
  });

  it("uses POSTHOG_HOST when set, and falls back when it is not a URL", () => {
    const createAnalyticsClient = vi.fn<
      NonNullable<BridgeTelemetryDeps["createAnalyticsClient"]>
    >(() => ({
      flush: async () => undefined,
      shutdown: async () => undefined,
    }));
    const startLogs = vi.fn<NonNullable<BridgeTelemetryDeps["startLogs"]>>(
      () => ({
        forceFlush: async () => undefined,
        shutdown: async () => undefined,
      }),
    );
    const deps = { createAnalyticsClient, startLogs };

    createBridgeTelemetry(
      {
        POSTHOG_PROJECT_KEY: "phc_test",
        POSTHOG_HOST: "https://eu.i.posthog.com/",
      },
      deps,
    );
    expect(createAnalyticsClient.mock.calls[0]?.[1]).toMatchObject({
      host: "https://eu.i.posthog.com",
    });
    expect(startLogs.mock.calls[0]?.[0]).toMatchObject({
      url: "https://eu.i.posthog.com/i/v1/logs",
    });

    createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test", POSTHOG_HOST: "not a host" },
      deps,
    );
    expect(createAnalyticsClient.mock.calls[1]?.[1]).toMatchObject({
      host: DEFAULT_POSTHOG_HOST,
    });
  });

  it("defaults environment and service version when Vercel metadata is absent", () => {
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          flush: async () => undefined,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    expect(telemetry.environment).toBe(DEFAULT_DEPLOYMENT_ENVIRONMENT);
    expect(telemetry.serviceVersion).toBe(packageJson.version);
  });

  it("forces the bridge distinct id and strips payload, header, and secret fields", () => {
    let options: PostHogOptions | undefined;
    createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: (_apiKey, received) => {
          options = received;
          return {
            flush: async () => undefined,
            shutdown: async () => undefined,
          };
        },
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    const beforeSend = options?.before_send;
    expect(typeof beforeSend).toBe("function");
    if (typeof beforeSend !== "function") return;

    const event = beforeSend({
      event: "webhook_handled",
      distinctId: "tenant-42",
      properties: {
        kind: "forwarded",
        upstream_status: 200,
        outbound_duration_ms: 0.5,
        duration_ms: 12,
        reason: "verify failed https://bot.example/hook bearer crsr_secret",
        $process_person_profile: true,
        body: '{"tenant":"Ada","address":"1 Main"}',
        headers: { authorization: "Bearer crsr_x" },
        signature: "header..signature",
        bearerToken: "crsr_x",
        upstreamUrl: "https://bot.example/hook",
        rawBody: new Uint8Array([1, 2, 3]),
      },
    });

    expect(event?.distinctId).toBe(POSTHOG_DISTINCT_ID);
    expect(event?.disableGeoip).toBe(true);
    expect(event?.properties).toMatchObject({
      kind: "forwarded",
      upstream_status: 200,
      outbound_duration_ms: 0.5,
      duration_ms: 12,
      $process_person_profile: false,
      reason: "verify failed [redacted-url] bearer [redacted]",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("Ada");
    expect(serialized).not.toContain("crsr_");
    expect(serialized).not.toContain("bot.example");
    expect(serialized).not.toContain("header..signature");
    expect(serialized).not.toContain("Bearer");

    const exceptionEvent = beforeSend({
      event: "$exception",
      distinctId: "tenant-42",
      properties: {
        source: "upstream",
        $exception_message:
          "fetch failed https://bot.example/hook bearer crsr_secret",
        $exception_list: [
          {
            type: "Error",
            value: "fetch failed https://bot.example/hook",
          },
        ],
      },
    });
    expect(exceptionEvent?.distinctId).toBe(POSTHOG_DISTINCT_ID);
    expect(exceptionEvent?.properties).toMatchObject({
      source: "upstream",
      $exception_message: "fetch failed [redacted-url] bearer [redacted]",
      $exception_list: [
        { type: "Error", value: "fetch failed [redacted-url]" },
      ],
    });
    expect(JSON.stringify(exceptionEvent)).not.toContain("bot.example");
    expect(JSON.stringify(exceptionEvent)).not.toContain("crsr_");
  });

  it("sends handled exceptions to the analytics client and ignores client throws", () => {
    const captureException = vi.fn();
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          captureException,
          flush: async () => undefined,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    const error = new Error("upstream returned 502");
    telemetry.captureException(error, "upstream");
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(error, POSTHOG_DISTINCT_ID, {
      source: "upstream",
    });

    const throwing = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          captureException() {
            throw new Error("posthog down");
          },
          flush: async () => undefined,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    expect(() => throwing.captureException(error, "webhook")).not.toThrow();
  });

  it("captures webhook_handled with the fixed distinct id and the reason token", () => {
    const capture = vi.fn();
    const flush = vi.fn(async () => undefined);
    const sampleUrl = "https://bot.example/hook";
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          capture,
          flush,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    const event = {
      kind: "unauthorized" as const,
      durationMs: 8,
      family: "bad_signature" as const,
      reason: "signature_invalid" as const,
      error: sampleUrl,
    };
    telemetry.captureWebhookHandled(event);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith({
      event: "webhook_handled",
      distinctId: POSTHOG_DISTINCT_ID,
      properties: {
        kind: "unauthorized",
        reason: "signature_invalid",
        family: "bad_signature",
        duration_ms: 8,
        environment: DEFAULT_DEPLOYMENT_ENVIRONMENT,
        service_version: packageJson.version,
      },
    });
    expect(JSON.stringify(capture.mock.calls)).toContain("signature_invalid");
    expect(JSON.stringify(capture.mock.calls)).not.toContain(sampleUrl);
    expect(flush).not.toHaveBeenCalled();

    const disabledCapture = vi.fn();
    const disabled = createBridgeTelemetry(
      {},
      {
        createAnalyticsClient: () => ({
          capture: disabledCapture,
          flush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    expect(() => disabled.captureWebhookHandled(event)).not.toThrow();
    expect(disabledCapture).not.toHaveBeenCalled();

    const missingCapture = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          flush: async () => undefined,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    expect(() => missingCapture.captureWebhookHandled(event)).not.toThrow();

    const throwing = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          capture() {
            throw new Error("posthog down");
          },
          flush: async () => undefined,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    expect(() => throwing.captureWebhookHandled(event)).not.toThrow();
  });

  it("stamps deployment environment and service version on webhook_handled", () => {
    const capture = vi.fn();
    const telemetry = createBridgeTelemetry(
      {
        POSTHOG_PROJECT_KEY: "phc_test",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_SHA: "abc123",
      },
      {
        createAnalyticsClient: () => ({
          capture,
          flush: async () => undefined,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    telemetry.captureWebhookHandled({
      kind: "forwarded",
      reason: "forwarded",
      durationMs: 3,
      upstreamStatus: 204,
      outboundDurationMs: 0.5,
    });
    expect(capture).toHaveBeenCalledWith({
      event: "webhook_handled",
      distinctId: POSTHOG_DISTINCT_ID,
      properties: {
        kind: "forwarded",
        reason: "forwarded",
        duration_ms: 3,
        upstream_status: 204,
        outbound_duration_ms: 0.5,
        environment: "production",
        service_version: "abc123",
      },
    });
    telemetry.captureWebhookHandled({
      kind: "upstream_failure",
      reason: "upstream_fetch_failed",
      durationMs: 4,
      failure: "dns",
      outboundDurationMs: 0.5,
    });
    expect(capture).toHaveBeenLastCalledWith({
      event: "webhook_handled",
      distinctId: POSTHOG_DISTINCT_ID,
      properties: {
        kind: "upstream_failure",
        reason: "upstream_fetch_failed",
        duration_ms: 4,
        failure: "dns",
        outbound_duration_ms: 0.5,
        environment: "production",
        service_version: "abc123",
      },
    });
  });

  it("swallows flush and shutdown failures", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          flush: async () => {
            throw new Error("posthog down https://us.i.posthog.com/batch");
          },
          shutdown: async () => {
            throw new Error("posthog down https://us.i.posthog.com/batch");
          },
        }),
        startLogs: () => ({
          forceFlush: async () => {
            throw new Error("logs down https://us.i.posthog.com/i/v1/logs");
          },
          shutdown: async () => {
            throw new Error("logs down https://us.i.posthog.com/i/v1/logs");
          },
        }),
      },
    );
    try {
      await expect(telemetry.flush()).resolves.toBeUndefined();
      expect(log.mock.calls.map((call) => call[0]).sort()).toEqual([
        "telemetry_flush_failed analytics rejected",
        "telemetry_flush_failed logs rejected",
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("posthog.com");
      expect(JSON.stringify(log.mock.calls)).not.toContain("posthog down");
      expect(JSON.stringify(log.mock.calls)).not.toContain("logs down");
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it("awaits both real flush promises even after the transport timeout budget", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let finishAnalytics!: () => void;
    let finishLogs!: () => void;
    const analyticsFlush = new Promise<void>((resolve) => {
      finishAnalytics = resolve;
    });
    const logsFlush = new Promise<void>((resolve) => {
      finishLogs = resolve;
    });
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          flush: () => analyticsFlush,
          shutdown: async () => undefined,
        }),
        startLogs: () => ({
          forceFlush: () => logsFlush,
          shutdown: async () => undefined,
        }),
      },
    );
    try {
      let settled = false;
      const pending = telemetry.flush().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(POSTHOG_FLUSH_TIMEOUT_MS + 1);
      expect(settled).toBe(false);
      finishAnalytics();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      finishLogs();
      await pending;
      expect(settled).toBe(true);
      expect(log).not.toHaveBeenCalled();
    } finally {
      finishAnalytics();
      finishLogs();
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it("awaits the other pipeline when one flush or shutdown fails", async () => {
    let logsFlushed = false;
    let analyticsShutDown = false;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          flush: async () => {
            throw new Error("posthog down");
          },
          shutdown: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                analyticsShutDown = true;
                resolve();
              }, 40);
            }),
        }),
        startLogs: () => ({
          forceFlush: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                logsFlushed = true;
                resolve();
              }, 40);
            }),
          shutdown: async () => {
            throw new Error("logs down");
          },
        }),
      },
    );

    try {
      await telemetry.flush();
      expect(logsFlushed).toBe(true);
      expect(log.mock.calls.map((call) => call[0])).toEqual([
        "telemetry_flush_failed analytics rejected",
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("posthog down");
      await telemetry.shutdown();
      expect(analyticsShutDown).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("returns a no-op when client setup throws", async () => {
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => {
          throw new Error("bad key");
        },
        startLogs: vi.fn(),
      },
    );
    expect(telemetry.enabled).toBe(false);
    await telemetry.flush();
  });

  it("exports scrubbed logs on the documented logger with service identity", async () => {
    const records: ReadableLogRecord[] = [];
    const seen: LogExporterOptions[] = [];
    const consoleLog = console.log;
    const telemetry = track(
      createBridgeTelemetry(
        {
          POSTHOG_PROJECT_KEY: "phc_test_project",
          VERCEL_ENV: "production",
          VERCEL_GIT_COMMIT_SHA: "deadbeef",
        },
        {
          createLogExporter(options) {
            seen.push(options);
            const exporter: LogRecordExporter = {
              export(batch, resultCallback) {
                records.push(...batch);
                resultCallback({ code: ExportResultCode.SUCCESS });
              },
              shutdown: async () => undefined,
              forceFlush: async () => undefined,
            };
            return exporter;
          },
        },
      ),
    );

    expect(telemetry.enabled).toBe(true);
    expect(console.log).toBe(consoleLog);
    expect(seen[0]).toEqual({
      url: `${DEFAULT_POSTHOG_HOST}/i/v1/logs`,
      headers: { Authorization: "Bearer phc_test_project" },
      timeoutMillis: POSTHOG_FLUSH_TIMEOUT_MS,
    });
    expect(seen[0]?.url).not.toContain("phc_test_project");

    logs.getLogger(POSTHOG_SERVICE_NAME).emit({
      severityText: "info",
      body: "forwarded https://bot.example/hook bearer crsr_live",
      attributes: {
        kind: "forwarded",
        upstream_status: 502,
        outbound_duration_ms: 0.5,
        body: '{"tenant":"Ada"}',
        authorization: "Bearer crsr_live",
        signature: "aaaa.bbbb",
        upstreamUrl: "https://bot.example/hook",
      },
    });
    await telemetry.flush();

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.body).toBe("forwarded [redacted-url] bearer [redacted]");
    expect(record?.attributes).toMatchObject({
      kind: "forwarded",
      upstream_status: 502,
      outbound_duration_ms: 0.5,
    });
    expect(record?.attributes).not.toHaveProperty("body");
    expect(record?.attributes).not.toHaveProperty("authorization");
    expect(record?.attributes).not.toHaveProperty("signature");
    expect(record?.attributes).not.toHaveProperty("upstreamUrl");
    expect(record?.resource.attributes).toMatchObject({
      "service.name": POSTHOG_SERVICE_NAME,
      "service.version": "deadbeef",
      "deployment.environment": "production",
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("Ada");
    expect(serialized).not.toContain("crsr_");
    expect(serialized).not.toContain("bot.example");
    expect(console.log).toBe(consoleLog);
  });

  it("shuts down the default client without patching console or sending", async () => {
    const consoleLog = console.log;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const telemetry = track(
      createBridgeTelemetry({ POSTHOG_PROJECT_KEY: "phc_test_project" }),
    );
    try {
      expect(telemetry.enabled).toBe(true);
      expect(telemetry.environment).toBe(DEFAULT_DEPLOYMENT_ENVIRONMENT);
      expect(console.log).toBe(consoleLog);
      await telemetry.flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "the AppFolio event envelope",
      payload: appfolioWebhook,
      payloadProperties: {
        "payload.client_id": appfolioWebhook.client_id,
        "payload.event_id": appfolioWebhook.event_id,
        "payload.event_timestamp": appfolioWebhook.event_timestamp,
        "payload.event_type": appfolioWebhook.event_type,
        "payload.message_sent_at": appfolioWebhook.message_sent_at,
        "payload.resource_id": appfolioWebhook.resource_id,
        "payload.topic": appfolioWebhook.topic,
        "payload.database_id": appfolioWebhook.database_id,
      },
    },
    {
      name: "synthetic JSON values",
      payload: {
        string_value: "synthetic",
        number_value: 42,
        nested: { enabled: true },
        array_value: [{ url: "https://example.test/asset" }],
        nullable_value: null,
        empty_array: [],
        "nested.enabled": false,
      },
      payloadProperties: {
        "payload.string_value": "synthetic",
        "payload.number_value": 42,
        "payload.nested.enabled": true,
        "payload.array_value.0.url": "https://example.test/asset",
        "payload.nullable_value": null,
        "payload.empty_array": [],
        "payload.nested\\.enabled": false,
      },
    },
  ])(
    "exports $name without adding payload fields to analytics",
    async ({ payload, payloadProperties }) => {
      const records: ReadableLogRecord[] = [];
      const capture = vi.fn();
      const telemetry = track(
        createBridgeTelemetry(
          { POSTHOG_PROJECT_KEY: "phc_test_project" },
          {
            createAnalyticsClient: () => ({
              capture,
              flush: async () => undefined,
              shutdown: async () => undefined,
            }),
            createLogExporter: () => ({
              export(batch, callback) {
                records.push(...batch);
                callback({ code: ExportResultCode.SUCCESS });
              },
              shutdown: async () => undefined,
              forceFlush: async () => undefined,
            }),
          },
        ),
      );
      telemetry.captureWebhookHandled(
        {
          kind: "forwarded",
          reason: "forwarded",
          durationMs: 12,
          upstreamStatus: 200,
          outboundDurationMs: 8.5,
        },
        new TextEncoder().encode(JSON.stringify(payload)),
      );
      await telemetry.flush();

      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toEqual({
        kind: "forwarded",
        reason: "forwarded",
        duration_ms: 12,
        upstream_status: 200,
        outbound_duration_ms: 8.5,
        environment: DEFAULT_DEPLOYMENT_ENVIRONMENT,
        service_version: packageJson.version,
        ...payloadProperties,
      });
      expect(records[0]?.droppedAttributesCount).toBe(0);
      expect(records[0]?.attributes).not.toHaveProperty("payload");
      expect(capture).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]?.[0].properties).toEqual({
        kind: "forwarded",
        reason: "forwarded",
        duration_ms: 12,
        upstream_status: 200,
        outbound_duration_ms: 8.5,
        environment: DEFAULT_DEPLOYMENT_ENVIRONMENT,
        service_version: packageJson.version,
      });
    },
  );

  it.each([
    ["raw UTF-8 bytes", JSON.stringify({ value: "\u20AC".repeat(22_000) }), 0],
    ["body at 64 KiB", "0".padEnd(64 * 1_024), 1],
    ["body above 64 KiB", "0".padEnd(64 * 1_024 + 1), 0],
    ["depth at 32", '{"child":'.repeat(32) + "true" + "}".repeat(32), 1],
    ["depth above 32", '{"child":'.repeat(33) + "true" + "}".repeat(33), 0],
    [
      "field count at 512",
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 512 }, (_, index) => [`field${index}`, index]),
        ),
      ),
      512,
    ],
    [
      "field count",
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 513 }, (_, index) => [`field${index}`, index]),
        ),
      ),
      0,
    ],
    [
      "repeated paths",
      JSON.stringify({
        ["x".repeat(1_024)]: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`field${index}`, index]),
        ),
        safe: "discard this too",
      }),
      0,
    ],
    [
      "multibyte paths",
      JSON.stringify({
        ["\u20AC".repeat(128)]: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [`field${index}`, index]),
        ),
      }),
      0,
    ],
    [
      "escaped paths",
      JSON.stringify({
        ["\\".repeat(256)]: Object.fromEntries(
          Array.from({ length: 130 }, (_, index) => [`field${index}`, index]),
        ),
      }),
      0,
    ],
    [
      "combined paths and values",
      JSON.stringify({
        ["x".repeat(4_096)]: {
          first: "a".repeat(28_500),
          second: "b".repeat(28_500),
        },
      }),
      0,
    ],
    [
      "root value at expanded byte limit",
      JSON.stringify("a".repeat(65_521)),
      1,
    ],
    [
      "root value above expanded byte limit",
      JSON.stringify("a".repeat(65_522)),
      0,
    ],
  ])("bounds payload logging for %s", async (_limit, body, expectedFields) => {
    const records: ReadableLogRecord[] = [];
    const capture = vi.fn();
    const telemetry = track(
      createBridgeTelemetry(
        { POSTHOG_PROJECT_KEY: "phc_test_project" },
        {
          createAnalyticsClient: () => ({
            capture,
            flush: async () => undefined,
            shutdown: async () => undefined,
          }),
          createLogExporter: () => ({
            export(batch, callback) {
              records.push(...batch);
              callback({ code: ExportResultCode.SUCCESS });
            },
            shutdown: async () => undefined,
            forceFlush: async () => undefined,
          }),
        },
      ),
    );
    telemetry.captureWebhookHandled(
      {
        kind: "unauthorized",
        family: "bad_signature",
        reason: "missing_signature",
        durationMs: 1,
      },
      new TextEncoder().encode(body),
    );
    await telemetry.flush();

    expect(records).toHaveLength(1);
    const outcome = {
      kind: "unauthorized",
      family: "bad_signature",
      reason: "missing_signature",
      duration_ms: 1,
      environment: DEFAULT_DEPLOYMENT_ENVIRONMENT,
      service_version: packageJson.version,
    };
    expect(records[0]?.attributes).toMatchObject(outcome);
    expect(
      Object.keys(records[0]?.attributes ?? {}).filter(
        (key) => key === "payload" || key.startsWith("payload."),
      ),
    ).toHaveLength(expectedFields);
    expect(records[0]?.droppedAttributesCount).toBe(0);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0].properties).toEqual(outcome);
  });

  it.each([new TextEncoder().encode("not json"), new Uint8Array([0xff])])(
    "keeps the outcome log when its payload cannot be parsed",
    async (rawBody) => {
      const records: ReadableLogRecord[] = [];
      const telemetry = track(
        createBridgeTelemetry(
          { POSTHOG_PROJECT_KEY: "phc_test_project" },
          {
            createAnalyticsClient: () => ({
              flush: async () => undefined,
              shutdown: async () => undefined,
            }),
            createLogExporter: () => ({
              export(batch, callback) {
                records.push(...batch);
                callback({ code: ExportResultCode.SUCCESS });
              },
              shutdown: async () => undefined,
              forceFlush: async () => undefined,
            }),
          },
        ),
      );
      telemetry.captureWebhookHandled(
        {
          kind: "unauthorized",
          family: "bad_signature",
          reason: "missing_signature",
          durationMs: 1,
        },
        rawBody,
      );
      await telemetry.flush();

      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        kind: "unauthorized",
        "payload.parse_error": "invalid_json",
      });
      expect(records[0]?.attributes).not.toHaveProperty("outbound_duration_ms");
    },
  );

  it("posts one scrubbed webhook log from captureWebhookHandled", async () => {
    const tenantPayload = '{"tenant":"AdaTenant991","address":"1 Main St"}';
    const ingest = await startIngest(0);
    const consoleLog = console.log;
    const telemetry = track(
      createBridgeTelemetry({
        POSTHOG_PROJECT_KEY: "phc_test_project",
        POSTHOG_HOST: ingest.origin,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_SHA: "deadbeef",
      }),
    );
    expect(console.log).toBe(consoleLog);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      telemetry.captureWebhookHandled({
        kind: "forwarded",
        reason: "forwarded",
        durationMs: 12,
        upstreamStatus: 200,
        outboundDurationMs: 0.5,
      });
      await telemetry.flush();
      const posts = ingest.seen.filter((entry) => entry.url === "/i/v1/logs");
      expect(posts).toHaveLength(1);
      const post = posts[0];
      expect(post?.responded).toBe(true);
      expect(log.mock.calls.map((call) => call[0])).toEqual([]);
      const record = otlpLogRecord(post?.body ?? "");
      expect(record.scopeName).toBe(POSTHOG_SERVICE_NAME);
      expect(record.scopeVersion).toBe(packageJson.version);
      expect(record.body).toBe("webhook_handled");
      expect(record.attributes).toEqual({
        kind: "forwarded",
        reason: "forwarded",
        duration_ms: 12,
        upstream_status: 200,
        outbound_duration_ms: 0.5,
        environment: "production",
        service_version: "deadbeef",
      });
      expect(record.resource).toMatchObject({
        "service.name": POSTHOG_SERVICE_NAME,
        "service.version": "deadbeef",
        "deployment.environment": "production",
      });
      expect(post?.body).not.toContain(tenantPayload);
      expect(post?.body).not.toContain("AdaTenant991");
      expect(post?.body).not.toContain("phc_");
      expect(post?.body).not.toContain("Bearer");
      expect(post?.body).not.toContain("authorization");
    } finally {
      log.mockRestore();
      await stop(telemetry);
      await ingest.close();
    }
  });

  it("finishes slow analytics and logs exports before flush returns", async () => {
    const ingest = await startIngest(1_500);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const telemetry = track(
      createBridgeTelemetry({
        POSTHOG_PROJECT_KEY: "phc_test_project",
        POSTHOG_HOST: ingest.origin,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_SHA: "deadbeef",
      }),
    );
    try {
      telemetry.captureWebhookHandled({
        kind: "forwarded",
        reason: "forwarded",
        durationMs: 12,
        upstreamStatus: 200,
        outboundDurationMs: 0.5,
      });
      await telemetry.flush();
      const analyticsPosts = ingest.seen.filter(
        (entry) => entry.url === "/batch/",
      );
      expect(analyticsPosts).toHaveLength(1);
      expect(analyticsPosts[0]?.responded).toBe(true);
      expect(analyticsPosts[0]?.socketDestroyedBeforeResponse).toBe(false);
      const analyticsBody = JSON.parse(analyticsPosts[0]?.body ?? "{}");
      expect(analyticsBody.batch).toHaveLength(1);
      expect(analyticsBody.batch[0]).toMatchObject({
        event: "webhook_handled",
        distinct_id: POSTHOG_DISTINCT_ID,
        properties: {
          kind: "forwarded",
          reason: "forwarded",
          upstream_status: 200,
          outbound_duration_ms: 0.5,
          duration_ms: 12,
          environment: "production",
          service_version: "deadbeef",
          $process_person_profile: false,
        },
      });
      const posts = ingest.seen.filter((entry) => entry.url === "/i/v1/logs");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.responded).toBe(true);
      expect(posts[0]?.socketDestroyedBeforeResponse).toBe(false);
      expect(log.mock.calls.map((call) => call[0])).toEqual([]);
      expect(otlpLogRecord(posts[0]?.body ?? "").attributes).toMatchObject({
        kind: "forwarded",
        environment: "production",
        service_version: "deadbeef",
      });
    } finally {
      log.mockRestore();
      await stop(telemetry);
      await ingest.close();
    }
  }, 20_000);
});

type IngestRequest = {
  url: string;
  body: string;
  responded: boolean;
  socketDestroyedBeforeResponse: boolean;
};

async function startIngest(delayMs: number): Promise<{
  origin: string;
  seen: IngestRequest[];
  close: () => Promise<void>;
}> {
  const seen: IngestRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const encoding = req.headers["content-encoding"];
      const body =
        encoding === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8");
      const entry: IngestRequest = {
        url: req.url ?? "",
        body,
        responded: false,
        socketDestroyedBeforeResponse: false,
      };
      seen.push(entry);
      setTimeout(() => {
        entry.socketDestroyedBeforeResponse = req.socket.destroyed;
        if (req.socket.destroyed || res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        entry.responded = true;
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("expected a tcp port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function otlpLogRecord(body: string): {
  scopeName: string;
  scopeVersion: string;
  body: string;
  attributes: Record<string, string | number>;
  resource: Record<string, string>;
} {
  const parsed = JSON.parse(body) as {
    resourceLogs: Array<{
      resource: {
        attributes: Array<{ key: string; value: { stringValue?: string } }>;
      };
      scopeLogs: Array<{
        scope?: { name?: string; version?: string };
        logRecords: Array<{
          body?: { stringValue?: string };
          attributes?: Array<{
            key: string;
            value: {
              stringValue?: string;
              intValue?: number | string;
              doubleValue?: number;
            };
          }>;
        }>;
      }>;
    }>;
  };
  const resourceLogs = parsed.resourceLogs[0];
  const scopeLogs = resourceLogs?.scopeLogs[0];
  const record = scopeLogs?.logRecords[0];
  if (!resourceLogs || !scopeLogs || !record) {
    throw new Error("expected one OTLP log record");
  }
  const attributes: Record<string, string | number> = {};
  for (const attribute of record.attributes ?? []) {
    if (attribute.value.stringValue !== undefined) {
      attributes[attribute.key] = attribute.value.stringValue;
      continue;
    }
    if (attribute.value.intValue !== undefined) {
      attributes[attribute.key] = Number(attribute.value.intValue);
    }
    if (attribute.value.doubleValue !== undefined) {
      attributes[attribute.key] = attribute.value.doubleValue;
    }
  }
  const resource: Record<string, string> = {};
  for (const attribute of resourceLogs.resource.attributes) {
    if (attribute.value.stringValue !== undefined) {
      resource[attribute.key] = attribute.value.stringValue;
    }
  }
  return {
    scopeName: scopeLogs.scope?.name ?? "",
    scopeVersion: scopeLogs.scope?.version ?? "",
    body: record.body?.stringValue ?? "",
    attributes,
    resource,
  };
}
