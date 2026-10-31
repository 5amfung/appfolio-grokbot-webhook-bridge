/**
 * Optional PostHog client for the AppFolio → Grok Bot webhook bridge.
 *
 * Call `createBridgeTelemetry()` once per isolate. When `POSTHOG_PROJECT_KEY`
 * is unset the result is a complete no-op: no client, no OpenTelemetry
 * provider, no network. Await `flush()` before a serverless invocation
 * returns, and `shutdown()` only when the process is exiting. Both swallow
 * failures and are time-bounded so telemetry cannot change the HTTP status
 * or hang the response to AppFolio.
 *
 * Logs follow the Node.js OpenTelemetry setup (not the browser SDK):
 * https://posthog.com/docs/logs/installation/nodejs
 * The documented logger is `logs` from `@opentelemetry/api-logs`.
 * Analytics init follows https://posthog.com/docs/libraries/node and
 * https://posthog.com/docs/error-tracking/installation/node — exception
 * autocapture stays off until a later change.
 *
 * PRIVACY: payloads are AppFolio property-management data (tenants,
 * addresses, money). Never send the request body, headers, signature,
 * bearer token, upstream URL, or any payload field. Console log
 * autocapture is off for the same reason. Later events may attach only
 * outcome metadata (kind, reason category, status codes, durations,
 * Vercel env/region, commit sha). Every capture uses
 * `POSTHOG_DISTINCT_ID` and `$process_person_profile: false`.
 */
import { logs as otelLogs } from "@opentelemetry/api";
import { logs as documentedLogs } from "@opentelemetry/api-logs";
import type { LoggerProvider as DocumentedLoggerProvider } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PostHog, type EventMessage, type PostHogOptions } from "posthog-node";
import packageJson from "../package.json" with { type: "json" };

/** Fixed, non-personal distinct id. Do not replace this with a tenant or user id. */
export const POSTHOG_DISTINCT_ID = "appfolio-grokbot-webhook-bridge";

/** OTLP `service.name` for logs and, later, metrics. */
export const POSTHOG_SERVICE_NAME = "appfolio-grokbot-webhook-bridge";

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export const DEFAULT_DEPLOYMENT_ENVIRONMENT = "development";

/** Cap ingest waits so a PostHog outage cannot stall the webhook. */
export const POSTHOG_FLUSH_TIMEOUT_MS = 1_000;

const PACKAGE_VERSION = packageJson.version.trim() || "0.0.0";

const SENSITIVE_KEY =
  /body|payload|header|signature|authorization|bearer|token|secret|password|cookie|jws|webhookurl|upstreamurl|rawbody/;

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\bbearer\s+\S+/gi;
const PROJECT_TOKEN_PATTERN = /\b(?:phc|phx|crsr)_[A-Za-z0-9_-]+/gi;
const DETACHED_JWS_PATTERN = /\b[A-Za-z0-9_-]{8,}\.\.[A-Za-z0-9_-]{8,}\b/g;

export type BridgeTelemetry = {
  /** False when `POSTHOG_PROJECT_KEY` is unset or client setup threw. */
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly environment: string;
  readonly serviceVersion: string;
  /**
   * Send queued analytics events and log records. Never throws.
   * Use this before a serverless function returns. Does not disable the client.
   */
  flush(): Promise<void>;
  /**
   * Flush and shut the client down. Never throws.
   * Use this on process exit, not on every request — shutdown disables the client.
   */
  shutdown(): Promise<void>;
};

type AnalyticsClient = {
  flush: () => Promise<void>;
  shutdown: (timeoutMs?: number) => Promise<void>;
};

export type LogExporterOptions = {
  url: string;
  headers: Record<string, string>;
  timeoutMillis: number;
};

export type LogsStartConfig = {
  url: string;
  headers: Record<string, string>;
  timeoutMillis: number;
  resourceAttributes: Record<string, string>;
  /**
   * Must stay false. Console autocapture would ship whatever the process
   * prints, including AppFolio payloads.
   */
  consoleLogAutocapture: boolean;
  maxExportBatchSize: number;
  exportTimeoutMillis: number;
  scheduledDelayMillis: number;
};

