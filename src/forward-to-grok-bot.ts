export type ForwardResult =
  | { ok: true; status: number }
  | { ok: false; error: string; status?: number };

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

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status };
    }
    return {
      ok: false,
      status: res.status,
      error: `upstream returned ${res.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream fetch failed";
    return { ok: false, error: message };
  }
}
