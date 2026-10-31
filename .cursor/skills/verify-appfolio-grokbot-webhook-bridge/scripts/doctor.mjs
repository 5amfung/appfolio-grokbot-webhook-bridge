#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  HEALTH_BODY,
  MISSING_SIGNATURE_BODY,
  VERIFY_KID,
  assertPortOwnedBy,
  captureCount,
  emit,
  emitErr,
  isAlive,
  parseArgs,
  readMeta,
  requireArg,
} from "./run-meta.mjs";

const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi"];

try {
  const args = parseArgs(process.argv.slice(2));
  const meta = readMeta(requireArg(args, "run-dir"));
  if (!isAlive(meta.boundariesPid)) {
    throw new Error(`boundaries pid ${meta.boundariesPid} is not running`);
  }
  if (!isAlive(meta.bridgePid)) {
    throw new Error(`bridge pid ${meta.bridgePid} is not running`);
  }
  assertPortOwnedBy(meta.bridgePort, meta.bridgePid);

  const upstreamStatus = readFileSync(meta.upstreamStatusPath, "utf8").trim();
  if (upstreamStatus !== "204") {
    throw new Error(
      `upstream-status is ${upstreamStatus}. Write 204 to ${meta.upstreamStatusPath} and run doctor again`,
    );
  }

  const jwksRes = await fetch(meta.jwksUrl, {
    signal: AbortSignal.timeout(5000),
  });
  if (!jwksRes.ok) {
    throw new Error(`JWKS GET returned ${jwksRes.status}`);
  }
  const jwks = await jwksRes.json();
  const key = jwks.keys?.[0];
  if (!key || key.kid !== VERIFY_KID || key.alg !== "PS256") {
    throw new Error("JWKS is missing the verify-bridge PS256 key");
  }
  for (const field of PRIVATE_JWK_FIELDS) {
    if (key[field] !== undefined) {
      throw new Error(`JWKS exposed private field ${field}`);
    }
  }

  const upstreamRes = await fetch(meta.upstreamUrl, {
    signal: AbortSignal.timeout(5000),
  });
  if (upstreamRes.status !== 404) {
    throw new Error(`upstream GET returned ${upstreamRes.status}, expected 404`);
  }

  const before = captureCount(meta.capturesPath);
  const health = await fetch(`${meta.baseUrl}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  const healthText = await health.text();
  if (health.status !== 200 || healthText !== HEALTH_BODY) {
    throw new Error(`health status=${health.status} body=${healthText}`);
  }

  const probe = await fetch(`${meta.baseUrl}/api/webhooks/appfolio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  const probeText = await probe.text();
  if (probe.status !== 401 || probeText !== MISSING_SIGNATURE_BODY) {
    throw new Error(`unsigned probe status=${probe.status} body=${probeText}`);
  }
  const after = captureCount(meta.capturesPath);
  if (after !== before) {
    throw new Error(
      `unsigned probe forwarded (captures ${before} -> ${after})`,
    );
  }

  emit("ok");
  emit(`baseUrl=${meta.baseUrl}`);
  emit(`bridgePid=${meta.bridgePid}`);
  emit("health=200");
  emit("probe=401");
  emit(`captures=${after}`);
} catch (err) {
  emitErr(`not-ok: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
