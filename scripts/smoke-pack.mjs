#!/usr/bin/env node
// End-to-end proof that the published tarball actually works as `npx
// @francofrizzo/purview`, without ever touching npm login/publish: build,
// `npm pack` the cli package, install the tarball into a throwaway temp dir
// (so it's exercised the way a real user's `npx` install would be, not via
// the workspace symlinks pnpm gives every other check in this repo), start
// it against a scratch state dir and a non-default port, and confirm it
// serves. Exits non-zero on any failure; always cleans up after itself.
//
// Uses PURVIEW_PORT=4881 -- never 4779, which the maintainer runs a real dev
// server on.
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(repoRoot, "packages/cli");
const PORT = 4881;

/** All cleanup callbacks, run in reverse registration order, always. */
const cleanups = [];
function onCleanup(fn) {
  cleanups.push(fn);
}
async function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      await fn();
    } catch (err) {
      console.error("[smoke:pack] cleanup step failed (continuing):", err);
    }
  }
}

function step(msg) {
  console.log(`\n[smoke:pack] ${msg}`);
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/prs`);
      return res;
    } catch {
      if (Date.now() > deadline) throw new Error(`nothing answered on :${port} within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function main() {
  step("building @francofrizzo/purview (web build + esbuild bundle)");
  execFileSync("pnpm", ["--filter", "@francofrizzo/purview", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  step("npm pack");
  // --pack-destination so the tarball lands somewhere we control and clean up,
  // not scattered into packages/cli itself.
  const packOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "purview-pack-"));
  onCleanup(() => fs.rmSync(packOutDir, { recursive: true, force: true }));
  const packJson = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packOutDir],
    { cwd: cliDir, encoding: "utf8" },
  );
  const [packInfo] = JSON.parse(packJson);
  const tarball = path.join(packOutDir, packInfo.filename);
  if (!fs.existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);
  console.log(`[smoke:pack] packed ${packInfo.filename} (${packInfo.size} bytes)`);

  step("installing the tarball into a fresh temp dir");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "purview-install-"));
  onCleanup(() => fs.rmSync(installDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "purview-smoke-install", private: true, version: "0.0.0" }, null, 2),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: installDir,
    stdio: "inherit",
  });

  const bin = path.join(installDir, "node_modules", ".bin", "purview");
  if (!fs.existsSync(bin)) throw new Error(`expected bin at ${bin} after install`);

  step(`starting purview on :${PORT} (non-TTY stdin, onboarding must skip silently)`);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "purview-state-"));
  onCleanup(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const child = spawn(bin, [], {
    cwd: installDir,
    env: {
      ...process.env,
      PURVIEW_STATE_DIR: stateDir,
      PURVIEW_NO_WATCH: "1",
      PURVIEW_PORT: String(PORT),
    },
    // stdin explicitly not a TTY (piped from /dev/null): this is exactly the
    // condition shouldOnboard() treats as "never block on a prompt".
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  onCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  const earlyExit = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, sig })));

  step("waiting for it to answer /api/prs");
  const res = await Promise.race([
    waitForPort(PORT, 20_000),
    earlyExit.then((r) => {
      throw new Error(
        `purview exited early (code=${r.code} sig=${r.sig})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }),
  ]);

  if (res.status !== 200) {
    throw new Error(`GET /api/prs -> ${res.status}, expected 200. Body: ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`GET /api/prs content-type "${contentType}", expected application/json`);
  }
  const body = await res.json();
  if (!body || !Array.isArray(body.prs)) {
    throw new Error(`GET /api/prs body did not look like {prs: []}: ${JSON.stringify(body)}`);
  }

  console.log(`[smoke:pack] GET /api/prs -> 200 JSON, prs: ${body.prs.length}`);
  console.log("[smoke:pack] PASS");
}

try {
  await main();
} catch (err) {
  console.error("\n[smoke:pack] FAIL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await runCleanups();
}