type LogsPipeline = {
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

export type BridgeTelemetryDeps = {
  createAnalyticsClient?: (
    apiKey: string,
    options: PostHogOptions,
  ) => AnalyticsClient;
  /**
   * Replaces the OTLP/HTTP exporter. The Node SDK, resource, and batch
   * processor still start. Tests use this to observe records without the network.
   */
  createLogExporter?: (options: LogExporterOptions) => LogRecordExporter;
  startLogs?: (config: LogsStartConfig) => LogsPipeline;
};

export function createBridgeTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  deps: BridgeTelemetryDeps = {},
): BridgeTelemetry {
  const environment = deploymentEnvironment(env);
  const serviceVersion = resolveServiceVersion(env);
  const disabled = disabledTelemetry(environment, serviceVersion);
  const apiKey = env.POSTHOG_PROJECT_KEY?.trim() ?? "";
  if (!apiKey) return disabled;

  const host = normalizeHost(env.POSTHOG_HOST);
  let analytics: AnalyticsClient | undefined;
  let logs: LogsPipeline | undefined;
  try {
    analytics = (deps.createAnalyticsClient ?? defaultCreateAnalytics)(
      apiKey,
      analyticsOptions(host, environment, serviceVersion),
    );
    const logsConfig = logsStartConfig(host, apiKey, environment, serviceVersion);
    logs = deps.startLogs
      ? deps.startLogs(logsConfig)
      : startLogsPipeline(logsConfig, deps.createLogExporter);
  } catch {
    void analytics?.shutdown(POSTHOG_FLUSH_TIMEOUT_MS).then(
      () => undefined,
      () => undefined,
    );
    void logs?.shutdown().then(
      () => undefined,
      () => undefined,
    );
    return disabled;
  }

  return {
    enabled: true,
    serviceName: POSTHOG_SERVICE_NAME,
    environment,
    serviceVersion,
    flush() {
      return settleWithin(
        Promise.all([analytics.flush(), logs.forceFlush()]),
        POSTHOG_FLUSH_TIMEOUT_MS,
      );
    },
    shutdown() {
      return settleWithin(
        Promise.all([
          analytics.shutdown(POSTHOG_FLUSH_TIMEOUT_MS),
          logs.shutdown(),
        ]),
        POSTHOG_FLUSH_TIMEOUT_MS,
      );
    },
  };
}

function disabledTelemetry(
  environment: string,
  serviceVersion: string,
): BridgeTelemetry {
  return {
    enabled: false,
    serviceName: POSTHOG_SERVICE_NAME,
    environment,
    serviceVersion,
    flush: async () => undefined,
    shutdown: async () => undefined,
  };
}

function deploymentEnvironment(env: NodeJS.ProcessEnv): string {
  const value = env.VERCEL_ENV?.trim();
  return value ? value : DEFAULT_DEPLOYMENT_ENVIRONMENT;
}

function resolveServiceVersion(env: NodeJS.ProcessEnv): string {
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim();
  return sha ? sha : PACKAGE_VERSION;
}

