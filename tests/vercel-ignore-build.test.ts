import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/vercel-ignore-build.sh",
);

function ignoreStatus(env: NodeJS.ProcessEnv): number {
  const result = spawnSync("sh", [script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return result.status as number;
}

describe("Vercel ignore build", () => {
  it("builds a preview for any commit", () => {
    expect(
      ignoreStatus({
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_MESSAGE: "feat: add a webhook route",
      }),
    ).toBe(1);
  });

  it("builds when VERCEL_ENV is unset", () => {
    expect(
      ignoreStatus({
        VERCEL_GIT_COMMIT_MESSAGE: "feat: add a webhook route",
      }),
    ).toBe(1);
  });

  it("skips a normal production merge", () => {
    expect(
      ignoreStatus({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_MESSAGE: "feat: add a webhook route (#7)",
      }),
    ).toBe(0);
  });

  it("builds a production release subject", () => {
    expect(
      ignoreStatus({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_MESSAGE: "chore(main): release 1.2.3",
      }),
    ).toBe(1);
  });

  it("builds a squash-merged production release subject", () => {
    expect(
      ignoreStatus({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_MESSAGE: "chore(main): release 1.2.3 (#12)",
      }),
    ).toBe(1);
  });

  it("builds a release subject that uses CRLF line endings", () => {
    expect(
      ignoreStatus({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_MESSAGE: "chore(main): release 1.2.3 (#12)\r\n\r\nnotes",
      }),
    ).toBe(1);
  });

  it("builds when the release subject is a later line", () => {
    const message = [
      "Merge pull request #12 from owner/release-please--branches--main--components--appfolio-grokbot-webhook-bridge",
      "",
      "chore(main): release 1.2.3",
      "",
      "Release notes",
    ].join("\n");
    expect(
      ignoreStatus({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_MESSAGE: message,
      }),
    ).toBe(1);
  });

  it("skips a production subject that names the package", () => {
    expect(
      ignoreStatus({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_MESSAGE:
          "chore(main): release appfolio-grokbot-webhook-bridge 1.2.3",
      }),
    ).toBe(0);
  });
});
