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
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("503");
    }
  });

  it("returns failure when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({ ok: false, error: "network down" });
  });
});
