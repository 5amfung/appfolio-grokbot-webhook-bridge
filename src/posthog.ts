/**
 * Optional PostHog client for the AppFolio → Grok Bot webhook bridge.
 *
 * Call `createBridgeTelemetry()` once per isolate. When `POSTHOG_PROJECT_KEY`
 * is unset the result is a complete no-op: no client, no OpenTelemetry
 * provider, no network. Register `flush()` with Vercel `waitUntil()` on
 * every invocation, and `shutdown()` only when the process is exiting.
 *
 * Logs follow the Node.js OpenTelemetry setup (not the browser SDK):
 * https://posthog.com/docs/logs/installation/nodejs
 * The documented logger is `logs` from `@opentelemetry/api-logs`.
 * Analytics init follows https://posthog.com/docs/libraries/node and
 * https://posthog.com/docs/error-tracking/installation/node. Uncaught
 * exceptions and unhandled rejections are autocaptured. Handled failures
 * go through `captureException` so they still pass `before_send`.
 *
 * Webhook logs include JSON payload fields as `payload.*` attributes.
 * Analytics and exceptions exclude payloads. Transport headers, signatures,
 * bearer tokens, and upstream URLs remain excluded from telemetry.
 * Console log autocapture is off. Every analytics capture uses
 * `POSTHOG_DISTINCT_ID` and `$process_person_profile: false`.
 */
import { logs as otelLogs } from "@opentelemetry/api";
import { logs as documentedLogs } from "@opentelemetry/api-logs";
import type {
  AnyValue,
  LoggerProvider as DocumentedLoggerProvider,
} from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import { PostHog, type EventMessage, type PostHogOptions } from "posthog-node";
import packageJson from "../package.json" with { type: "json" };
import type { ConfigReason } from "./config.js";
import type {
  ResponseCleanupMeasurement,
  UpstreamFetchFailure,
} from "./forward-to-grok-bot.js";
import type { VerifyClassification } from "./verify-appfolio-jws.js";

/** Fixed, non-personal distinct id. Do not replace this with a tenant or user id. */
export const POSTHOG_DISTINCT_ID = "appfolio-grokbot-webhook-bridge";

/** OTLP `service.name` for logs and, later, metrics. */
export const POSTHOG_SERVICE_NAME = "appfolio-grokbot-webhook-bridge";

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export const DEFAULT_DEPLOYMENT_ENVIRONMENT = "development";

export const POSTHOG_FLUSH_TIMEOUT_MS = 2_000;

const PAYLOAD_LOG_MAX_BODY_BYTES = 64 * 1_024;
const PAYLOAD_LOG_MAX_DEPTH = 32;
const PAYLOAD_LOG_MAX_FIELDS = 512;
const PAYLOAD_LOG_MAX_EXPANDED_BYTES = 64 * 1_024;

const PACKAGE_VERSION = packageJson.version.trim() || "0.0.0";

const SENSITIVE_KEY =
  /body|payload|header|signature|authorization|bearer|token|secret|password|cookie|jws|webhookurl|upstreamurl|rawbody/;

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\bbearer\s+\S+/gi;
const PROJECT_TOKEN_PATTERN = /\b(?:phc|phx|crsr)_[A-Za-z0-9_-]+/gi;
const DETACHED_JWS_PATTERN = /\b[A-Za-z0-9_-]{8,}\.\.[A-Za-z0-9_-]{8,}\b/g;

/** Where a handled failure was caught. Not an AppFolio payload field. */
export type ExceptionSource = "config" | "webhook" | "upstream";

export type JwksLookupDiagnostics = {
  durationMs: number;
  cacheFreshAtLookupStart: boolean;
  reloadingAtLookupStart: boolean;
};

/** Request-local diagnostics for the outcome log only, never analytics. */
export type WebhookDiagnostics = {
  handlerElapsedMs: number;
  telemetrySetupDurationMs: number;
  runtimeId: string;
  runtimeRequestNumber: number;
  vercelId?: string;
  vercelRegion?: string;
  inputReadDurationMs?: number;
  verificationDurationMs?: number;
  jwksLookup?: JwksLookupDiagnostics;
  responseCleanup?: ResponseCleanupMeasurement;
};

const WEBHOOK_HANDLED_EVENT = "webhook_handled";

