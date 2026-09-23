#!/usr/bin/env node
// Builds the artifacts that ship inside the @francofrizzo/purview tarball:
//
//   dist/server.js         - server+core, bundled+self-contained (ESM)
//   dist/reviewer-state.js - the core CLI the skill shells out to, same deal
//   dist/skill/            - a copy of skills/pr-review
//   web-dist/               - a copy of packages/web/dist
//
// Bundles straight from TypeScript source (esbuild transpiles it, and
// resolves the NodeNext-style "./foo.js" relative imports this codebase uses
// to the sibling "./foo.ts" file that actually exists) rather than from the
// packages' own tsc `dist/` output. That means this script doesn't need
// core/server built first -- only web/dist, which it builds itself -- so it
// can never ship a stale bundle regardless of what already happened to be in
// dist/ when it ran.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const repoRoot = path.resolve(cliRoot, "../..");

const distDir = path.join(cliRoot, "dist");
const webDistOut = path.join(cliRoot, "web-dist");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  rmrf(dest);
  fs.cpSync(src, dest, { recursive: true });
}

console.log("[cli build] building packages/web...");
execSync("pnpm --filter @reviewer/web build", { cwd: repoRoot, stdio: "inherit" });

rmrf(distDir);
fs.mkdirSync(distDir, { recursive: true });

// @reviewer/core is resolved by esbuild the normal node_modules way from
// packages/server/src (its own workspace dependency), which would otherwise
// pull in core's tsc dist/ output and require it to be pre-built. Aliasing
// it to the TS source keeps this script's only prerequisite "web is built".
const coreAlias = { "@reviewer/core": path.join(repoRoot, "packages/core/src/index.ts") };

// Some bundled dependencies (commander, and a few of the server's) are CJS and
// call require("node:events") etc. In an ESM bundle esbuild turns those into a
// `__require` shim that throws "Dynamic require of X is not supported" unless
// a real `require` is in scope -- so give the bundle one. The package is
// "type": "module" and bin/purview.js import()s dist/server.js, so the output
// stays ESM rather than switching to CJS.
const requireBanner =
  'import { createRequire as __purviewCreateRequire } from "node:module";\n' +
  "const require = __purviewCreateRequire(import.meta.url);";

const sharedOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir: distDir,
  alias: coreAlias,
  banner: { js: requireBanner },
  logLevel: "info",
};

console.log("[cli build] bundling server entry -> dist/server.js");
await esbuild.build({
  ...sharedOptions,
  entryPoints: { server: path.join(cliRoot, "src/entry.ts") },
});

console.log("[cli build] bundling core CLI -> dist/reviewer-state.js");
await esbuild.build({
  ...sharedOptions,
  entryPoints: { "reviewer-state": path.join(repoRoot, "packages/core/src/cli.ts") },
});

console.log("[cli build] copying skills/pr-review -> dist/skill");
copyDir(path.join(repoRoot, "skills/pr-review"), path.join(distDir, "skill"));

console.log("[cli build] copying packages/web/dist -> web-dist");
copyDir(path.join(repoRoot, "packages/web/dist"), webDistOut);

console.log("[cli build] done");
