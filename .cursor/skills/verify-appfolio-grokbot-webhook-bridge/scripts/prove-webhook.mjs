#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  asArray,
  captureCount,
  emit,
  emitErr,
  parseArgs,
  readMeta,
  requireArg,
} from "./run-meta.mjs";

function writeProof(outPath, proof) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(proof, null, 2)}\n`);
}

function readResponse(headersPath, bodyPath) {
  const headerText = readFileSync(headersPath, "utf8").trim();
  const blocks = headerText.split(/\r?\n\r?\n/).filter((block) => block.length > 0);
  const last = blocks[blocks.length - 1] || "";
  const lines = last.split(/\r?\n/);
  const statusMatch = (lines[0] || "").match(/^HTTP\/\d+(?:\.\d+)?\s+(\d+)/);
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : null,
    headers,
    body: readFileSync(bodyPath, "utf8"),
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const runDir = requireArg(args, "run-dir");
  const outPath = requireArg(args, "out");
  const capturesBefore = Number(requireArg(args, "captures-before"));
  const expectStatus = Number(requireArg(args, "expect-status"));
  const expectForward = requireArg(args, "expect-forward");
  if (!Number.isInteger(capturesBefore) || capturesBefore < 0) {
    throw new Error("--captures-before must be a non-negative integer");
  }
  if (!Number.isInteger(expectStatus)) {
    throw new Error("--expect-status must be an integer");
  }
  if (expectForward !== "true" && expectForward !== "false") {
    throw new Error("--expect-forward must be true or false");
  }

  const meta = readMeta(runDir);
  const response = readResponse(
    requireArg(args, "response-headers"),
    requireArg(args, "response-body"),
  );
  if (response.status !== expectStatus) {
    throw new Error(`bridge status ${response.status} != ${expectStatus}`);
  }
  if (args["expect-body"] !== undefined && response.body !== args["expect-body"]) {
    throw new Error(`bridge body ${response.body} != ${args["expect-body"]}`);
  }
  if (args["expect-body"] === undefined && expectForward === "false") {
    const parsed = JSON.parse(response.body);
    if (typeof parsed.error !== "string" || parsed.error.length === 0) {
      throw new Error(`expected a non-empty error string, got ${response.body}`);
    }
  }
  for (const raw of asArray(args["expect-header"])) {
    const idx = raw.indexOf(":");
    if (idx === -1) {
      throw new Error(`--expect-header must be Name: value, got ${raw}`);
    }
    const name = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    const actual = response.headers.get(name);
    if (actual !== value) {
      throw new Error(`header ${name} is ${actual ?? "absent"} != ${value}`);
    }
  }

  const capturesAfter = captureCount(meta.capturesPath);
  const proof = {
    bridgeStatus: response.status,
    bridgeBody: response.body,
    capturesBefore,
    capturesAfter,
  };

  if (expectForward === "true") {
    if (capturesAfter !== capturesBefore + 1) {
      throw new Error(
        `expected one new upstream capture, ${capturesBefore} -> ${capturesAfter}`,
      );
    }
    const expectUpstream = Number(requireArg(args, "expect-upstream-status"));
    const raw = readFileSync(requireArg(args, "body-file"));
    const lines = readFileSync(meta.capturesPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const capture = JSON.parse(lines[lines.length - 1]);
    const upstreamBody = Buffer.from(capture.bodyBase64, "base64");
    proof.bodySha256 = createHash("sha256").update(raw).digest("hex");
    proof.upstreamBodySha256 = capture.bodySha256;
    proof.bodiesMatch = upstreamBody.equals(raw);
    proof.authorizationScheme = "Bearer";
    proof.authorizationMatch =
      capture.authorization === `Bearer ${meta.bearerToken}`;
    proof.contentType = capture.contentType;
    proof.contentTypeMatch = capture.contentType === "application/json";
    proof.upstreamStatusReturned = capture.statusReturned;
    proof.upstreamStatusMatch = capture.statusReturned === expectUpstream;
    writeProof(outPath, proof);
    if (
      !proof.bodiesMatch ||
      !proof.authorizationMatch ||
      !proof.contentTypeMatch ||
      !proof.upstreamStatusMatch
    ) {
      throw new Error(`forward mismatch written to ${outPath}`);
    }
  } else {
    if (capturesAfter !== capturesBefore) {
      throw new Error(
        `request was forwarded (captures ${capturesBefore} -> ${capturesAfter})`,
      );
    }
    writeProof(outPath, proof);
  }

  emit(`proof ${outPath}`);
} catch (err) {
  emitErr(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