type UnauthorizedHandled = {
  [Family in VerifyClassification["family"]]: {
    kind: "unauthorized";
    durationMs: number;
    family: Family;
    reason: Extract<VerifyClassification, { family: Family }>["failure"];
  };
}[VerifyClassification["family"]];

export type WebhookHandledEvent =
  | {
      kind: "method_not_allowed";
      reason: "method_not_allowed";
      durationMs: number;
    }
  | { kind: "config_failure"; durationMs: number; reason: ConfigReason }
  | { kind: "body_read_failed"; reason: "body_read_failed"; durationMs: number }
  | { kind: "unexpected"; reason: "unexpected"; durationMs: number }
  | UnauthorizedHandled
  | {
      kind: "forwarded";
      reason: "forwarded";
      durationMs: number;
      upstreamStatus: number;
      outboundDurationMs: number;
    }
  | {
      kind: "upstream_failure";
      durationMs: number;
      reason: "upstream_http_error";
      upstreamStatus: number;
      outboundDurationMs: number;
    }
  | {
      kind: "upstream_failure";
      durationMs: number;
      reason: "upstream_fetch_failed";
      failure: UpstreamFetchFailure;
      outboundDurationMs: number;
    };

export type BridgeTelemetry = {
  /** False when `POSTHOG_PROJECT_KEY` is unset or client setup threw. */
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly environment: string;
  readonly serviceVersion: string;
  /**
   * Record a handled failure. Never throws.
   * Adds only `source`. Privacy scrubbing still runs on the exception event.
   */
  captureException(error: unknown, source: ExceptionSource): void;
  /**
   * Queue one `webhook_handled` analytics event and one log record.
   * Only the log includes JSON fields from rawBody as `payload.*` attributes.
   * Optional stage diagnostics and runtime context are also log-only.
   * Never throws and does not flush.
   */
  captureWebhookHandled(
    event: WebhookHandledEvent,
    rawBody?: Uint8Array,
    diagnostics?: WebhookDiagnostics,
  ): void;
  /**
   * Send queued analytics events and log records. Never throws.
   * Register the returned promise with `waitUntil()` before the handler returns.
   * Awaits the real exporters; transport timeouts apply to each export.
   * Does not disable the client.
   */
  flush(): Promise<void>;
  /**
   * Flush and shut the client down. Never throws.
   * Use this on process exit, not on every request — shutdown disables the client.
   */
  shutdown(): Promise<void>;
};

type AnalyticsClient = {
  captureException?: (
    error: unknown,
    distinctId?: string,
    additionalProperties?: Record<string, unknown>,
  ) => void;
  capture?: (event: EventMessage) => void;
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
   * Replaces the OTLP/HTTP exporter. The logger provider, resource, and batch
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
    const logsConfig = logsStartConfig(
      host,
      apiKey,
      environment,
      serviceVersion,
    );
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

  let logsFlushTail = Promise.resolve();

  return {
    enabled: true,
    serviceName: POSTHOG_SERVICE_NAME,
    environment,
    serviceVersion,
    captureException(error, source) {
      try {
        analytics.captureException?.(error, POSTHOG_DISTINCT_ID, { source });
      } catch {
        // Telemetry must not change the HTTP status AppFolio sees.
      }
    },
    captureWebhookHandled(event, rawBody, diagnostics) {
      const properties = {
        ...webhookHandledProperties(event),
        environment,
        service_version: serviceVersion,
      };
      try {
        documentedLogs.getLogger(POSTHOG_SERVICE_NAME, PACKAGE_VERSION).emit({
          severityText: "info",
          body: WEBHOOK_HANDLED_EVENT,
          attributes: {
            ...properties,
            ...webhookDiagnosticProperties(diagnostics),
            ...payloadLogProperties(rawBody),
          },
        });
      } catch {
        // A log export failure must not prevent analytics capture.
      }
      try {
        analytics.capture?.({
          distinctId: POSTHOG_DISTINCT_ID,
          event: WEBHOOK_HANDLED_EVENT,
          properties,
        });
      } catch {
        return undefined;
      }
    },
    flush() {
      // OTel returns early for overlapping forceFlush calls. Each request
      // needs a fresh drain after the preceding export has settled.
      const logsFlush = logsFlushTail.then(() => logs.forceFlush());
      logsFlushTail = logsFlush.catch(() => undefined);
      return settleNamed([
        ["analytics", Promise.resolve().then(() => analytics.flush())],
        ["logs", logsFlush],
      ]);
    },
    shutdown() {
      return settleWithin(
        Promise.allSettled([
          analytics.shutdown(POSTHOG_FLUSH_TIMEOUT_MS),
          logs.shutdown(),
        ]),
        POSTHOG_FLUSH_TIMEOUT_MS,
      );
    },
  };
}

