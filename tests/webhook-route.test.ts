import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      client_id: "c1",
      event_id: "e1",
      topic: "work_order_updates",
      resource_id: "r1",
      event_timestamp: "2023-03-27T16:55:12Z",
      message_sent_at: "2023-08-28T23:18:27Z",
      event_type: "updated",
    }),
  );

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
    });
  });

  it("forwards raw body on valid signature and maps 2xx → forwarded", async () => {
    const { detached, jwks } = await signDetached(rawBody);
    const fetchImpl = vi.fn(
      async (_url: string | URL, init?: RequestInit) => {
        expect(init?.body).toBe(rawBody);
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer crsr_x",
        );
        return new Response(null, { status: 200 });
      },
    ) as unknown as typeof fetch;

    const outcome = await handleAppfolioWebhook(rawBody, detached, {
      jwks,
      grokBotWebhookUrl: "https://bot.example/hook",
      grokBotBearerToken: "crsr_x",
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "forwarded", upstreamStatus: 200 });
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
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      client_id: "c1",
      event_id: "e1",
      topic: "work_order_updates",
    }),
  );

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
    const captureWebhookHandled = vi.fn();
    const captureException = vi.fn();
    const flush = vi.fn(async () => undefined);
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
    captured: ReturnType<typeof vi.fn>,
    flush: ReturnType<typeof vi.fn>,
    event: Record<string, unknown>,
  ) {
    expect(captured).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(captured.mock.invocationCallOrder[0]).toBeLessThan(
      flush.mock.invocationCallOrder[0],
    );
    const actual = captured.mock.calls[0]?.[0] as { durationMs: number };
    expect(actual).toEqual({ ...event, durationMs: actual.durationMs });
    expect(actual.durationMs).toEqual(expect.any(Number));
    expect(actual.durationMs).toBeGreaterThanOrEqual(0);
  }

  it("returns 401 for a bad signature and records the failure token", async () => {
    const { detached, jwk } = await signedRequest(rawBody, "route-good");
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(rawBody) + " ",
    );
    const jwksUrl = stubBridgeEnv();
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "signature verification failed",
    );
  });

  it("returns 401 for a signing-key failure and records that token", async () => {
    const { detached } = await signedRequest(rawBody, "route-good");
    const other = await signedRequest(rawBody, "other-kid");
    const jwksUrl = stubBridgeEnv();
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
    });
  });

  it("returns 502 and records upstreamStatus 500", async () => {
    const { detached, jwk } = await signedRequest(rawBody, "route-good");
    const jwksUrl = stubBridgeEnv();
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
    expect(seen.captureException).toHaveBeenCalledOnce();
    expect(seen.captureException.mock.calls[0]?.[1]).toBe("upstream");
    expect(seen.captureException.mock.calls[0]?.[0]).toEqual(
      new Error("upstream returned 500"),
    );
    expectCaptured(seen.captureWebhookHandled, seen.flush, {
      kind: "upstream_failure",
      reason: "upstream_http_error",
      upstreamStatus: 500,
    });
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "upstream returned 500",
    );
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
    expect(JSON.stringify(seen.captureWebhookHandled.mock.calls)).not.toContain(
      "secret.example",
    );
  });
});
