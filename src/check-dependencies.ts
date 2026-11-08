import type { BridgeConfig } from "./config.js";

type DependencyCheck =
  | { ok: true; status: number }
  | { ok: false; reason: "http_error"; status: number }
  | { ok: false; reason: "timeout" | "network_error" };

const PROBE_TIMEOUT_MS = 5_000;

export async function checkDependencies(
  config: BridgeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  appfolio_jwks: DependencyCheck;
  grok_bot: DependencyCheck;
}> {
  const [appfolio_jwks, grok_bot] = await Promise.all([
    probeUrl(config.appfolioJwksUrl, { method: "GET" }, fetchImpl),
    probeUrl(
      config.grokBotWebhookUrl,
      {
        method: "HEAD",
        headers: { Authorization: `Bearer ${config.grokBotBearerToken}` },
      },
      fetchImpl,
    ),
  ]);
  return { appfolio_jwks, grok_bot };
}

async function probeUrl(
  url: URL,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<DependencyCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetchImpl(url.toString(), {
      ...init,
      signal: controller.signal,
      redirect: "manual",
      cache: "no-store",
    });
    const { status } = response;
    // A POST-only webhook can reject HEAD while still being reachable.
    const ok =
      init.method === "HEAD" ? response.ok || status === 405 : status === 200;
    return ok
      ? { ok: true, status }
      : { ok: false, reason: "http_error", status };
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timeout);
    // Only headers are needed. Abort unread bodies without waiting for them.
    controller.abort();
  }
}
