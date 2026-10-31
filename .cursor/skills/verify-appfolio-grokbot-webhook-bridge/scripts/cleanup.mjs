#!/usr/bin/env node
import { existsSync, rmSync } from "node:fs";
import {
  assertDedicatedRunDir,
  assertEvidenceSeparate,
  assertOutsideRepo,
  canonicalPath,
  emit,
  emitErr,
  groupAlive,
  killProcessGroup,
  parseArgs,
  readLock,
  readMeta,
  repoRoot,
  requireArg,
} from "./run-meta.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const requestedRunDir = requireArg(args, "run-dir");
  const root = repoRoot();
  const runDir = assertDedicatedRunDir(requestedRunDir, root);
  const meta = readMeta(runDir);
  const evidenceDir = meta.evidenceDir;
  if (typeof evidenceDir !== "string" || evidenceDir.length === 0) {
    throw new Error("meta.json has no evidenceDir");
  }
  assertOutsideRepo(evidenceDir, root);
  assertEvidenceSeparate(evidenceDir, runDir);
  const evidenceExisted = existsSync(evidenceDir);

  const stoppedBoundaries = killProcessGroup(meta.boundariesPid);
  const stoppedBridge = killProcessGroup(meta.bridgePid);
  if (groupAlive(meta.boundariesPid) || groupAlive(meta.bridgePid)) {
    throw new Error(
      "a recorded process group is still alive after SIGTERM and SIGKILL",
    );
  }

  if (meta.lockPath && existsSync(meta.lockPath)) {
    let ownsLock = false;
    try {
      const lock = readLock(meta.lockPath);
      ownsLock = Boolean(
        lock && canonicalPath(String(lock.runDir)) === runDir,
      );
    } catch {
      ownsLock = false;
    }
    if (ownsLock) {
      rmSync(meta.lockPath, { force: true });
    }
  }

  rmSync(runDir, { recursive: true, force: true });
  if (evidenceExisted && !existsSync(evidenceDir)) {
    throw new Error(`cleanup removed evidence at ${evidenceDir}`);
  }

  emit(
    `stopped boundaries pid ${meta.boundariesPid} killed=${stoppedBoundaries}`,
  );
  emit(`stopped bridge pid ${meta.bridgePid} killed=${stoppedBridge}`);
  emit(`removed ${runDir}`);
  emit(`evidence remains ${evidenceDir}`);
} catch (err) {
  emitErr(`not-ok: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
