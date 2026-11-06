import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const entrypoints = readdirSync(join(root, "api"), { recursive: true })
  .filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))
  .map((path) => `api/${path.split(sep).join("/")}`)
  .sort();

assert.equal(
  process.versions.node.split(".")[0],
  "24",
  "Use Node 24 for Vercel build checks.",
);
assert.ok(entrypoints.length > 0, "No Vercel function entrypoints found.");

const entrypoint = process.argv[2];
if (entrypoint) {
  assert.ok(entrypoints.includes(entrypoint), "Unknown function entrypoint.");
  const require = createRequire(import.meta.url);
  const { build } = require("@vercel/node");
  const builderRequire = createRequire(require.resolve("@vercel/node"));
  const { FileFsRef } = builderRequire("@vercel/build-utils");
  const result = await build({
    files: {
      [entrypoint]: new FileFsRef({ fsPath: join(root, entrypoint) }),
    },
    entrypoint,
    workPath: root,
    repoRootPath: root,
    config: { zeroConfig: true },
    meta: {
      skipDownload: true,
      // Dependencies are already installed. Do not run installation or dev mode.
      runNpmInstallSet: new Set([join(root, "package.json")]),
    },
  });
  assert.equal(result.output.launcherType, "Nodejs");
  assert.equal(result.output.runtime, "nodejs24.x");
  assert.equal(result.output.handler, entrypoint.replace(/\.ts$/, ".js"));
  console.log(`Built ${entrypoint} for ${result.output.runtime}`);
} else {
  // Each function gets a fresh compiler, as it does in isolated builds.
  for (const path of entrypoints) {
    const result = spawnSync(process.execPath, [script, path], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1_024 * 1_024,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    const output = stripVTControlCharacters(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    // Vercel can emit a function even when it prints TypeScript errors.
    if (result.error || result.status !== 0 || /\berror TS\d+:/.test(output)) {
      console.error(`Vercel build check failed for ${path}`);
      if (result.error) console.error(result.error.message);
      process.exitCode = 1;
    }
  }
}
