#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEALTH_BODY,
  MISSING_SIGNATURE_BODY,
  assertEvidenceSeparate,
  assertOutsideRepo,
  assertPortOwnedBy,
  captureCount,
  defaultDirs,
  beginOwnedRun,
  dotenvBridgeOverrides,
  emit,
  emitErr,
  existingLockMessage,
  groupAlive,
  isAlive,
  killProcessGroup,
  lockPathFor,
  releaseOwnedLock,
  repoRoot,
  sleep,
  writeLock,
  writeMeta,
} from "./run-meta.mjs";

const BOUNDARIES_SCRIPT = fileURLToPath(
  new URL("./boundaries.mjs", import.meta.url),
);

function fail(message, code = 1) {
  emitErr(message);
  process.exit(code);
}

function tail(filePath) {
  if (!existsSync(filePath)) {
    return "(no log)";
  }
  return readFileSync(filePath, "utf8").split("\n").slice(-40).join("\n");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("could not allocate a local port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function waitForJson(filePath, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  while (Date.now() < deadline) {
    if (exit) {
      throw new Error(
        `boundaries exited code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`,
      );
    }
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf8"));
    }
    sleep(100);
  }
  throw new Error("timed out waiting for boundaries.json");
}

async function waitForBridge(baseUrl, port, bridgePid, capturesPath, logPath) {
  const deadline = Date.now() + 120000;
  let lastError = "bridge did not answer";
  while (Date.now() < deadline) {
    if (!isAlive(bridgePid)) {
      throw new Error(
        `vercel dev exited before it was usable\n${tail(logPath)}`,
      );
    }
    try {
      const health = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const healthText = await health.text();
      if (health.status !== 200 || healthText !== HEALTH_BODY) {
        lastError = `health status=${health.status} body=${healthText}`;
        if (health.status === 200) {
          throw new Error(lastError);
        }
      } else {
        const probe = await fetch(`${baseUrl}/api/webhooks/appfolio`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(30000),
        });
        const probeText = await probe.text();
        if (
          probe.status === 401 &&
          probeText === MISSING_SIGNATURE_BODY &&
          captureCount(capturesPath) === 0
        ) {
          assertPortOwnedBy(port, bridgePid);
          return;
        }
        if (
          probeText.includes("GROK_BOT_WEBHOOK_URL is required") ||
          probeText.includes("GROK_BOT_BEARER_TOKEN is required")
        ) {
          throw new Error(`bridge is misconfigured: ${probeText}`);
        }
        if (probe.status === 401) {
          throw new Error(`unexpected unsigned response: ${probeText}`);
        }
        if (captureCount(capturesPath) !== 0) {
          throw new Error("unsigned ready probe was forwarded upstream");
        }
        lastError = `webhook probe status=${probe.status} body=${probeText}`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.startsWith("bridge is misconfigured") ||
        message.startsWith("unexpected unsigned") ||
        message.startsWith("unsigned ready") ||
        message.startsWith("health status=200") ||
        message.startsWith("port ") ||
        message.startsWith("lsof failed")
      ) {
        throw err;
      }
      lastError = message;
    }
    sleep(300);
  }
  throw new Error(`timed out waiting for ${baseUrl}: ${lastError}\n${tail(logPath)}`);
}

