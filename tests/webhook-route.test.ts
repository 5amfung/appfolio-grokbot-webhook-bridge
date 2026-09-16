import { describe, expect, it, vi } from "vitest";
import {
  CompactSign,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from "jose";
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
    expect(outcome.kind).toBe("unauthorized");
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

    expect(outcome.kind).toBe("upstream_failure");
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
