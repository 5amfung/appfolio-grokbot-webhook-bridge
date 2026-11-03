export const UPSTREAM_FETCH_FAILURES = [
  "timeout",
  "dns",
  "connection_reset",
  "connection_refused",
  "other",
] as const;

export type UpstreamFetchFailure = (typeof UPSTREAM_FETCH_FAILURES)[number];

export type ForwardResult =
  | { ok: true; status: number }
  | { ok: false; error: string; status: number }
  | { ok: false; error: string; failure: UpstreamFetchFailure };

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

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
  try {
    const res = await fetchImpl(webhookUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: rawBody,
    });

    const status = responseStatus(res);
    if (status >= 200 && status < 300) {
      return { ok: true, status };
    }
    return {
      ok: false,
      status,
      error: `upstream returned ${status}`,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "upstream fetch failed";
    return {
      ok: false,
      error: message,
      failure: classifyFetchFailure(err),
    };
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