const root = repoRoot();
let dirs;
try {
  dirs = defaultDirs();
  dirs.runDir = assertOutsideRepo(dirs.runDir, root);
  dirs.evidenceDir = assertOutsideRepo(dirs.evidenceDir, root);
  assertEvidenceSeparate(dirs.evidenceDir, dirs.runDir);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const { runDir, evidenceDir } = dirs;
emit(`RUN_DIR=${runDir}`);
emit(`EVIDENCE_DIR=${evidenceDir}`);

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (/\b(now|vercel)\b\W+\bdev\b/.test(pkg.scripts?.dev || "")) {
  fail(
    "package.json scripts.dev invokes vercel dev, so the CLI aborts as a recursive invocation. Remove scripts.dev.",
  );
}

const overrides = dotenvBridgeOverrides(root);
if (overrides.length > 0) {
  fail(
    `vercel dev lets .env and .env.build override the launch environment. Move these aside for a verification run: ${overrides.join("; ")}`,
  );
}

if (!existsSync(path.join(root, "node_modules", "jose", "package.json"))) {
  fail("node_modules/jose is missing. Run npm ci from the repo root.");
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  fail(`Node >= 20 is required (this process is ${process.versions.node})`);
}

let vercelBin = process.env.VERCEL_BIN;
if (!vercelBin) {
  try {
    vercelBin = execFileSync("which", ["vercel"], { encoding: "utf8" }).trim();
  } catch {
    vercelBin = "";
  }
}
if (!vercelBin || !existsSync(vercelBin)) {
  fail("vercel CLI is not on PATH. Install it or set VERCEL_BIN.");
}

const lockPath = lockPathFor(root);
const started = {
  boundariesPid: null,
  bridgePid: null,
  bridgePort: null,
  baseUrl: null,
  jwksUrl: null,
  upstreamUrl: null,
  bearerToken: null,
};

function snapshot() {
  return {
    baseUrl: started.baseUrl,
    runDir,
    evidenceDir,
    bridgePid: started.bridgePid,
    boundariesPid: started.boundariesPid,
    bridgePort: started.bridgePort,
    jwksUrl: started.jwksUrl,
    upstreamUrl: started.upstreamUrl,
    bearerToken: started.bearerToken,
    privateJwkPath: path.join(runDir, "private.jwk"),
    capturesPath: path.join(runDir, "upstream-captures.jsonl"),
    upstreamStatusPath: path.join(runDir, "upstream-status"),
    lockPath,
    vercelLogPath: path.join(runDir, "vercel.log"),
  };
}

function persist() {
  writeMeta(snapshot());
  writeLock(lockPath, {
    phase: "running",
    launchPid: process.pid,
    runDir,
    evidenceDir,
    boundariesPid: started.boundariesPid,
    bridgePid: started.bridgePid,
  });
}

const starter = {
  phase: "starting",
  launchPid: process.pid,
  runDir,
  evidenceDir,
};
try {
  if (
    !beginOwnedRun({
      lockPath,
      runDir,
      evidenceDir,
      starter,
      meta: snapshot(),
    })
  ) {
    fail(existingLockMessage(lockPath), 2);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

try {
  const boundariesLog = openSync(path.join(runDir, "boundaries.log"), "a");
  const boundaries = spawn(process.execPath, [BOUNDARIES_SCRIPT], {
    cwd: root,
    detached: true,
    env: { ...process.env, VERIFY_RUN_DIR: runDir },
    stdio: ["ignore", boundariesLog, boundariesLog],
  });
  closeSync(boundariesLog);
  started.boundariesPid = boundaries.pid ?? null;
  persist();

  const boundaryState = waitForJson(
    path.join(runDir, "boundaries.json"),
    boundaries,
    15000,
  );
  started.jwksUrl = boundaryState.jwksUrl;
  started.upstreamUrl = boundaryState.upstreamUrl;
  started.bearerToken = `crsr_verify_${randomBytes(16).toString("hex")}`;
  started.bridgePort = await freePort();
  started.baseUrl = `http://127.0.0.1:${started.bridgePort}`;

  const vercelLogPath = path.join(runDir, "vercel.log");
  const vercelLog = openSync(vercelLogPath, "a");
  const childEnv = {
    ...process.env,
    GROK_BOT_WEBHOOK_URL: started.upstreamUrl,
    GROK_BOT_BEARER_TOKEN: started.bearerToken,
    APPFOLIO_JWKS_URL: started.jwksUrl,
  };
  delete childEnv.__VERCEL_DEV_RUNNING;
  const bridge = spawn(
    vercelBin,
    [
      "dev",
      "--local",
      "--listen",
      `127.0.0.1:${started.bridgePort}`,
      "--yes",
    ],
    {
      cwd: root,
      detached: true,
      env: childEnv,
      stdio: ["ignore", vercelLog, vercelLog],
    },
  );
  closeSync(vercelLog);
  started.bridgePid = bridge.pid ?? null;
  persist();

  await waitForBridge(
    started.baseUrl,
    started.bridgePort,
    started.bridgePid,
    path.join(runDir, "upstream-captures.jsonl"),
    vercelLogPath,
  );
  persist();
  boundaries.unref();
  bridge.unref();
  emit(`BASE_URL=${started.baseUrl}`);
  emit(`META=${path.join(runDir, "meta.json")}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  emitErr(message);
  if (started.bridgePid) {
    killProcessGroup(started.bridgePid);
  }
  if (started.boundariesPid) {
    killProcessGroup(started.boundariesPid);
  }
  if (started.boundariesPid || started.bridgePid) {
    try {
      persist();
    } catch (writeErr) {
      const writeMessage =
        writeErr instanceof Error ? writeErr.message : String(writeErr);
      emitErr(`could not write meta: ${writeMessage}`);
    }
  }
  if (!groupAlive(started.bridgePid) && !groupAlive(started.boundariesPid)) {
    releaseOwnedLock(lockPath, runDir);
  }
  emitErr(
    `Launch failed. Inspect ${path.join(runDir, "vercel.log")} then run: node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/cleanup.mjs --run-dir ${runDir}`,
  );
  process.exit(1);
}
