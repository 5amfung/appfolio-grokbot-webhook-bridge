import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
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

describe("createBridgeTelemetry", () => {
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
      maxExportBatchSize: 1,
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
        upstreamStatus: 200,
        durationMs: 12,
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
      upstreamStatus: 200,
      durationMs: 12,
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
        durationMs: 8,
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

  it("swallows flush and shutdown failures", async () => {
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: () => ({
          flush: async () => {
            throw new Error("posthog down");
          },
          shutdown: async () => {
            throw new Error("posthog down");
          },
        }),
        startLogs: () => ({
          forceFlush: async () => {
            throw new Error("logs down");
          },
          shutdown: async () => {
            throw new Error("logs down");
          },
        }),
      },
    );
    await expect(telemetry.flush()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  it("awaits the other pipeline when one flush or shutdown fails", async () => {
    let logsFlushed = false;
    let analyticsShutDown = false;
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

    await telemetry.flush();
    expect(logsFlushed).toBe(true);
    await telemetry.shutdown();
    expect(analyticsShutDown).toBe(true);
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
        upstreamStatus: 502,
        body: '{"tenant":"Ada"}',
        authorization: "Bearer crsr_live",
        signature: "aaaa.bbbb",
        upstreamUrl: "https://bot.example/hook",
      },
    });
    await telemetry.flush();

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.body).toBe(
      "forwarded [redacted-url] bearer [redacted]",
    );
    expect(record?.attributes).toMatchObject({
      kind: "forwarded",
      upstreamStatus: 502,
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
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
});
