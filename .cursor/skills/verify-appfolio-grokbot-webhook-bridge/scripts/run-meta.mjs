import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERIFY_KID = "verify-bridge";
export const MISSING_SIGNATURE_BODY =
  '{"error":"missing X-JWS-Signature header"}';
export const HEALTH_BODY = '{"ok":true}';
export const RUN_SENTINEL_NAME = ".verify-bridge-run";
const RUN_SENTINEL_BODY = "verify-appfolio-grokbot-webhook-bridge\n";

const BRIDGE_ENV_KEYS = [
  "GROK_BOT_WEBHOOK_URL",
  "GROK_BOT_BEARER_TOKEN",
  "APPFOLIO_JWKS_URL",
];

export function emit(line) {
  writeSync(1, `${line}\n`);
}

export function emitErr(line) {
  writeSync(2, `${line}\n`);
}

export function repoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name === "appfolio-grokbot-webhook-bridge") {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    "Could not find the appfolio-grokbot-webhook-bridge repo root from the skill scripts",
  );
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

export function parentPid(pid) {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    const n = Number(out);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function pidBelongsTo(pid, ancestor) {
  let current = pid;
  const seen = new Set();
  for (let i = 0; i < 30 && current && !seen.has(current); i += 1) {
    if (current === ancestor) {
      return true;
    }
    seen.add(current);
    current = parentPid(current);
  }
  return false;
}

export function listenerPids(port) {
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8" },
    );
    return [...out.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1]));
  } catch (err) {
    if (err && err.status === 1) {
      return [];
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`lsof failed for port ${port}: ${message}`);
  }
}

export function assertPortOwnedBy(port, ancestor) {
  const listeners = listenerPids(port);
  if (listeners.length === 0) {
    throw new Error(`nothing is listening on 127.0.0.1:${port}`);
  }
  const outsiders = listeners.filter((pid) => !pidBelongsTo(pid, ancestor));
  if (outsiders.length > 0) {
    throw new Error(
      `port ${port} is owned by pid ${outsiders.join(",")} rather than ${ancestor}`,
    );
  }
  return listeners;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") {
      return false;
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch (err2) {
      if (err2 && err2.code === "ESRCH") {
        return false;
      }
      throw err2;
    }
  }
}

export function killProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
    return false;
  }
  if (!signalGroup(pid, "SIGTERM")) {
    return false;
  }
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && isAlive(pid)) {
    sleep(50);
  }
  if (isAlive(pid)) {
    signalGroup(pid, "SIGKILL");
  }
  return true;
}

export function metaPath(runDir) {
  return path.join(runDir, "meta.json");
}

export function readMeta(runDir) {
  return JSON.parse(readFileSync(metaPath(runDir), "utf8"));
}

