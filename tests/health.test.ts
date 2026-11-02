import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "../api/health.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
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
  vi.stubEnv("GROK_BOT_WEBHOOK_URL", "https://bot.example/hook");
  vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_test");
}

describe("GET /api/health", () => {
  it("returns 200 { ok: true } when config loads", () => {
    stubReadyConfig();
    const { res, state } = mockRes();
    handler({} as VercelRequest, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true });
  });

  it("returns 200 when the PostHog key is unset", () => {
    stubReadyConfig();
    vi.stubEnv("POSTHOG_PROJECT_KEY", "");
    const { res, state } = mockRes();
    handler({} as VercelRequest, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true });
  });

  it("returns 500 and a config token when the webhook url is missing", () => {
    vi.stubEnv("GROK_BOT_WEBHOOK_URL", "");
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_test");
    const { res, state } = mockRes();
    handler({} as VercelRequest, res);
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({
      ok: false,
      reason: "config_missing_webhook_url",
    });
    expect(JSON.stringify(state.body)).not.toContain("crsr_test");
    expect(JSON.stringify(state.body)).not.toContain("GROK_BOT_WEBHOOK_URL");
  });

  it("returns 500 and config_invalid_url without the bad url", () => {
    vi.stubEnv("GROK_BOT_WEBHOOK_URL", "not a url");
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_test");
    const { res, state } = mockRes();
    handler({} as VercelRequest, res);
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({ ok: false, reason: "config_invalid_url" });
    expect(JSON.stringify(state.body)).not.toContain("not a url");
  });
});
