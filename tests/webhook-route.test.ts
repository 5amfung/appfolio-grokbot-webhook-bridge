import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  CompactSign,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from "jose";
import { handleWebhookRequest } from "../api/webhooks/appfolio.js";
import { handleAppfolioWebhook } from "../src/handle-appfolio-webhook.js";
import * as posthog from "../src/posthog.js";
import type { BridgeTelemetry } from "../src/posthog.js";
import appfolioWebhook from "./fixtures/appfolio-work-order-webhook.json" with { type: "json" };

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

beforeEach(() => {
  vi.mocked(waitUntil).mockClear();
});

async function signDetached(rawBody: Uint8Array) {
  const { publicKey, privateKey } = await generateKeyPair("PS256", {
    extractable: true,
  });
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.alg = "PS256";
  jwk.kid = "route-test";
  jwk.use = "sig";

  const compact = await new CompactSign(rawBody)
    .setProtectedHeader({ alg: "PS256", kid: "route-test" })
    .sign(privateKey);
  const [header, , signature] = compact.split(".");
  return {
    detached: `${header}..${signature}`,
    jwks: createLocalJWKSet({ keys: [jwk] }),
  };
}

describe("handleAppfolioWebhook (route logic, mocked upstream)", () => {
  const rawBody = new TextEncoder().encode(JSON.stringify(appfolioWebhook));

  it("returns unauthorized when signature is invalid", async () => {
    const { jwks } = await signDetached(rawBody);
    const outcome = await handleAppfolioWebhook(rawBody, "bad..sig", {
      jwks,
      grokBotWebhookUrl: "https://bot.example/hook",
      grokBotBearerToken: "crsr_x",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(outcome).toEqual({
      kind: "unauthorized",
      reason: "JWS Protected Header is invalid",
      classification: { family: "bad_signature", failure: "jws_invalid" },
      verificationDurationMs: expect.any(Number),
    });
  });

  it("forwards raw body on valid signature and maps 2xx → forwarded", async () => {
    const { detached, jwks } = await signDetached(rawBody);
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.body).toBe(rawBody);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer crsr_x",
      );
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await handleAppfolioWebhook(rawBody, detached, {
      jwks,
      grokBotWebhookUrl: "https://bot.example/hook",
      grokBotBearerToken: "crsr_x",
      fetchImpl,
    });

    expect(outcome).toEqual({
      kind: "forwarded",
      upstreamStatus: 200,
      outboundDurationMs: expect.any(Number),
      verificationDurationMs: expect.any(Number),
      responseCleanup: { durationMs: expect.any(Number), outcome: "no_body" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps upstream failure → upstream_failure (502 at boundary)", async () => {
    const { detached, jwks } = await signDetached(rawBody);
    const fetchImpl = vi.fn(
      async () => new Response("fail", { status: 500 }),
    ) as unknown as typeof fetch;

    const outcome = await handleAppfolioWebhook(rawBody, detached, {
      jwks,
      grokBotWebhookUrl: "https://bot.example/hook",
      grokBotBearerToken: "crsr_x",
      fetchImpl,
    });

    expect(outcome).toEqual({
      kind: "upstream_failure",
      error: "upstream returned 500",
      upstreamStatus: 500,
      outboundDurationMs: expect.any(Number),
      verificationDurationMs: expect.any(Number),
      responseCleanup: { durationMs: expect.any(Number), outcome: "drained" },
    });
  });

  it("omits upstreamStatus when the forward throws", async () => {
    const { detached, jwks } = await signDetached(rawBody);
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const outcome = await handleAppfolioWebhook(rawBody, detached, {
      jwks,
      grokBotWebhookUrl: "https://bot.example/hook",
      grokBotBearerToken: "crsr_x",
      fetchImpl,
    });

    expect(outcome).toEqual({
      kind: "upstream_failure",
      error: "network down",
      failure: "other",
      outboundDurationMs: expect.any(Number),
      verificationDurationMs: expect.any(Number),
    });
  });

  it("does not call upstream when verify fails", async () => {
    const { jwks } = await signDetached(rawBody);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await handleAppfolioWebhook(rawBody, "", {
      jwks,
      grokBotWebhookUrl: "https://bot.example/hook",
      grokBotBearerToken: "crsr_x",
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const WEBHOOK_URL = "https://bot.example/hook";

describe("handleWebhookRequest", () => {
  const rawBody = new TextEncoder().encode(JSON.stringify(appfolioWebhook));

  async function signedRequest(body: Uint8Array, kid: string) {
    const { publicKey, privateKey } = await generateKeyPair("PS256", {
      extractable: true,
    });
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.alg = "PS256";
    jwk.use = "sig";
    jwk.kid = kid;
    const compact = await new CompactSign(body)
      .setProtectedHeader({ alg: "PS256", kid })
      .sign(privateKey);
    const [header, , signature] = compact.split(".");
    return { detached: `${header}..${signature}`, jwk };
  }

  function fakeResponse() {
    const state = {
      statusCode: 0,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      headersSent: false,
    };
    const res = {
      get headersSent() {
        return state.headersSent;
      },
      setHeader(name: string, value: string) {
        state.headers[name] = value;
      },
      status(code: number) {
        state.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        state.body = payload;
        state.headersSent = true;
      },
    };
    return { res: res as unknown as VercelResponse, state };
  }

  function fakeTelemetry() {
    const captureWebhookHandled =
      vi.fn<BridgeTelemetry["captureWebhookHandled"]>();
    const captureException = vi.fn<BridgeTelemetry["captureException"]>();
    const flush = vi.fn<() => Promise<void>>(async () => undefined);
    return {
      captureWebhookHandled,
      captureException,
      flush,
      telemetry: { captureWebhookHandled, captureException, flush },
    };
  }

  function fakeRequest(options: {
    method: string;
    body?: Uint8Array;
    signature?: string;
    error?: Error;
  }): VercelRequest {
    const req = new EventEmitter() as VercelRequest;
    req.method = options.method;
    req.headers = {};
    if (options.signature !== undefined) {
      req.headers["x-jws-signature"] = options.signature;
    }
    queueMicrotask(() => {
      if (options.error) {
        req.emit("error", options.error);
        return;
      }
      if (options.body) req.emit("data", Buffer.from(options.body));
      req.emit("end");
    });
    return req;
  }

  function stubBridgeEnv() {
    const jwksUrl = `https://jwks.example/${crypto.randomUUID()}`;
    vi.stubEnv("GROK_BOT_WEBHOOK_URL", WEBHOOK_URL);
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_test");
    vi.stubEnv("APPFOLIO_JWKS_URL", jwksUrl);
    return jwksUrl;
  }

  function expectCaptured(
    captured: ReturnType<typeof fakeTelemetry>["captureWebhookHandled"],
    flush: ReturnType<typeof vi.fn>,
    event: Record<string, unknown>,
  ) {
    expect(captured).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(
      flush.mock.results[0]?.value,
    );
    expect(captured.mock.invocationCallOrder[0]).toBeLessThan(
      flush.mock.invocationCallOrder[0],
    );
    const actual = captured.mock.calls[0]?.[0];
    if (!actual) throw new Error("expected a captured webhook outcome");
    expect(actual).toEqual({ ...event, durationMs: actual.durationMs });
    expect(actual.durationMs).toEqual(expect.any(Number));
    expect(actual.durationMs).toBeGreaterThanOrEqual(0);
    const diagnostics = captured.mock.calls[0]?.[2];
    expect(diagnostics).toEqual(
      expect.objectContaining({
        handlerElapsedMs: expect.any(Number),
        telemetrySetupDurationMs: expect.any(Number),
        runtimeId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        runtimeRequestNumber: expect.any(Number),
      }),
    );
    expect(diagnostics?.handlerElapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics?.telemetrySetupDurationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics?.runtimeRequestNumber).toBeGreaterThan(0);
    if (
      actual.kind === "method_not_allowed" ||
      actual.kind === "config_failure"
    ) {
      expect(diagnostics).not.toHaveProperty("inputReadDurationMs");
      expect(diagnostics).not.toHaveProperty("verificationDurationMs");
      expect(diagnostics).not.toHaveProperty("jwksLookup");
      expect(diagnostics).not.toHaveProperty("responseCleanup");
    }
  }

  function capturedDiagnostics(seen: ReturnType<typeof fakeTelemetry>) {
    const diagnostics = seen.captureWebhookHandled.mock.calls[0]?.[2];
    if (!diagnostics) throw new Error("expected captured webhook diagnostics");
    return diagnostics;
  }

  function deferred<T>() {
    let resolve: (value: T) => void = () => {
      throw new Error("deferred promise was not initialized");
    };
    const promise = new Promise<T>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  it("returns 401 for a bad signature and records the failure token", async () => {
    const { detached, jwk } = await signedRequest(rawBody, "route-good");
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(rawBody) + " ",
    );
    const jwksUrl = stubBridgeEnv();
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        expect(String(input)).toBe(jwksUrl);
        return Response.json({ keys: [jwk] });
      });
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({
          method: "POST",
          body: tampered,
          signature: detached,
        }),
        http.res,
        seen.telemetry,
      );
    } finally {
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(401);
    expect(http.state.body).toEqual({ error: "signature verification failed" });
    expect(seen.captureException).not.toHaveBeenCalled();
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "unauthorized",
      family: "bad_signature",
      reason: "signature_invalid",
    });
    expect(seen.captureWebhookHandled.mock.calls[0]?.[1]).toEqual(tampered);
    expect(capturedDiagnostics(seen)).toEqual(
      expect.objectContaining({
        inputReadDurationMs: expect.any(Number),
        verificationDurationMs: expect.any(Number),
        jwksLookup: {
          durationMs: expect.any(Number),
          cacheFreshAtLookupStart: false,
          reloadingAtLookupStart: false,
        },
      }),
    );
    expect(capturedDiagnostics(seen)).not.toHaveProperty("responseCleanup");
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "signature verification failed",
    );
  });

  it("returns 401 for a signing-key failure and records that token", async () => {
    const { detached } = await signedRequest(rawBody, "route-good");
    const other = await signedRequest(rawBody, "other-kid");
    const jwksUrl = stubBridgeEnv();
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        expect(String(input)).toBe(jwksUrl);
        return Response.json({ keys: [other.jwk] });
      });
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({
          method: "POST",
          body: rawBody,
          signature: detached,
        }),
        http.res,
        seen.telemetry,
      );
    } finally {
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(401);
    expect(http.state.body).toEqual({
      error: "no applicable key found in the JSON Web Key Set",
    });
    expect(seen.captureException).not.toHaveBeenCalled();
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "unauthorized",
      family: "signing_key",
      reason: "jwks_no_matching_key",
    });
  });

  it("returns 200 and records the upstream status when the forward succeeds", async () => {
    const { detached, jwk } = await signedRequest(rawBody, "route-good");
    const jwksUrl = stubBridgeEnv();
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === jwksUrl) return Response.json({ keys: [jwk] });
        expect(url).toBe(WEBHOOK_URL);
        return new Response(null, { status: 200 });
      });
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody, signature: detached }),
        http.res,
        seen.telemetry,
      );
    } finally {
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(200);
    expect(http.state.body).toEqual({ ok: true, upstreamStatus: 200 });
    expect(seen.captureException).not.toHaveBeenCalled();
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "forwarded",
      reason: "forwarded",
      upstreamStatus: 200,
      outboundDurationMs: expect.any(Number),
    });
    expect(seen.captureWebhookHandled.mock.calls[0]?.[1]).toEqual(rawBody);
    expect(capturedDiagnostics(seen)).toEqual(
      expect.objectContaining({
        verificationDurationMs: expect.any(Number),
        responseCleanup: { durationMs: expect.any(Number), outcome: "no_body" },
      }),
    );
  });

  it("returns 502 and records upstreamStatus 500", async () => {
    const { detached, jwk } = await signedRequest(rawBody, "route-good");
    const jwksUrl = stubBridgeEnv();
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === jwksUrl) return Response.json({ keys: [jwk] });
        return new Response("fail", { status: 500 });
      });
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody, signature: detached }),
        http.res,
        seen.telemetry,
      );
    } finally {
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(502);
    expect(http.state.body).toEqual({ error: "upstream returned 500" });
    expect(seen.captureException).not.toHaveBeenCalled();
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "upstream_failure",
      reason: "upstream_http_error",
      upstreamStatus: 500,
      outboundDurationMs: expect.any(Number),
    });
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "upstream returned 500",
    );
  });

  it("returns 502 and records a fetch failure token when the forward throws", async () => {
    const { detached, jwk } = await signedRequest(rawBody, "route-good");
    const jwksUrl = stubBridgeEnv();
    const cause = new Error("connect ECONNREFUSED https://bot.example/hook");
    (cause as Error & { code: string }).code = "ECONNREFUSED";
    const thrown = new TypeError("fetch failed");
    (thrown as Error & { cause: unknown }).cause = cause;
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === jwksUrl) return Response.json({ keys: [jwk] });
        throw thrown;
      });
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody, signature: detached }),
        http.res,
        seen.telemetry,
      );
    } finally {
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(502);
    expect(http.state.body).toEqual({ error: "fetch failed" });
    expect(seen.captureException).not.toHaveBeenCalled();
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "upstream_failure",
      reason: "upstream_fetch_failed",
      failure: "connection_refused",
      outboundDurationMs: expect.any(Number),
    });
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "bot.example",
    );
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "ECONNREFUSED",
    );
    expect(capturedDiagnostics(seen)).not.toHaveProperty("responseCleanup");
  });

  it("returns 500 for a missing webhook url and records the config token", async () => {
    vi.stubEnv("GROK_BOT_WEBHOOK_URL", "");
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_test");
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody }),
        http.res,
        seen.telemetry,
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(500);
    expect(http.state.body).toEqual({
      error: "GROK_BOT_WEBHOOK_URL is required",
    });
    expect(seen.captureException).toHaveBeenCalledOnce();
    expect(seen.captureException.mock.calls[0]?.[1]).toBe("config");
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "config_failure",
      reason: "config_missing_webhook_url",
    });
  });

  it("returns 500 for an invalid webhook url and records config_invalid_url", async () => {
    vi.stubEnv("GROK_BOT_WEBHOOK_URL", "not a url");
    vi.stubEnv("GROK_BOT_BEARER_TOKEN", "crsr_test");
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody }),
        http.res,
        seen.telemetry,
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(500);
    expect(http.state.body).toEqual({ error: "Invalid URL" });
    expect(seen.captureException.mock.calls[0]?.[1]).toBe("config");
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "config_failure",
      reason: "config_invalid_url",
    });
  });

  it("returns 405 without an exception", async () => {
    const http = fakeResponse();
    const seen = fakeTelemetry();
    await handleWebhookRequest(
      fakeRequest({ method: "GET" }),
      http.res,
      seen.telemetry,
    );

    expect(http.state.statusCode).toBe(405);
    expect(http.state.headers.Allow).toBe("POST");
    expect(http.state.body).toEqual({ error: "method not allowed" });
    expect(seen.captureException).not.toHaveBeenCalled();
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "method_not_allowed",
      reason: "method_not_allowed",
    });
  });

  it("returns after the response while waitUntil holds the real flush promise", async () => {
    const http = fakeResponse();
    const seen = fakeTelemetry();
    let finishFlush!: () => void;
    const pendingFlush = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    seen.flush.mockImplementation(() => {
      expect(http.state.headersSent).toBe(true);
      return pendingFlush;
    });
    let handlerReturned = false;
    const request = handleWebhookRequest(
      fakeRequest({ method: "GET" }),
      http.res,
      seen.telemetry,
    ).then(() => {
      handlerReturned = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(handlerReturned).toBe(true);
      expect(http.state.statusCode).toBe(405);
      expect(waitUntil).toHaveBeenCalledExactlyOnceWith(pendingFlush);
    } finally {
      finishFlush();
      await request;
      await pendingFlush;
    }
  });

  it("returns 500 when the body cannot be read and records body_read_failed", async () => {
    stubBridgeEnv();
    const streamError = new Error("socket closed https://secret.example/body");
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", error: streamError }),
        http.res,
        seen.telemetry,
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(http.state.statusCode).toBe(500);
    expect(http.state.body).toEqual({ error: "internal error" });
    expect(seen.captureException).toHaveBeenCalledOnce();
    expect(seen.captureException).toHaveBeenCalledWith(streamError, "webhook");
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "body_read_failed",
      reason: "body_read_failed",
    });
    expect(seen.captureWebhookHandled.mock.calls[0]?.[1]).toBeUndefined();
    expect(
      capturedDiagnostics(seen).inputReadDurationMs,
    ).toBeGreaterThanOrEqual(0);
    expect(capturedDiagnostics(seen)).not.toHaveProperty(
      "verificationDurationMs",
    );
    expect(capturedDiagnostics(seen)).not.toHaveProperty("jwksLookup");
    expect(capturedDiagnostics(seen)).not.toHaveProperty("responseCleanup");
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "secret.example",
    );
  });

  it("omits key lookup and cleanup measurements when the signature is missing", async () => {
    stubBridgeEnv();
    const fetchImpl = vi.spyOn(globalThis, "fetch");
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody }),
        http.res,
        seen.telemetry,
      );
      expect(http.state.statusCode).toBe(401);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(capturedDiagnostics(seen)).toEqual(
        expect.objectContaining({
          inputReadDurationMs: expect.any(Number),
          verificationDurationMs: expect.any(Number),
        }),
      );
      expect(capturedDiagnostics(seen)).not.toHaveProperty("jwksLookup");
      expect(capturedDiagnostics(seen)).not.toHaveProperty("responseCleanup");
      expectCaptured(seen.captureWebhookHandled, seen.flush, {
        kind: "unauthorized",
        family: "bad_signature",
        reason: "missing_signature",
      });
    } finally {
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("records lookup waiting when a signing-key fetch rejects", async () => {
    const { detached } = await signedRequest(rawBody, "failed-key-fetch");
    stubBridgeEnv();
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed"));
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody, signature: detached }),
        http.res,
        seen.telemetry,
      );
      expect(http.state.statusCode).toBe(401);
      expect(capturedDiagnostics(seen)).toEqual(
        expect.objectContaining({
          verificationDurationMs: expect.any(Number),
          jwksLookup: {
            durationMs: expect.any(Number),
            cacheFreshAtLookupStart: false,
            reloadingAtLookupStart: false,
          },
        }),
      );
      expectCaptured(seen.captureWebhookHandled, seen.flush, {
        kind: "unauthorized",
        family: "signing_key",
        reason: "jwks_fetch_failed",
      });
    } finally {
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("keeps shared-key waits request-local and reuses the cached resolver", async () => {
    const { detached, jwk } = await signedRequest(rawBody, "shared-key-fetch");
    const jwksUrl = stubBridgeEnv();
    let clock = 10;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const keyRequested = deferred<void>();
    const keyResponse = deferred<Response>();
    let keyFetches = 0;
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        if (String(input) === jwksUrl) {
          keyFetches += 1;
          keyRequested.resolve();
          return keyResponse.promise;
        }
        expect(String(input)).toBe(WEBHOOK_URL);
        return Promise.resolve(new Response(null, { status: 200 }));
      });
    const first = { http: fakeResponse(), seen: fakeTelemetry() };
    const second = { http: fakeResponse(), seen: fakeTelemetry() };
    const cached = { http: fakeResponse(), seen: fakeTelemetry() };
    try {
      const firstRequest = handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody, signature: detached }),
        first.http.res,
        first.seen.telemetry,
      );
      await keyRequested.promise;
      clock = 20;
      const secondRequest = handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody, signature: detached }),
        second.http.res,
        second.seen.telemetry,
      );
      // Let the second verification join the unresolved resolver promise.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(keyFetches).toBe(1);
      expect(first.seen.captureWebhookHandled).not.toHaveBeenCalled();
      expect(second.seen.captureWebhookHandled).not.toHaveBeenCalled();
      clock = 50;
      keyResponse.resolve(Response.json({ keys: [jwk] }));
      await Promise.all([firstRequest, secondRequest]);

      const firstDiagnostics = capturedDiagnostics(first.seen);
      const secondDiagnostics = capturedDiagnostics(second.seen);
      expect(firstDiagnostics.jwksLookup).toEqual({
        durationMs: 40,
        cacheFreshAtLookupStart: false,
        reloadingAtLookupStart: false,
      });
      expect(secondDiagnostics.jwksLookup).toEqual({
        durationMs: 30,
        cacheFreshAtLookupStart: false,
        reloadingAtLookupStart: true,
      });
      expect(firstDiagnostics.runtimeId).toBe(secondDiagnostics.runtimeId);
      expect(secondDiagnostics.runtimeRequestNumber).toBe(
        firstDiagnostics.runtimeRequestNumber + 1,
      );

      clock = 60;
      await handleWebhookRequest(
        fakeRequest({ method: "POST", body: rawBody, signature: detached }),
        cached.http.res,
        cached.seen.telemetry,
      );
      expect(keyFetches).toBe(1);
      expect(capturedDiagnostics(cached.seen).jwksLookup).toEqual({
        durationMs: 0,
        cacheFreshAtLookupStart: true,
        reloadingAtLookupStart: false,
      });
      for (const request of [first, second, cached]) {
        expect(request.http.state.statusCode).toBe(200);
        expect(request.seen.captureWebhookHandled).toHaveBeenCalledOnce();
      }
    } finally {
      keyResponse.resolve(Response.json({ keys: [jwk] }));
      now.mockRestore();
      fetchImpl.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each<{ name: string; value?: string | string[]; expected?: string }>([
    { name: "missing identifier" },
    {
      name: "routing identifier",
      value: "sfo1::iad1::request-123",
      expected: "sfo1::iad1::request-123",
    },
    {
      name: "maximum length",
      value: "a".repeat(256),
      expected: "a".repeat(256),
    },
    { name: "oversized identifier", value: "a".repeat(257) },
    { name: "multiple values", value: ["iad1::one", "iad1::two"] },
    { name: "unsafe characters", value: "iad1::one\nsecret" },
  ])("allowlists Vercel context for $name", async ({ value, expected }) => {
    vi.stubEnv("VERCEL_REGION", "iad1");
    const req = fakeRequest({ method: "GET" });
    req.headers["x-vercel-id"] = value;
    const http = fakeResponse();
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(req, http.res, seen.telemetry);
      const diagnostics = capturedDiagnostics(seen);
      expect(diagnostics.vercelRegion).toBe("iad1");
      if (expected === undefined) {
        expect(diagnostics).not.toHaveProperty("vercelId");
      } else {
        expect(diagnostics.vercelId).toBe(expected);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("omits unavailable execution-region context", async () => {
    vi.stubEnv("VERCEL_REGION", "");
    const seen = fakeTelemetry();
    try {
      await handleWebhookRequest(
        fakeRequest({ method: "GET" }),
        fakeResponse().res,
        seen.telemetry,
      );
      expect(capturedDiagnostics(seen)).not.toHaveProperty("vercelRegion");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("includes lazy telemetry setup in the new timer and preserves the legacy boundary", async () => {
    let monotonicTime = 100;
    let wallTime = 1_000;
    const now = vi
      .spyOn(performance, "now")
      .mockImplementation(() => monotonicTime);
    const wallNow = vi.spyOn(Date, "now").mockImplementation(() => wallTime);
    const seen = fakeTelemetry();
    const createTelemetry = vi
      .spyOn(posthog, "createBridgeTelemetry")
      .mockImplementation(() => {
        monotonicTime += 75;
        wallTime += 75;
        return {
          ...seen.telemetry,
          enabled: false,
          serviceName: "appfolio-grokbot-webhook-bridge",
          environment: "test",
          serviceVersion: "test",
          shutdown: async () => undefined,
        };
      });
    const http = fakeResponse();
    const writeResponse = vi.spyOn(http.res, "json").mockImplementation(() => {
      monotonicTime += 5;
      wallTime += 5;
      return http.res;
    });
    try {
      await handleWebhookRequest(fakeRequest({ method: "GET" }), http.res);
      expect(createTelemetry).toHaveBeenCalledOnce();
      expect(capturedDiagnostics(seen)).toEqual(
        expect.objectContaining({
          telemetrySetupDurationMs: 75,
          handlerElapsedMs: 80,
        }),
      );
      expect(seen.captureWebhookHandled.mock.calls[0]?.[0].durationMs).toBe(5);
    } finally {
      now.mockRestore();
      wallNow.mockRestore();
      createTelemetry.mockRestore();
      writeResponse.mockRestore();
    }
  });
});
