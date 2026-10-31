#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CompactSign, importJWK } from "jose";
import { emitErr, parseArgs, requireArg } from "./run-meta.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const jwk = JSON.parse(readFileSync(requireArg(args, "private-jwk"), "utf8"));
  const raw = readFileSync(requireArg(args, "body-file"));
  const key = await importJWK(jwk, "PS256");
  const compact = await new CompactSign(raw)
    .setProtectedHeader({ alg: "PS256", kid: jwk.kid })
    .sign(key);
  const [header, , signature] = compact.split(".");
  if (!header || !signature) {
    throw new Error("signer did not return a compact JWS");
  }
  process.stdout.write(`${header}..${signature}\n`);
} catch (err) {
  emitErr(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
