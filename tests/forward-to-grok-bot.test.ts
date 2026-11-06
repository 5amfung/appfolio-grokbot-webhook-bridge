import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardToGrokBot } from "../src/forward-to-grok-bot.js";
import appfolioWebhook from "./fixtures/appfolio-work-order-webhook.json" with { type: "json" };

describe("forwardToGrokBot", () => {
  const body = new TextEncoder().encode(JSON.stringify(appfolioWebhook));
  const url = "https://bot.example/hooks/inbound";
  const token = "crsr_test";

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("POSTs raw bytes with Bearer auth and returns ok on 2xx", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(127.5)
      .mockReturnValueOnce(127.5);
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
    expect(result).toEqual({
      ok: true,
      status: 204,
      outboundDurationMs: 27.5,
      responseCleanup: { durationMs: 0, outcome: "no_body" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns failure when upstream is non-2xx", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(242)
      .mockReturnValueOnce(245);
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "upstream returned 503",
      outboundDurationMs: 42,
      responseCleanup: { durationMs: 3, outcome: "drained" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns failure when fetch throws", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(378.25);
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await forwardToGrokBot(body, url, token, fetchImpl);
    expect(result).toEqual({
      ok: false,
      error: "network down",
      failure: "other",
      outboundDurationMs: 78.25,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
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
    expect(result).toEqual({
      ok: false,
      error: "fetch failed",
      failure,
      outboundDurationMs: expect.any(Number),
    });
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
      outboundDurationMs: expect.any(Number),
    });
  });

  it("aborts a request without response headers after 30 seconds without retrying", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("expected an outbound abort signal");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const forwarding = forwardToGrokBot(body, url, token, fetchImpl);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await forwarding).toEqual({
      ok: false,
      error: "upstream request timed out",
      failure: "timeout",
      outboundDurationMs: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rejects", "never settles"])(
    "bounds cleanup when fetch ignores abort and body cancellation %s",
    async (behavior) => {
      vi.useFakeTimers();
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(127.5)
        .mockReturnValueOnce(227.5);
      const cancel = vi.fn(() =>
        behavior === "rejects"
          ? Promise.reject(new Error("cancellation failed"))
          : new Promise<void>(() => undefined),
      );
      const response = new Response(new ReadableStream({ cancel }), {
        status: 200,
      });
      const fetchImpl = vi.fn<typeof fetch>(async () => response);

      const forwarding = forwardToGrokBot(body, url, token, fetchImpl);
      await vi.advanceTimersByTimeAsync(100);

      expect(await forwarding).toEqual({
        ok: true,
        status: 200,
        outboundDurationMs: 27.5,
        responseCleanup: { durationMs: 100, outcome: "timeout" },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(response.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a body that exceeds the read budget without waiting for its deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1_024 + 1));
        },
        cancel,
      }),
      { status: 200 },
    );
    const fetchImpl = vi.fn<typeof fetch>(async () => response);

    expect(await forwardToGrokBot(body, url, token, fetchImpl)).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("measures response headers separately from a normally drained body", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const responseBody = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        }, 75);
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(responseBody)), 25);
        }),
    );

    const forwarding = forwardToGrokBot(body, url, token, fetchImpl);
    await vi.advanceTimersByTimeAsync(75);

    expect(await forwarding).toEqual({
      ok: true,
      status: 200,
      outboundDurationMs: 25,
      responseCleanup: { durationMs: 50, outcome: "drained" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains native HTTP response bodies and reuses a connection", async () => {
    const sockets: Socket[] = [];
    let completedBodies = 0;
    await withUpstreamServer(
      (req, res) => {
        sockets.push(req.socket);
        req.resume();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.flushHeaders();
        setTimeout(() => {
          completedBodies += 1;
          res.end('{"accepted":true}');
        }, 20);
      },
      async (origin) => {
        for (let delivery = 0; delivery < 3; delivery += 1) {
          expect(await forwardToGrokBot(body, origin, token)).toMatchObject({
            ok: true,
            status: 200,
            responseCleanup: {
              durationMs: expect.any(Number),
              outcome: "drained",
            },
          });
          expect(completedBodies).toBe(delivery + 1);
          // Let the native pool return the drained connection to its idle list.
          await nextTurn();
        }
        expect(sockets).toHaveLength(3);
        expect(new Set(sockets).size).toBeLessThan(sockets.length);
      },
    );
  });

  it.each([200, 503])(
    "cancels a stalled native HTTP body while preserving status %i",
    async (status) => {
      let closed = false;
      let attempts = 0;
      await withUpstreamServer(
        (req, res) => {
          attempts += 1;
          req.resume();
          res.writeHead(status);
          res.write("partial body");
          res.once("close", () => {
            closed = true;
          });
        },
        async (origin) => {
          const started = performance.now();
          expect(await forwardToGrokBot(body, origin, token)).toMatchObject({
            ok: status === 200,
            status,
            responseCleanup: {
              durationMs: expect.any(Number),
              outcome: "timeout",
            },
          });
          expect(performance.now() - started).toBeLessThan(1_000);
          await vi.waitFor(() => expect(closed).toBe(true));
          expect(attempts).toBe(1);
        },
      );
    },
  );

  it("cancels an oversized native HTTP body instead of downloading indefinitely", async () => {
    let closed = false;
    let sentBytes = 0;
    await withUpstreamServer(
      (req, res) => {
        req.resume();
        res.writeHead(200);
        res.once("close", () => {
          closed = true;
        });
        const sendChunk = () => {
          if (res.destroyed) return;
          sentBytes += 16 * 1_024;
          if (res.write(Buffer.alloc(16 * 1_024))) {
            setImmediate(sendChunk);
          } else {
            res.once("drain", sendChunk);
          }
        };
        sendChunk();
      },
      async (origin) => {
        const started = performance.now();
        expect(await forwardToGrokBot(body, origin, token)).toMatchObject({
          ok: true,
          status: 200,
          responseCleanup: {
            durationMs: expect.any(Number),
            outcome: "size_limit",
          },
        });
        expect(performance.now() - started).toBeLessThan(1_000);
        await vi.waitFor(() => expect(closed).toBe(true));
        expect(sentBytes).toBeGreaterThan(64 * 1_024);
      },
    );
  });

  it.each([200, 503])(
    "preserves status %i when a native HTTP response body fails while reading",
    async (status) => {
      let truncated = false;
      await withUpstreamServer(
        (req, res) => {
          req.resume();
          res.writeHead(status, { "Content-Length": "100" });
          res.write("partial");
          setTimeout(() => {
            truncated = true;
            res.destroy();
          }, 20);
        },
        async (origin) => {
          expect(await forwardToGrokBot(body, origin, token)).toMatchObject({
            ok: status === 200,
            status,
            responseCleanup: {
              durationMs: expect.any(Number),
              outcome: "read_error",
            },
          });
          expect(truncated).toBe(true);
        },
      );
    },
  );
});

async function withUpstreamServer(
  listener: RequestListener,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a local TCP address");
    }
    await run(`http://127.0.0.1:${address.port}/inbound`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