/** Serialize bridge metadata in snake_case for both logs and analytics. */
function webhookHandledProperties(
  event: WebhookHandledEvent,
): Record<string, string | number> {
  switch (event.kind) {
    case "method_not_allowed":
    case "config_failure":
    case "body_read_failed":
    case "unexpected":
      return {
        kind: event.kind,
        reason: event.reason,
        duration_ms: event.durationMs,
      };
    case "unauthorized":
      return {
        kind: event.kind,
        reason: event.reason,
        family: event.family,
        duration_ms: event.durationMs,
      };
    case "forwarded":
      return {
        kind: event.kind,
        reason: event.reason,
        duration_ms: event.durationMs,
        upstream_status: event.upstreamStatus,
        outbound_duration_ms: event.outboundDurationMs,
      };
    case "upstream_failure":
      switch (event.reason) {
        case "upstream_fetch_failed":
          return {
            kind: event.kind,
            reason: event.reason,
            duration_ms: event.durationMs,
            failure: event.failure,
            outbound_duration_ms: event.outboundDurationMs,
          };
        case "upstream_http_error":
          return {
            kind: event.kind,
            reason: event.reason,
            duration_ms: event.durationMs,
            upstream_status: event.upstreamStatus,
            outbound_duration_ms: event.outboundDurationMs,
          };
        default: {
          const unexpected: never = event;
          return unexpected;
        }
      }
    default: {
      const unexpected: never = event;
      return unexpected;
    }
  }
}

/** Keep diagnostics allowlisted, perf-prefixed, and separate from analytics. */
function webhookDiagnosticProperties(
  diagnostics: WebhookDiagnostics | undefined,
): Record<string, string | number | boolean> {
  if (!diagnostics) return {};
  const properties: Record<string, string | number | boolean> = {
    perf_handler_elapsed_ms: diagnostics.handlerElapsedMs,
    perf_telemetry_setup_duration_ms: diagnostics.telemetrySetupDurationMs,
    perf_runtime_id: diagnostics.runtimeId,
    perf_runtime_request_number: diagnostics.runtimeRequestNumber,
  };
  if (diagnostics.vercelId !== undefined) {
    properties.perf_vercel_id = diagnostics.vercelId;
  }
  if (diagnostics.vercelRegion !== undefined) {
    properties.perf_vercel_region = diagnostics.vercelRegion;
  }
  if (diagnostics.inputReadDurationMs !== undefined) {
    properties.perf_input_read_duration_ms = diagnostics.inputReadDurationMs;
  }
  if (diagnostics.verificationDurationMs !== undefined) {
    properties.perf_verification_duration_ms =
      diagnostics.verificationDurationMs;
  }
  if (diagnostics.jwksLookup !== undefined) {
    properties.perf_jwks_lookup_duration_ms = diagnostics.jwksLookup.durationMs;
    properties.perf_jwks_cache_fresh_at_lookup_start =
      diagnostics.jwksLookup.cacheFreshAtLookupStart;
    properties.perf_jwks_reloading_at_lookup_start =
      diagnostics.jwksLookup.reloadingAtLookupStart;
  }
  if (diagnostics.responseCleanup !== undefined) {
    properties.perf_response_cleanup_duration_ms =
      diagnostics.responseCleanup.durationMs;
    properties.perf_response_cleanup_outcome =
      diagnostics.responseCleanup.outcome;
  }
  return properties;
}

