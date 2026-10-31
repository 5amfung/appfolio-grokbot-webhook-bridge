import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  groupAlive,
  killProcessGroup,
  processGroupPids,
} from "../.cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/run-meta.mjs";

const leaders = [];
const scratch = [];

afterEach(() => {
  while (leaders.length > 0) {
    killProcessGroup(leaders.pop());
  }
  while (scratch.length > 0) {
    rmSync(scratch.pop(), { recursive: true, force: true });
  }
});

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("process group cleanup", () => {
  it("terminates a worker after the group leader has exited", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "verify-group-"));
    scratch.push(dir);
    const worker = path.join(dir, "worker.mjs");
    const leader = path.join(dir, "leader.mjs");
    writeFileSync(
      worker,
      "process.on('SIGHUP', () => {});\nsetInterval(() => {}, 500);\n",
    );
    writeFileSync(
      leader,
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: "ignore" });
child.unref();
setTimeout(() => process.exit(0), 200);
`,
    );
    const proc = spawn(process.execPath, [leader], {
      detached: true,
      stdio: "ignore",
    });
    const leaderPid = proc.pid;
    leaders.push(leaderPid);
    proc.unref();

    let workers = [];
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const members = processGroupPids(leaderPid);
      workers = members.filter((pid) => pid !== leaderPid);
      if (workers.length > 0 && !members.includes(leaderPid)) {
        break;
      }
      await sleep(50);
    }

    expect(workers.length).toBeGreaterThan(0);
    expect(groupAlive(leaderPid)).toBe(true);
    expect(killProcessGroup(leaderPid)).toBe(true);
    expect(groupAlive(leaderPid)).toBe(false);
    expect(processGroupPids(leaderPid)).toEqual([]);
  });
});