export function writeMeta(meta) {
  const destination = metaPath(meta.runDir);
  const tmp = `${destination}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, destination);
}

export function lockPathFor(root) {
  return path.join(root, ".vercel", "verify-bridge.lock");
}

export function readLock(lockPath) {
  if (!existsSync(lockPath)) {
    return null;
  }
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

export function writeLock(lockPath, payload) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const tmp = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, lockPath);
}

export function tryCreateLock(lockPath, payload) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export function lockHoldersAlive(lock) {
  if (!lock) {
    return false;
  }
  return [lock.launchPid, lock.boundariesPid, lock.bridgePid].some((pid) =>
    isAlive(pid),
  );
}

export function defaultDirs() {
  const runId = process.env.VERIFY_RUN_ID || `${Date.now()}-${process.pid}`;
  if (runId.includes("/") || runId.includes("\\") || runId.includes("..")) {
    throw new Error(`VERIFY_RUN_ID is not a single path segment: ${runId}`);
  }
  if (process.env.VERIFY_RUN_DIR || process.env.VERIFY_EVIDENCE_DIR) {
    if (!process.env.VERIFY_RUN_DIR || !process.env.VERIFY_EVIDENCE_DIR) {
      throw new Error(
        "Set both VERIFY_RUN_DIR and VERIFY_EVIDENCE_DIR, or neither",
      );
    }
    return {
      runDir: path.resolve(process.env.VERIFY_RUN_DIR),
      evidenceDir: path.resolve(process.env.VERIFY_EVIDENCE_DIR),
    };
  }
  const verifyRoot = process.env.VERIFY_ROOT
    ? path.resolve(process.env.VERIFY_ROOT)
    : path.join(
        process.env.TMPDIR || "/tmp",
        "verify-appfolio-grokbot-webhook-bridge",
      );
  return {
    runDir: path.join(verifyRoot, runId, "run"),
    evidenceDir: path.join(verifyRoot, runId, "evidence"),
  };
}

export function canonicalPath(dir) {
  const resolved = path.resolve(dir);
  let current = resolved;
  const missing = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    missing.push(path.basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return missing.length === 0 ? base : path.join(base, ...missing.reverse());
}

export function assertOutsideRepo(dir, root) {
  const resolved = canonicalPath(dir);
  const repo = canonicalPath(root);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`Refusing filesystem root: ${resolved}`);
  }
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    throw new Error(`${resolved} is inside the repo`);
  }
  if (repo.startsWith(`${resolved}${path.sep}`)) {
    throw new Error(`${resolved} is an ancestor of the repo`);
  }
  return resolved;
}

export function claimDedicatedRunDir(runDir) {
  if (existsSync(runDir)) {
    const entries = readdirSync(runDir);
    if (entries.length > 0) {
      throw new Error(
        `Refusing ${runDir}: a run directory must be a new empty directory`,
      );
    }
  } else {
    mkdirSync(runDir, { recursive: true });
  }
  writeFileSync(path.join(runDir, RUN_SENTINEL_NAME), RUN_SENTINEL_BODY, {
    flag: "wx",
  });
}

export function assertDedicatedRunDir(runDir, root) {
  const resolved = assertOutsideRepo(runDir, root);
  const sentinelPath = path.join(resolved, RUN_SENTINEL_NAME);
  if (!existsSync(sentinelPath)) {
    throw new Error(
      `Refusing to delete ${resolved}: not a dedicated verification run directory`,
    );
  }
  if (readFileSync(sentinelPath, "utf8") !== RUN_SENTINEL_BODY) {
    throw new Error(
      `Refusing to delete ${resolved}: run sentinel is not from this harness`,
    );
  }
  const meta = readMeta(resolved);
  if (canonicalPath(meta.runDir) !== resolved) {
    throw new Error(
      `Refusing to delete ${resolved}: meta.json runDir does not match this directory`,
    );
  }
  return resolved;
}

export function assertEvidenceSeparate(evidenceDir, runDir) {
  const evidence = path.resolve(evidenceDir);
  const run = path.resolve(runDir);
  if (evidence === run || evidence.startsWith(`${run}${path.sep}`)) {
    throw new Error(
      "EVIDENCE_DIR is inside RUN_DIR, so cleanup would delete the proof",
    );
  }
  return evidence;
}

export function dotenvBridgeOverrides(root) {
  const hits = [];
  for (const name of [".env", ".env.build"]) {
    const filePath = path.join(root, name);
    if (!existsSync(filePath)) {
      continue;
    }
    const text = readFileSync(filePath, "utf8");
    for (const key of BRIDGE_ENV_KEYS) {
      const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m");
      if (matcher.test(text)) {
        hits.push(`${name} sets ${key}`);
      }
    }
  }
  return hits;
}

export function captureCount(capturesPath) {
  if (!existsSync(capturesPath)) {
    return 0;
  }
  const text = readFileSync(capturesPath, "utf8");
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").filter((line) => line.length > 0).length;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      throw new Error(`Unexpected argument ${raw}`);
    }
    const key = raw.slice(2);
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    i += 1;
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function requireArg(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

export function asArray(value) {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
