import { base64url, compactVerify } from "jose";

/** Key or JWKS resolver accepted by jose.compactVerify. */
export type AppfolioJwks = Parameters<typeof compactVerify>[1];

/**
 * ERR_JOSE_NOT_SUPPORTED is one code for more than one jose throw,
 * so that code stays in its own family.
 */
const VERIFY_CODES = {
  signing_key: {
    ERR_JWKS_TIMEOUT: "jwks_timeout",
    ERR_JWKS_NO_MATCHING_KEY: "jwks_no_matching_key",
    ERR_JWKS_MULTIPLE_MATCHING_KEYS: "jwks_multiple_matching_keys",
    ERR_JWKS_INVALID: "jwks_invalid",
    ERR_JOSE_GENERIC: "jwks_unavailable",
  },
  bad_signature: {
    ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "signature_invalid",
    ERR_JWS_INVALID: "jws_invalid",
    ERR_JOSE_ALG_NOT_ALLOWED: "alg_not_allowed",
  },
  unclassified: {
    ERR_JOSE_NOT_SUPPORTED: "jose_not_supported",
  },
} as const;

const LOCAL_HTTP_REASON = {
  missing_signature: "missing X-JWS-Signature header",
  invalid_detached_jws: "invalid detached JWS format",
} as const;

const JWKS_FETCH_FAILED = "jwks_fetch_failed";
const VERIFY_FAILED = "verify_failed";

type VerifyFamily = keyof typeof VERIFY_CODES;

type GroupFailure<F extends VerifyFamily> =
  (typeof VERIFY_CODES)[F][keyof (typeof VERIFY_CODES)[F]];

type SigningKeyFailure = GroupFailure<"signing_key"> | typeof JWKS_FETCH_FAILED;
type BadSignatureFailure =
  | GroupFailure<"bad_signature">
  | keyof typeof LOCAL_HTTP_REASON;
type UnclassifiedFailure = GroupFailure<"unclassified"> | typeof VERIFY_FAILED;

export type VerifyClassification =
  | { family: "signing_key"; failure: SigningKeyFailure }
  | { family: "bad_signature"; failure: BadSignatureFailure }
  | { family: "unclassified"; failure: UnclassifiedFailure };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string; classification: VerifyClassification };

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
    return localMiss("missing_signature");
  }

  const sep = signatureHeader.indexOf("..");
  if (sep <= 0 || sep !== signatureHeader.lastIndexOf("..")) {
    return localMiss("invalid_detached_jws");
  }

  const encodedHeader = signatureHeader.slice(0, sep);
  const encodedSignature = signatureHeader.slice(sep + 2);
  if (!encodedHeader || !encodedSignature) {
    return localMiss("invalid_detached_jws");
  }

  // Exact raw bytes — never JSON.parse/stringify before this.
  const encodedPayload = base64url.encode(rawBody);
  const compact = `${encodedHeader}.${encodedPayload}.${encodedSignature}`;

  try {
    await compactVerify(compact, jwks, { algorithms: ["PS256"] });
    return { ok: true };
  } catch (err) {
    const classification = classificationForThrown(err);
    const reason = err instanceof Error ? err.message : "verification failed";
    return { ok: false, reason, classification };
  }
}

function localMiss(
  failure: keyof typeof LOCAL_HTTP_REASON,
): Extract<VerifyResult, { ok: false }> {
  return {
    ok: false,
    reason: LOCAL_HTTP_REASON[failure],
    classification: { family: "bad_signature", failure },
  };
}

function classificationForThrown(err: unknown): VerifyClassification {
  const code = ownCode(err);
  if (code.present) {
    if (code.value !== undefined) {
      const classified = classificationForCode(code.value);
      if (classified) return classified;
    }
    return { family: "unclassified", failure: VERIFY_FAILED };
  }
  if (err instanceof TypeError && err.message === "fetch failed") {
    return { family: "signing_key", failure: JWKS_FETCH_FAILED };
  }
  return { family: "unclassified", failure: VERIFY_FAILED };
}

function classificationForCode(code: string): VerifyClassification | undefined {
  const signingKey = groupFailure(VERIFY_CODES.signing_key, code);
  if (signingKey !== undefined) {
    return { family: "signing_key", failure: signingKey };
  }
  const badSignature = groupFailure(VERIFY_CODES.bad_signature, code);
  if (badSignature !== undefined) {
    return { family: "bad_signature", failure: badSignature };
  }
  const unclassified = groupFailure(VERIFY_CODES.unclassified, code);
  if (unclassified !== undefined) {
    return { family: "unclassified", failure: unclassified };
  }
  return undefined;
}

function groupFailure<T extends Record<string, string>>(
  group: T,
  code: string,
): T[keyof T] | undefined {
  if (!Object.hasOwn(group, code)) return undefined;
  return group[code as keyof T];
}

function ownCode(
  err: unknown,
): { present: false } | { present: true; value?: string } {
  if (typeof err !== "object" || err === null || !Object.hasOwn(err, "code")) {
    return { present: false };
  }
  const value = (err as { code: unknown }).code;
  if (typeof value !== "string") return { present: true };
  return { present: true, value };
}
