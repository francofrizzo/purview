import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { isolatedEnv, preflight } from "./claude-auth.mjs";

test("environment contains only disposable paths and fixed noncredential values", () => {
  const env = isolatedEnv("/tmp/fixture");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "PATH", "LANG"].sort());
  for (const [key, value] of Object.entries(env)) {
    if (!["PATH", "LANG"].includes(key)) assert.ok(value.startsWith("/tmp/fixture/"));
  }
});

test("pinned real CLI reports logged out with empty Linux stores", { skip: process.platform !== "linux" }, async () => {
  assert.deepEqual(await preflight(), { sdk: "0.3.305", cli: "2.1.305", loggedIn: false,
    oauthStarted: false, modelRequested: false });
});

test("login is not an executable mode", () => {
  assert.throws(() => execFileSync(process.execPath, [new URL("./claude-auth.mjs", import.meta.url).pathname, "--login"],
    { stdio: "pipe" }), error => error.status === 2);
});
