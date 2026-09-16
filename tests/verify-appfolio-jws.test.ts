import { describe, expect, it } from "vitest";
import {
  CompactSign,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
} from "jose";
import { verifyAppfolioJws } from "../src/verify-appfolio-jws.js";

async function makePs256Fixture(payload: Uint8Array) {
  const { publicKey, privateKey } = await generateKeyPair("PS256", {
    extractable: true,
  });
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.alg = "PS256";
  jwk.use = "sig";
  jwk.kid = "test-kid";

  const compact = await new CompactSign(payload)
    .setProtectedHeader({ alg: "PS256", kid: "test-kid" })
    .sign(privateKey);

  const [header, , signature] = compact.split(".");
  const detached = `${header}..${signature}`;
  const jwks = createLocalJWKSet({ keys: [jwk] });

  return { detached, jwks, publicKey, privateKey, compact };
}

describe("verifyAppfolioJws", () => {
  const bodyText = JSON.stringify({
    client_id: "example_id",
    event_id: "evt-1",
    topic: "work_order_updates",
    resource_id: "res-1",
    event_timestamp: "2023-03-27T16:55:12Z",
    message_sent_at: "2023-08-28T23:18:27Z",
    event_type: "updated",
  });
  const rawBody = new TextEncoder().encode(bodyText);

  it("accepts a valid detached PS256 JWS over raw body bytes", async () => {
    const { detached, jwks } = await makePs256Fixture(rawBody);
    const result = await verifyAppfolioJws(rawBody, detached, jwks);
    expect(result).toEqual({ ok: true });
  });

  it("rejects when body bytes differ from what was signed", async () => {
    const { detached, jwks } = await makePs256Fixture(rawBody);
    const tampered = new TextEncoder().encode(bodyText + " ");
    const result = await verifyAppfolioJws(tampered, detached, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects missing signature header", async () => {
    const { jwks } = await makePs256Fixture(rawBody);
    const result = await verifyAppfolioJws(rawBody, "", jwks);
    expect(result).toEqual({
      ok: false,
      reason: "missing X-JWS-Signature header",
    });
  });

  it("rejects malformed detached format (no ..)", async () => {
    const { jwks } = await makePs256Fixture(rawBody);
    const result = await verifyAppfolioJws(rawBody, "not-a-detached-jws", jwks);
    expect(result).toEqual({
      ok: false,
      reason: "invalid detached JWS format",
    });
  });

  it("rejects wrong key / JWKS", async () => {
    const { detached } = await makePs256Fixture(rawBody);
    const other = await generateKeyPair("PS256", { extractable: true });
    const otherJwk = (await exportJWK(other.publicKey)) as JWK;
    otherJwk.alg = "PS256";
    otherJwk.kid = "test-kid";
    const wrongJwks = createLocalJWKSet({ keys: [otherJwk] });

    const result = await verifyAppfolioJws(rawBody, detached, wrongJwks);
    expect(result.ok).toBe(false);
  });

  it("does not depend on JSON re-stringify (whitespace-sensitive)", async () => {
    // Sign compact JSON; verify with same bytes — not a pretty-printed variant.
    const compactJson = '{"a":1,"b":2}';
    const pretty = '{\n  "a": 1,\n  "b": 2\n}';
    const signedBytes = new TextEncoder().encode(compactJson);
    const prettyBytes = new TextEncoder().encode(pretty);
    const { detached, jwks } = await makePs256Fixture(signedBytes);

    expect(await verifyAppfolioJws(signedBytes, detached, jwks)).toEqual({
      ok: true,
    });
    expect((await verifyAppfolioJws(prettyBytes, detached, jwks)).ok).toBe(
      false,
    );
  });
});
