import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "../api/health.js";

const fetchMock = vi.fn<typeof fetch>();
const req = {} as VercelRequest;
const DEFAULT_JWKS_URL = "https://api.appfolio.com/.well-known/jwks.json";
const WEBHOOK_URL = "https://bot.example/hook";

beforeEach(() => {
  stubReadyConfig();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (_url, init) =>
      new Response(null, { status: init?.method === "HEAD" ? 204 : 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockRes() {
  const state: {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as VercelResponse;
  return { res, state };
}

function stubReadyConfig() {
  vi.stubEnv("GROK_BOT_WEBHOOK_URL", WEBHOOK_URL);
  vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_test");
  vi.stubEnv("APPFOLIO_JWKS_URL", undefined);
}

describe("GET /api/health", () => {
  it("returns uncached 200 after safe probes of both configured URLs", async () => {
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true });
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, DEFAULT_JWKS_URL, {
      method: "GET",
      signal: expect.any(AbortSignal),
      redirect: "manual",
      cache: "no-store",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, WEBHOOK_URL, {
      method: "HEAD",
      headers: { Authorization: "Bearer crsr_test" },
      signal: expect.any(AbortSignal),
      redirect: "manual",
      cache: "no-store",
    });
  });

  it("uses the JWKS URL override", async () => {
    vi.stubEnv("APPFOLIO_JWKS_URL", "https://keys.example/jwks");
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://keys.example/jwks",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("accepts a Grok Bot 405 response for a POST-only webhook", async () => {
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Response(null, { status: init?.method === "HEAD" ? 405 : 200 }),
    );
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true });
  });

  it("returns 200 when the PostHog key is unset", async () => {
    vi.stubEnv("POSTHOG_PROJECT_KEY", "");
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true });
  });

  it.each([
    ["appfolio_jwks", 204],
    ["appfolio_jwks", 302],
    ["appfolio_jwks", 404],
    ["appfolio_jwks", 405],
    ["appfolio_jwks", 503],
    ["grok_bot", 302],
    ["grok_bot", 401],
    ["grok_bot", 403],
    ["grok_bot", 404],
    ["grok_bot", 429],
    ["grok_bot", 500],
  ])("returns 503 when %s responds with %s", async (dependency, status) => {
    fetchMock.mockImplementation(async (_url, init) => {
      const isTarget =
        (dependency === "appfolio_jwks") === (init?.method === "GET");
      return new Response(null, { status: isTarget ? status : 200 });
    });
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.body).toEqual({
      ok: false,
      reason: "dependency_unavailable",
      checks: {
        appfolio_jwks:
          dependency === "appfolio_jwks"
            ? { ok: false, reason: "http_error", status }
            : { ok: true, status: 200 },
        grok_bot:
          dependency === "grok_bot"
            ? { ok: false, reason: "http_error", status }
            : { ok: true, status: 200 },
      },
    });
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["appfolio_jwks", "grok_bot"])(
    "reports a %s network failure without exposing secrets or error text",
    async (dependency) => {
      fetchMock.mockImplementation(async (_url, init) => {
        if ((dependency === "appfolio_jwks") === (init?.method === "GET")) {
          throw new Error(`${WEBHOOK_URL} crsr_test private diagnostic`);
        }
        return new Response(null, { status: 200 });
      });
      const { res, state } = mockRes();
      await handler(req, res);
      expect(state.statusCode).toBe(503);
      expect(state.body).toEqual({
        ok: false,
        reason: "dependency_unavailable",
        checks: {
          appfolio_jwks:
            dependency === "appfolio_jwks"
              ? { ok: false, reason: "network_error" }
              : { ok: true, status: 200 },
          grok_bot:
            dependency === "grok_bot"
              ? { ok: false, reason: "network_error" }
              : { ok: true, status: 200 },
        },
      });
      expect(JSON.stringify(state.body)).not.toContain(WEBHOOK_URL);
      expect(JSON.stringify(state.body)).not.toContain("crsr_test");
      expect(JSON.stringify(state.body)).not.toContain("private diagnostic");
    },
  );

  it("starts both probes concurrently and aborts them after five seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("probe aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const { res, state } = mockRes();
    const pending = handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(state.statusCode).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(state.statusCode).toBe(503);
    expect(state.body).toEqual({
      ok: false,
      reason: "dependency_unavailable",
      checks: {
        appfolio_jwks: { ok: false, reason: "timeout" },
        grok_bot: { ok: false, reason: "timeout" },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns 500 and a config token when the webhook url is missing", async () => {
    vi.stubEnv("GROK_BOT_WEBHOOK_URL", "");
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({
      ok: false,
      reason: "config_missing_webhook_url",
    });
    expect(JSON.stringify(state.body)).not.toContain("crsr_test");
    expect(JSON.stringify(state.body)).not.toContain("GROK_BOT_WEBHOOK_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 500 without probing when the bearer token is missing", async () => {
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "");
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({
      ok: false,
      reason: "config_missing_bearer_token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["GROK_BOT_WEBHOOK_URL", "not a url"],
    ["APPFOLIO_JWKS_URL", "not a url"],
    ["GROK_BOT_WEBHOOK_URL", "http://bot.example/hook"],
    ["APPFOLIO_JWKS_URL", "http://keys.example/jwks"],
    ["GROK_BOT_WEBHOOK_URL", "http://127.0.0.1/hook"],
    ["APPFOLIO_JWKS_URL", "http://127.0.0.1/jwks"],
    ["GROK_BOT_WEBHOOK_URL", "data:text/plain,private"],
    ["APPFOLIO_JWKS_URL", "data:application/json,private"],
  ])("rejects invalid %s without exposing %s", async (name, value) => {
    vi.stubEnv(name, value);
    const { res, state } = mockRes();
    await handler(req, res);
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({ ok: false, reason: "config_invalid_url" });
    expect(JSON.stringify(state.body)).not.toContain(value);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
