#!/usr/bin/env node
// Fast post-build sanity check for the esbuild bundles in dist/ (run after
// `pnpm build`; wired as this package's `test` script).
//
// 1. Any bundle that contains esbuild's `__require(...)` shim (CJS deps calling
//    require() inside an ESM bundle) must also define a real `require`, or the
//    shim throws "Dynamic require of X is not supported" at runtime -- possibly
//    only on a lazy code path, so this is checked statically for every bundle.
// 2. dist/reviewer-state.js must actually start: run its --help.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const bundles = ["server.js", "reviewer-state.js"];
let failed = false;

function fail(msg) {
  console.error(`[cli check] FAIL: ${msg}`);
  failed = true;
}

for (const name of bundles) {
  const file = path.join(distDir, name);
  if (!fs.existsSync(file)) {
    fail(`${name} missing -- run \`pnpm build\` first`);
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  if (src.includes("__require(") && !/^const require = /m.test(src)) {
    fail(`${name} uses esbuild's __require shim but defines no \`require\` (see build.mjs banner)`);
  }
}

if (!failed) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "purview-cli-check-"));
  try {
    const out = execFileSync(process.execPath, [path.join(distDir, "reviewer-state.js"), "--help"], {
      encoding: "utf8",
      env: { ...process.env, PURVIEW_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!out.includes("Usage: reviewer-state")) fail(`reviewer-state.js --help printed unexpected output:\n${out}`);
  } catch (err) {
    fail(`reviewer-state.js --help exited non-zero:\n${err.stderr || err.message}`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
console.log(`[cli check] ok: ${bundles.join(", ")}`);
