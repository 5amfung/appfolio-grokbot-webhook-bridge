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
  beginOwnedRun,
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

function ownedRunFixture() {
  const root = tempPath("checkout");
  mkdirSync(root);
  return {
    root,
    runDir: path.join(root, "run"),
    evidenceDir: path.join(root, "evidence"),
    lockPath: path.join(root, "verify-bridge.lock"),
  };
}

function starterFor(fixture) {
  return {
    phase: "starting",
    launchPid: 1,
    runDir: fixture.runDir,
    evidenceDir: fixture.evidenceDir,
  };
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

  it("does not create a run directory when the checkout lock already exists", () => {
    const fixture = ownedRunFixture();
    const body = `${JSON.stringify({ runDir: "/tmp/old-run", launchPid: 1 })}\n`;
    writeFileSync(fixture.lockPath, body);
    expect(
      beginOwnedRun({
        ...fixture,
        starter: starterFor(fixture),
        meta: { boundariesPid: null, bridgePid: null },
      }),
    ).toBe(false);
    expect(existsSync(fixture.runDir)).toBe(false);
    expect(existsSync(fixture.evidenceDir)).toBe(false);
    expect(readFileSync(fixture.lockPath, "utf8")).toBe(body);
  });

  it("writes cleanup metadata once the lock is acquired", () => {
    const fixture = ownedRunFixture();
    expect(
      beginOwnedRun({
        ...fixture,
        starter: starterFor(fixture),
        meta: { boundariesPid: null, bridgePid: null, lockPath: fixture.lockPath },
      }),
    ).toBe(true);
    expect(assertDedicatedRunDir(fixture.runDir, repo)).toBe(
      assertOutsideRepo(fixture.runDir, repo),
    );
    expect(existsSync(fixture.evidenceDir)).toBe(true);
    expect(
      beginOwnedRun({
        ...fixture,
        starter: starterFor(fixture),
        meta: { boundariesPid: null, bridgePid: null },
      }),
    ).toBe(false);
    expect(existsSync(path.join(fixture.runDir, "meta.json"))).toBe(true);
  });

  it("releases the lock when the run directory cannot be claimed", () => {
    const fixture = ownedRunFixture();
    mkdirSync(fixture.runDir);
    writeFileSync(path.join(fixture.runDir, "keep-me"), "untouched");
    expect(() =>
      beginOwnedRun({
        ...fixture,
        starter: starterFor(fixture),
        meta: { boundariesPid: null, bridgePid: null },
      }),
    ).toThrow(/new empty directory/);
    expect(existsSync(fixture.lockPath)).toBe(false);
    expect(existsSync(path.join(fixture.runDir, "keep-me"))).toBe(true);
    expect(existsSync(path.join(fixture.runDir, RUN_SENTINEL_NAME))).toBe(false);
  });
});