function normalizeHost(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_POSTHOG_HOST;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return DEFAULT_POSTHOG_HOST;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return DEFAULT_POSTHOG_HOST;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

function analyticsOptions(
  host: string,
  environment: string,
  serviceVersion: string,
): PostHogOptions {
  return {
    host,
    flushAt: 1,
    flushInterval: 0,
    disableGeoip: true,
    requestTimeout: POSTHOG_FLUSH_TIMEOUT_MS,
    fetchRetryCount: 0,
    preloadFeatureFlags: false,
    before_send: applyEventPrivacy,
    metrics: {
      serviceName: POSTHOG_SERVICE_NAME,
      environment,
      serviceVersion,
    },
  };
}

function logsStartConfig(
  host: string,
  apiKey: string,
  environment: string,
  serviceVersion: string,
): LogsStartConfig {
  return {
    url: `${host}/i/v1/logs`,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMillis: POSTHOG_FLUSH_TIMEOUT_MS,
    resourceAttributes: {
      "service.name": POSTHOG_SERVICE_NAME,
      "service.version": serviceVersion,
      "deployment.environment": environment,
    },
    consoleLogAutocapture: false,
    maxExportBatchSize: 1,
    exportTimeoutMillis: POSTHOG_FLUSH_TIMEOUT_MS,
    scheduledDelayMillis: POSTHOG_FLUSH_TIMEOUT_MS,
  };
}

function defaultCreateAnalytics(
  apiKey: string,
  options: PostHogOptions,
): AnalyticsClient {
  return new PostHog(apiKey, options);
}

function startLogsPipeline(
  config: LogsStartConfig,
  createLogExporter: BridgeTelemetryDeps["createLogExporter"],
): LogsPipeline {
  if (config.consoleLogAutocapture) {
    throw new Error("console log autocapture is disabled");
  }
  const exporter = (createLogExporter ?? defaultCreateLogExporter)({
    url: config.url,
    headers: config.headers,
    timeoutMillis: config.timeoutMillis,
  });
  const batch = new BatchLogRecordProcessor({
    exporter,
    maxExportBatchSize: config.maxExportBatchSize,
    exportTimeoutMillis: config.exportTimeoutMillis,
    scheduledDelayMillis: config.scheduledDelayMillis,
  });
  const processor = new PrivacyLogRecordProcessor(batch);
  // Disable traces, metrics, resource detectors, and instrumentations.
  // NodeSDK would otherwise export them from OTEL_* env defaults, and
  // auto-instrumentation can copy HTTP headers and bodies.
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes(config.resourceAttributes),
    logRecordProcessors: [processor],
    instrumentations: [],
    metricReaders: [],
    spanProcessors: [],
  });
  // Replace any provider left by a previous isolate in this process so the
  // documented `@opentelemetry/api-logs` import sees this pipeline.
  documentedLogs.disable();
  otelLogs.disable();
  sdk.start();
  try {
    documentedLogs.setGlobalLoggerProvider(
      otelLogs.getLoggerProvider() as unknown as DocumentedLoggerProvider,
    );
  } catch (error) {
    void sdk.shutdown();
    documentedLogs.disable();
    otelLogs.disable();
    throw error;
  }
  return {
    forceFlush: () => processor.forceFlush(),
    async shutdown() {
      try {
        await sdk.shutdown();
      } finally {
        documentedLogs.disable();
        otelLogs.disable();
      }
    },
  };
}

function defaultCreateLogExporter(options: LogExporterOptions): LogRecordExporter {
  return new OTLPLogExporter({
    url: options.url,
    headers: options.headers,
    timeoutMillis: options.timeoutMillis,
  });
}

/**
 * Drop payload-shaped properties and force the bridge identity.
 * Runs for every later `capture` / `captureException` on this client.
 */
function applyEventPrivacy(event: EventMessage): EventMessage {
  const properties = sanitizeProperties(event.properties ?? {}, 0);
  properties.$process_person_profile = false;
  return {
    ...event,
    distinctId: POSTHOG_DISTINCT_ID,
    disableGeoip: true,
    properties,
  };
}

class PrivacyLogRecordProcessor implements LogRecordProcessor {
  constructor(private readonly next: LogRecordProcessor) {}

  onEmit(
    record: ReadWriteLogRecord,
    context?: Parameters<LogRecordProcessor["onEmit"]>[1],
  ): void {
    try {
      scrubLogRecord(record);
    } catch {
      return;
    }
    this.next.onEmit(record, context);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

function scrubLogRecord(record: ReadWriteLogRecord): void {
  const attributes = record.attributes as Record<string, unknown>;
  for (const key of Object.keys(attributes)) {
    if (isSensitiveKey(key)) {
      delete attributes[key];
      continue;
    }
    const sanitized = sanitizeValue(attributes[key], 0);
    if (sanitized === undefined) delete attributes[key];
    else attributes[key] = sanitized;
  }
  if (record.body !== undefined) {
    record.setBody(sanitizeValue(record.body, 0) as ReadWriteLogRecord["body"]);
  }
}

function sanitizeProperties(
  properties: Record<string | number, unknown>,
  depth: number,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (isSensitiveKey(key)) continue;
    const next = sanitizeValue(value, depth);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return undefined;
  if (depth >= 4) return "[redacted]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return sanitizeProperties(value as Record<string, unknown>, depth + 1);
  }
  return undefined;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE_KEY.test(normalized);
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "bearer [redacted]")
    .replace(PROJECT_TOKEN_PATTERN, "[redacted]")
    .replace(DETACHED_JWS_PATTERN, "[redacted]")
    .replace(URL_PATTERN, "[redacted-url]");
}

function settleWithin(task: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    task.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
