import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_SENTINEL_NAME,
  assertDedicatedRunDir,
  assertOutsideRepo,
  claimDedicatedRunDir,
  existingLockMessage,
} from "../.cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/run-meta.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = [];

function tempPath(name) {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-run-safety-"));
  scratch.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (scratch.length > 0) {
    rmSync(scratch.pop(), { recursive: true, force: true });
  }
});

describe("verification run directory safety", () => {
  it("rejects the repo, a child, and an ancestor", () => {
    const parent = path.dirname(repo);
    expect(() => assertOutsideRepo(repo, repo)).toThrow(/inside the repo/);
    expect(() => assertOutsideRepo(path.join(repo, "src"), repo)).toThrow(
      /inside the repo/,
    );
    expect(() => assertOutsideRepo(parent, repo)).toThrow(
      /ancestor of the repo/,
    );
  });

  it("rejects a symlink whose target is an ancestor of the repo", () => {
    const link = tempPath("parent-link");
    symlinkSync(path.dirname(repo), link);
    expect(() => assertOutsideRepo(link, repo)).toThrow(/ancestor of the repo/);
  });

  it("refuses to claim an existing non-empty directory", () => {
    const dir = tempPath("occupied");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "keep-me"), "untouched");
    expect(() => claimDedicatedRunDir(dir)).toThrow(/new empty directory/);
    expect(existsSync(path.join(dir, "keep-me"))).toBe(true);
    expect(existsSync(path.join(dir, RUN_SENTINEL_NAME))).toBe(false);
  });

  it("accepts a claimed run directory and still rejects the repo parent", () => {
    const runDir = tempPath("run");
    const evidenceDir = tempPath("evidence");
    claimDedicatedRunDir(runDir);
    writeFileSync(
      path.join(runDir, "meta.json"),
      `${JSON.stringify({ runDir, evidenceDir })}\n`,
    );
    expect(assertDedicatedRunDir(runDir, repo)).toBe(
      assertOutsideRepo(runDir, repo),
    );

    expect(() => assertDedicatedRunDir(path.dirname(repo), repo)).toThrow(
      /ancestor of the repo/,
    );
  });

  it("reports an existing lock without deleting it", () => {
    const lockPath = tempPath("verify-bridge.lock");
    const body = `${JSON.stringify({ runDir: "/tmp/old-run", launchPid: 1 })}\n`;
    writeFileSync(lockPath, body);
    expect(existingLockMessage(lockPath)).toMatch(
      /does not remove an existing lock/,
    );
    expect(readFileSync(lockPath, "utf8")).toBe(body);
    expect(existsSync(lockPath)).toBe(true);
  });
});
