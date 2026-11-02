import { describe, expect, it, vi } from "vitest";
import { forwardToGrokBot } from "../src/forward-to-grok-bot.js";

describe("forwardToGrokBot", () => {
  const body = new TextEncoder().encode('{"event_id":"1"}');
  const url = "https://bot.example/hooks/inbound";
  const token = "crsr_test";

  it("POSTs raw bytes with Bearer auth and returns ok on 2xx", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${token}`,
        );
        expect(init?.body).toBe(body);
        return new Response(null, { status: 204 });
      },
    ) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({ ok: true, status: 204 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns failure when upstream is non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "upstream returned 503",
    });
  });

  it("returns failure when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({
      ok: false,
      error: "network down",
      failure: "other",
    });
  });

  it.each([
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNRESET", "connection_reset"],
    ["ECONNREFUSED", "connection_refused"],
    ["EHOSTUNREACH", "other"],
  ] as const)("classifies fetch cause %s as %s", async (code, failure) => {
    const cause = new Error(`connect ${code} https://bot.example/hook`);
    (cause as Error & { code: string }).code = code;
    const thrown = new TypeError("fetch failed");
    (thrown as Error & { cause: unknown }).cause = cause;
    const fetchImpl = vi.fn(async () => {
      throw thrown;
    }) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({ ok: false, error: "fetch failed", failure });
    expect(JSON.stringify(result)).not.toContain("bot.example");
    expect(JSON.stringify(result)).not.toContain(code);
  });

  it("classifies TimeoutError by name when no code is set", async () => {
    const thrown = new Error("the operation timed out");
    thrown.name = "TimeoutError";
    const fetchImpl = vi.fn(async () => {
      throw thrown;
    }) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({
      ok: false,
      error: "the operation timed out",
      failure: "timeout",
    });
  });
});
