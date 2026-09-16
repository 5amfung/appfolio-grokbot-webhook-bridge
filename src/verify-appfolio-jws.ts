import { base64url, compactVerify } from "jose";

/** Key or JWKS resolver accepted by jose.compactVerify. */
export type AppfolioJwks = Parameters<typeof compactVerify>[1];

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify AppFolio detached JWS (X-JWS-Signature, PS256) over raw body bytes.
 *
 * Detached compact form is `BASE64URL(header)..BASE64URL(signature)`.
 * We insert BASE64URL(rawBody) as the middle segment and call compactVerify.
 *
 * Pure: no HTTP framework imports; caller supplies JWKS / key resolver.
 *
 * @see https://github.com/appfolio/stack-webhook-jws-examples
 */
export async function verifyAppfolioJws(
  rawBody: Uint8Array,
  signatureHeader: string,
  jwks: AppfolioJwks,
): Promise<VerifyResult> {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return { ok: false, reason: "missing X-JWS-Signature header" };
  }

  const sep = signatureHeader.indexOf("..");
  if (sep <= 0 || sep !== signatureHeader.lastIndexOf("..")) {
    return { ok: false, reason: "invalid detached JWS format" };
  }

  const encodedHeader = signatureHeader.slice(0, sep);
  const encodedSignature = signatureHeader.slice(sep + 2);
  if (!encodedHeader || !encodedSignature) {
    return { ok: false, reason: "invalid detached JWS format" };
  }

  // Exact raw bytes — never JSON.parse/stringify before this.
  const encodedPayload = base64url.encode(rawBody);
  const compact = `${encodedHeader}.${encodedPayload}.${encodedSignature}`;

  try {
    await compactVerify(compact, jwks, { algorithms: ["PS256"] });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "verification failed";
    return { ok: false, reason: message };
  }
}
