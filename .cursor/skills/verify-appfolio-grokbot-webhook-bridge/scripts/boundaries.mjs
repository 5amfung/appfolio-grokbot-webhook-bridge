#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { VERIFY_KID, emitErr } from "./run-meta.mjs";

const runDir = process.env.VERIFY_RUN_DIR;
if (!runDir) {
  emitErr("boundaries: VERIFY_RUN_DIR is required");
  process.exit(1);
}

mkdirSync(runDir, { recursive: true });

const { publicKey, privateKey } = await generateKeyPair("PS256", {
  extractable: true,
});
const publicJwk = await exportJWK(publicKey);
publicJwk.alg = "PS256";
publicJwk.use = "sig";
publicJwk.kid = VERIFY_KID;
delete publicJwk.d;

const privateJwk = await exportJWK(privateKey);
privateJwk.alg = "PS256";
privateJwk.use = "sig";
privateJwk.kid = VERIFY_KID;

const privateJwkPath = path.join(runDir, "private.jwk");
const capturesPath = path.join(runDir, "upstream-captures.jsonl");
const upstreamStatusPath = path.join(runDir, "upstream-status");
writeFileSync(privateJwkPath, `${JSON.stringify(privateJwk)}\n`, {
  mode: 0o600,
});
writeFileSync(capturesPath, "");
writeFileSync(upstreamStatusPath, "204\n");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const jwksServer = createServer((_req, res) => {
  const body = JSON.stringify({ keys: [publicJwk] });
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
});

const upstreamServer = createServer(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readRaw(req);
    const statusText = readFileSync(upstreamStatusPath, "utf8");
    const statusReturned = Number.parseInt(statusText.trim(), 10);
    const status =
      Number.isInteger(statusReturned) &&
      statusReturned >= 100 &&
      statusReturned <= 599
        ? statusReturned
        : 500;
    const headerValue = (name) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value.join(",") : (value ?? "");
    };
    const record = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      authorization: headerValue("authorization"),
      contentType: headerValue("content-type"),
      statusReturned: status,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      bodyBase64: body.toString("base64"),
    };
    appendFileSync(capturesPath, `${JSON.stringify(record)}\n`);
    res.writeHead(status);
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream mock failed";
    emitErr(`boundaries upstream: ${message}`);
    res.writeHead(500);
    res.end();
  }
});

const jwksPort = await listen(jwksServer);
const upstreamPort = await listen(upstreamServer);
const state = {
  pid: process.pid,
  jwksUrl: `http://127.0.0.1:${jwksPort}/jwks.json`,
  upstreamUrl: `http://127.0.0.1:${upstreamPort}/inbound`,
  privateJwkPath,
  capturesPath,
  upstreamStatusPath,
};
writeFileSync(
  path.join(runDir, "boundaries.json"),
  `${JSON.stringify(state, null, 2)}\n`,
);