/** Bound the logging copy only; verification and forwarding keep the original bytes. */
function payloadLogProperties(
  rawBody: Uint8Array | undefined,
): Record<string, AnyValue> {
  if (rawBody === undefined) return {};
  if (rawBody.byteLength > PAYLOAD_LOG_MAX_BODY_BYTES) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    );
  } catch {
    return { "payload.parse_error": "invalid_json" };
  }

  const properties: Record<string, AnyValue> = {};
  const pending = [{ path: "payload", pathBytes: 7, depth: 0, value: payload }];
  let remainingBytes = PAYLOAD_LOG_MAX_EXPANDED_BYTES - 7;
  let fieldCount = 0;
  for (let field = pending.pop(); field; field = pending.pop()) {
    const { path, pathBytes, depth, value } = field;
    let attributePath = path;
    let attributeValue: AnyValue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      attributeValue = value;
      if (path === "payload") {
        attributePath = "payload.value";
        remainingBytes -= 6;
      }
    } else if (typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 0) {
        if (depth >= PAYLOAD_LOG_MAX_DEPTH) return {};
        for (const [key, child] of entries) {
          const escaped = key.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
          const childPathBytes = pathBytes + 1 + Buffer.byteLength(escaped);
          if (childPathBytes > remainingBytes) return {};
          // Charge every path before constructing it, including containers.
          remainingBytes -= childPathBytes;
          pending.push({
            path: `${path}.${escaped}`,
            pathBytes: childPathBytes,
            depth: depth + 1,
            value: child,
          });
        }
        continue;
      }
      attributeValue = Array.isArray(value) ? [] : {};
    } else {
      continue;
    }
    remainingBytes -= Buffer.byteLength(JSON.stringify(attributeValue));
    if (remainingBytes < 0 || ++fieldCount > PAYLOAD_LOG_MAX_FIELDS) return {};
    properties[attributePath] = attributeValue;
  }
  return properties;
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
    captureException() {
      return undefined;
    },
    captureWebhookHandled() {
      return undefined;
    },
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
    enableExceptionAutocapture: true,
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
    maxExportBatchSize: 64,
    exportTimeoutMillis: POSTHOG_FLUSH_TIMEOUT_MS,
    scheduledDelayMillis: POSTHOG_FLUSH_TIMEOUT_MS,
  };
}

function defaultCreateAnalytics(
  apiKey: string,
  options: PostHogOptions,
): AnalyticsClient {
  return new PostHog(apiKey, options) as unknown as AnalyticsClient;
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
  // Keep bounded payload fields and outcome metadata above the SDK's default
  // 128-attribute limit, with a finite fallback limit for other logger calls.
  const provider = new LoggerProvider({
    resource: resourceFromAttributes(config.resourceAttributes),
    processors: [processor],
    logRecordLimits: { attributeCountLimit: 1_024 },
  });
  // These API versions use separate globals. Both must use this provider.
  documentedLogs.disable();
  otelLogs.disable();
  try {
    otelLogs.setGlobalLoggerProvider(provider);
    documentedLogs.setGlobalLoggerProvider(
      provider as unknown as DocumentedLoggerProvider,
    );
  } catch (error) {
    void provider.shutdown();
    documentedLogs.disable();
    otelLogs.disable();
    throw error;
  }
  return {
    forceFlush: () => processor.forceFlush(),
    async shutdown() {
      try {
        await provider.shutdown();
      } finally {
        documentedLogs.disable();
        otelLogs.disable();
      }
    },
  };
}

function defaultCreateLogExporter(
  options: LogExporterOptions,
): LogRecordExporter {
  return new OTLPLogExporter({
    url: options.url,
    headers: options.headers,
    timeoutMillis: options.timeoutMillis,
  }) as LogRecordExporter;
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
    // Payload fields are explicitly included only on the bridge's webhook log.
    if (
      record.body === WEBHOOK_HANDLED_EVENT &&
      record.instrumentationScope.name === POSTHOG_SERVICE_NAME &&
      (key === "payload" || key.startsWith("payload."))
    ) {
      continue;
    }
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

type FlushClient = "analytics" | "logs";

function settleNamed(
  tasks: Array<[FlushClient, Promise<unknown>]>,
): Promise<void> {
  return Promise.all(
    tasks.map(async ([client, task]) => {
      try {
        await task;
      } catch {
        console.log(`telemetry_flush_failed ${client} rejected`);
      }
    }),
  ).then(() => undefined);
}

function settleWithin(
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
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
