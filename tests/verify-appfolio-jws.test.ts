import { describe, expect, it } from "vitest";
import {
  CompactSign,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
} from "jose";
import { verifyAppfolioJws } from "../src/verify-appfolio-jws.js";
import appfolioWebhook from "./fixtures/appfolio-work-order-webhook.json" with { type: "json" };

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
  const bodyText = JSON.stringify(appfolioWebhook);
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
      expect(result.classification).toEqual({
        family: "bad_signature",
        failure: "signature_invalid",
      });
    }
  });

  it("rejects missing signature header", async () => {
    const { jwks } = await makePs256Fixture(rawBody);
    const result = await verifyAppfolioJws(rawBody, "", jwks);
    expect(result).toEqual({
      ok: false,
      reason: "missing X-JWS-Signature header",
      classification: {
        family: "bad_signature",
        failure: "missing_signature",
      },
    });
  });

  it("rejects malformed detached format (no ..)", async () => {
    const { jwks } = await makePs256Fixture(rawBody);
    const result = await verifyAppfolioJws(rawBody, "not-a-detached-jws", jwks);
    expect(result).toEqual({
      ok: false,
      reason: "invalid detached JWS format",
      classification: {
        family: "bad_signature",
        failure: "invalid_detached_jws",
      },
    });
  });

  it("rejects a JWKS with no key for the signature kid", async () => {
    const { detached } = await makePs256Fixture(rawBody);
    const other = await generateKeyPair("PS256", { extractable: true });
    const otherJwk = (await exportJWK(other.publicKey)) as JWK;
    otherJwk.alg = "PS256";
    otherJwk.kid = "other-kid";
    const wrongJwks = createLocalJWKSet({ keys: [otherJwk] });

    const result = await verifyAppfolioJws(rawBody, detached, wrongJwks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.classification).toEqual({
        family: "signing_key",
        failure: "jwks_no_matching_key",
      });
      expect(result.reason).toBe(
        "no applicable key found in the JSON Web Key Set",
      );
    }
  });

  it("classifies a JWKS timeout without using the jose message as the token", async () => {
    const { detached } = await makePs256Fixture(rawBody);
    const timeout = Object.assign(new Error("request timed out"), {
      code: "ERR_JWKS_TIMEOUT",
    });
    const result = await verifyAppfolioJws(rawBody, detached, async () => {
      throw timeout;
    });
    expect(result).toEqual({
      ok: false,
      reason: "request timed out",
      classification: { family: "signing_key", failure: "jwks_timeout" },
    });
  });

  it("classifies a code-less fetch TypeError as a signing-key failure", async () => {
    const { detached } = await makePs256Fixture(rawBody);
    const result = await verifyAppfolioJws(rawBody, detached, async () => {
      throw new TypeError("fetch failed");
    });
    expect(result).toEqual({
      ok: false,
      reason: "fetch failed",
      classification: { family: "signing_key", failure: "jwks_fetch_failed" },
    });
  });

  it("leaves an unmapped jose code and an inherited code name unclassified", async () => {
    const { detached } = await makePs256Fixture(rawBody);
    const unmapped = await verifyAppfolioJws(rawBody, detached, async () => {
      throw Object.assign(new Error("invalid key"), {
        code: "ERR_JWK_INVALID",
      });
    });
    expect(unmapped).toEqual({
      ok: false,
      reason: "invalid key",
      classification: { family: "unclassified", failure: "verify_failed" },
    });

    const inherited = await verifyAppfolioJws(rawBody, detached, async () => {
      throw Object.assign(new Error("toString"), { code: "toString" });
    });
    expect(inherited).toEqual({
      ok: false,
      reason: "toString",
      classification: { family: "unclassified", failure: "verify_failed" },
    });
  });

  it("does not depend on JSON re-stringify (whitespace-sensitive)", async () => {
    // Sign compact JSON; verify with same bytes — not a pretty-printed variant.
    const compactJson = JSON.stringify(appfolioWebhook);
    const pretty = JSON.stringify(appfolioWebhook, null, 2);
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
