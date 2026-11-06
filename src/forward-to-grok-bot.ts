export const UPSTREAM_FETCH_FAILURES = [
  "timeout",
  "dns",
  "connection_reset",
  "connection_refused",
  "other",
] as const;

export type UpstreamFetchFailure = (typeof UPSTREAM_FETCH_FAILURES)[number];

export type ResponseCleanupMeasurement = {
  durationMs: number;
  outcome: "no_body" | "drained" | "size_limit" | "timeout" | "read_error";
};

export type ForwardResult =
  | {
      ok: true;
      status: number;
      outboundDurationMs: number;
      responseCleanup: ResponseCleanupMeasurement;
    }
  | {
      ok: false;
      error: string;
      status: number;
      outboundDurationMs: number;
      responseCleanup: ResponseCleanupMeasurement;
    }
  | {
      ok: false;
      error: string;
      failure: UpstreamFetchFailure;
      outboundDurationMs: number;
    };

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
const RESPONSE_DRAIN_TIMEOUT_MS = 100;
const RESPONSE_DRAIN_MAX_BYTES = 64 * 1_024;

function responseStatus(res: { readonly status?: number }): number {
  return typeof res.status === "number" ? res.status : 0;
}

/**
 * POST raw body bytes to Grok Bot with Bearer auth.
 * Does not parse or re-stringify the body.
 */
export async function forwardToGrokBot(
  rawBody: Uint8Array,
  webhookUrl: URL | string,
  bearerToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ForwardResult> {
  const started = performance.now();
  const abortController = new AbortController();
  const headersTimeout = setTimeout(() => {
    abortController.abort(
      new DOMException("upstream request timed out", "TimeoutError"),
    );
  }, UPSTREAM_HEADERS_TIMEOUT_MS);
  headersTimeout.unref();
  let res: Response;
  try {
    res = await fetchImpl(webhookUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: rawBody,
      signal: abortController.signal,
    });
  } catch (err) {
    const outboundDurationMs = performance.now() - started;
    const message =
      err instanceof Error ? err.message : "upstream fetch failed";
    return {
      ok: false,
      error: message,
      failure: classifyFetchFailure(err),
      outboundDurationMs,
    };
  } finally {
    clearTimeout(headersTimeout);
  }

  const headersReceived = performance.now();
  const outboundDurationMs = headersReceived - started;
  const status = responseStatus(res);
  // A received HTTP status owns the delivery outcome. Body cleanup must never
  // turn an accepted webhook into a failure that invites duplicate delivery.
  let cleanupOutcome: ResponseCleanupMeasurement["outcome"];
  try {
    cleanupOutcome = await discardResponseBody(res, abortController);
  } catch {
    abortController.abort();
    cleanupOutcome = "read_error";
  }
  const responseCleanup: ResponseCleanupMeasurement = {
    durationMs: performance.now() - headersReceived,
    outcome: cleanupOutcome,
  };
  if (status >= 200 && status < 300) {
    return { ok: true, status, outboundDurationMs, responseCleanup };
  }
  return {
    ok: false,
    status,
    error: `upstream returned ${status}`,
    outboundDurationMs,
    responseCleanup,
  };
}

/** Drain small responses for connection reuse, without retaining their bytes. */
async function discardResponseBody(
  res: Response,
  abortController: AbortController,
): Promise<ResponseCleanupMeasurement["outcome"]> {
  const reader = res.body?.getReader();
  if (!reader) return "no_body";

  type CancellationOutcome = Exclude<
    ResponseCleanupMeasurement["outcome"],
    "no_body" | "drained"
  >;
  let cancellationOutcome: CancellationOutcome | undefined;
  const cancel = (outcome: CancellationOutcome) => {
    cancellationOutcome ??= outcome;
    abortController.abort();
    // Cancel closes pending reads even if the underlying cancellation promise
    // never settles. Do not await that promise or let rejection escape.
    void reader.cancel().catch(() => undefined);
  };
  const drainTimeout = setTimeout(
    () => cancel("timeout"),
    RESPONSE_DRAIN_TIMEOUT_MS,
  );
  drainTimeout.unref();
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return cancellationOutcome ?? "drained";
      receivedBytes += value.byteLength;
      if (receivedBytes > RESPONSE_DRAIN_MAX_BYTES) {
        cancel("size_limit");
        return "size_limit";
      }
    }
  } catch {
    cancel("read_error");
    return cancellationOutcome ?? "read_error";
  } finally {
    clearTimeout(drainTimeout);
    reader.releaseLock();
  }
}

function classifyFetchFailure(err: unknown): UpstreamFetchFailure {
  const codes = new Set<string>();
  const names = new Set<string>();
  let current: unknown = err;
  for (let depth = 0; depth < 6 && isRecord(current); depth += 1) {
    if (typeof current.code === "string") codes.add(current.code);
    if (typeof current.name === "string") names.add(current.name);
    current = current.cause;
  }
  for (const code of codes) {
    if (TIMEOUT_CODES.has(code)) return "timeout";
    if (DNS_CODES.has(code)) return "dns";
    if (code === "ECONNRESET") return "connection_reset";
    if (code === "ECONNREFUSED") return "connection_refused";
  }
  if (names.has("TimeoutError")) return "timeout";
  return "other";
}

function isRecord(
  value: unknown,
): value is { code?: unknown; name?: unknown; cause?: unknown } {
  return typeof value === "object" && value !== null;
}
