import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

// An allowlist, not deletion of a few known token variables. No inherited PATH,
// NODE_OPTIONS, proxy, provider, profile, OAuth, helper or project configuration.
export function isolatedEnv(root) {
  return { HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: path.join(root, "config"),
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    TMPDIR: path.join(root, "tmp"), PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
}

export async function preflight() {
  // HOME alone does not isolate a macOS login keychain. Never probe a personal
  // keychain, even with auth status, from this Linux-only automated runner.
  assert.equal(process.platform, "linux", "Linux only; see claude-auth.md for the Mac handoff");
  const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(
    require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
  assert.equal(pkg.version, "0.3.305");
  assert.equal(pkg.claudeCodeVersion, "2.1.305");
  const bin = path.join(path.dirname(require.resolve(
    `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/package.json`)), "claude");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "purview-claude-auth-"));
  try {
    const env = isolatedEnv(root);
    for (const dir of Object.values(env).filter(v => v.startsWith(root))) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const options = { env, cwd: root, timeout: 30000, maxBuffer: 65536 };
    const { stdout: version } = await exec(bin, ["--version"], options);
    assert.match(version, /^2\.1\.305\b/);
    let result;
    try { result = await exec(bin, ["auth", "status", "--json"], options); }
    catch (error) {
      // auth status exits 1 when logged out. Never expose raw stdout/stderr.
      assert.equal(error.code, 1);
      result = error;
    }
    const status = JSON.parse(result.stdout);
    assert.equal(status.loggedIn, false);
    return { sdk: pkg.version, cli: pkg.claudeCodeVersion, loggedIn: false,
      oauthStarted: false, modelRequested: false };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--preflight") {
    console.error("Usage: node claude-auth.mjs --preflight (Linux, no login or model requests)");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await preflight())); }
    catch { console.error("Claude auth preflight failed; raw credential/backend output suppressed."); process.exitCode = 1; }
  }
}
