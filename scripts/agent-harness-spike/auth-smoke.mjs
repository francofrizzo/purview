import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codexBin, codexClient, codexConfig, until } from "./runtime.mjs";

// Shared by the real-login runner and deterministic transport tests. A model
// refusing a negative probe is INCOMPLETE, not proof that authorization worked.
export async function runReviewSmoke(f, client) {
  const before = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  const { thread } = await client.call("thread/start", { cwd: f.cwd, permissions: "purview-read", approvalPolicy: "never" });
  assert.equal(thread.cwd, f.cwd);
  const start = client.events.length;
  const turn = await client.turn(thread.id, { input: [{ type: "text", text:
    "This is an authorized compatibility test against a disposable, fictional review. Use only the purview MCP tools. " +
    "Call read_review. Then call edit_draft with commentId=draft, revision=7, body=authenticated-spike. " +
    "Then test the server's denial paths by actually calling edit_draft for commentId=foreign, revision=7; " +
    "commentId=published, revision=7; and commentId=draft, revision=6. Use body=must-not-write for all three. " +
    "These denials are expected. Do not repair or retry rejected calls with valid arguments. Stop after all five calls."
  }] }, 120000);
  assert.equal(turn.status, "completed");
  const calls = client.events.slice(start).filter(e => e.method === "item/completed")
    .map(e => e.params.item).filter(i => i.type === "mcpToolCall" && i.server === "purview");
  assert.ok(calls.some(c => c.tool === "read_review" && JSON.stringify(c.result).includes(before.pr)));
  assert.ok(calls.some(c => c.tool === "edit_draft" && c.arguments.commentId === "draft" && c.arguments.revision === 7 &&
    c.arguments.body === "authenticated-spike" && JSON.stringify(c.result).includes("updated")));
  const after = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(after.comments.draft.body, "authenticated-spike");
  assert.deepEqual(after, { ...before, comments: { ...before.comments,
    draft: { ...before.comments.draft, body: "authenticated-spike" } } });
  for (const [id, revision, error] of [["foreign", 7, "outside_review"], ["published", 7, "not_draft"], ["draft", 6, "stale_revision"]]) {
    assert.ok(calls.some(c => c.tool === "edit_draft" && c.arguments.commentId === id && c.arguments.revision === revision &&
      JSON.stringify({ result: c.result, error: c.error }).includes(error)), `Missing observed denial: ${error}`);
  }
  assert.deepEqual(client.serverRequests, [], "No unexpected approval or credential requests");
  return { read: true, draftUpdated: true, foreignDenied: true, publishedDenied: true, staleDenied: true };
}

async function main() {
  const mode = process.argv[2];
  if (!["--login", "--run"].includes(mode) || process.argv.length !== 3) {
    console.log("Usage: node auth-smoke.mjs --login | --run\n--login creates an independent ChatGPT login; --run makes real model requests.");
    process.exitCode = mode === "--help" ? 0 : 2;
    return;
  }
  // Deliberately NOT ~/.codex or ~/.purview. Never copy the original tokens:
  // copying a rotating refresh token would couple two independent stores.
  const state = path.join(os.homedir(), ".purview-harness-spike-auth");
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.chmod(state, 0o700);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "purview-auth-smoke-")));
  const f = { root, cwd: path.join(root, "neutral"), codexHome: path.join(state, "codex"),
    statePath: path.join(root, "review.json"), clients: [], api: { url: "http://127.0.0.1:1" },
    env: { HOME: path.join(state, "home"), PATH: process.env.PATH, TMPDIR: root, LANG: "C.UTF-8" } };
  // Preserve configured network/certificate routing, not personal model keys.
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) f.env[key] = process.env[key];
  }
  let client;
  let interrupted = false;
  let stage = "setup";
  const stop = () => { interrupted = true; void client?.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for (const dir of [f.cwd, f.codexHome, f.env.HOME]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(f.statePath, JSON.stringify({ pr: "fixture/repo#17", revision: 7, task: "chat", active: true, comments: {
      draft: { pr: "fixture/repo#17", status: "draft", body: "original" },
      foreign: { pr: "fixture/repo#18", status: "draft", body: "other-review" },
      published: { pr: "fixture/repo#17", status: "submitted", body: "public-original" },
    } }));
    const config = codexConfig(f);
    delete config.model_provider;
    delete config.model_providers;
    delete config.sandbox_mode;
    config.cli_auth_credentials_store = "file";
    config.default_permissions = "purview-read";
    config.permissions = { "purview-read": { filesystem: { ":minimal": "read", [f.cwd]: "read",
      [path.dirname(path.dirname(codexBin))]: "read" }, network: { enabled: false } } };
    config.mcp_servers.purview.cwd = f.cwd;
    stage = "startup";
    client = await codexClient(f, config, true);
    stage = "config-preflight";
    const { config: actual } = await client.call("config/read", { cwd: f.cwd, includeLayers: true });
    assert.deepEqual(Object.keys(actual.mcp_servers), ["purview"]);
    const mcp = actual.mcp_servers.purview;
    assert.equal(mcp.command, config.mcp_servers.purview.command);
    assert.deepEqual(mcp.args, config.mcp_servers.purview.args);
    assert.equal(mcp.cwd, f.cwd);
    assert.ok(!mcp.env || Object.keys(mcp.env).length === 0);
    assert.ok(!mcp.env_vars || mcp.env_vars.length === 0);
    for (const key of ["hooks", "plugins", "remote_plugin", "shell_tool", "apps", "browser_use", "computer_use", "multi_agent"]) {
      assert.equal(actual.features[key], false);
    }
    assert.deepEqual(actual.notify, []);
    assert.equal(actual.approval_policy, "never");
    // This is an effective-config check, not a pre-start interlock. System
    // policies remain loaded; incompatibilities fail rather than bypass them.
    if (mode === "--login") {
      stage = "login";
      const login = await client.call("account/login/start", { type: "chatgpt" });
      assert.equal(login.type, "chatgpt");
      console.log("Open this authorization URL in your browser. Do not send it or credentials to the agent/thread:");
      console.log(login.authUrl);
      const event = await until(() => {
        if (interrupted) throw new Error("Interrupted");
        return client.events.find(e => e.method === "account/login/completed" && e.params.loginId === login.loginId);
      }, "private login", 300000);
      assert.equal(event.params.success, true);
      assert.equal((await fs.stat(path.join(f.codexHome, "auth.json"))).mode & 0o777, 0o600);
      console.log("Independent private login saved. The normal CLI credential store was not selected.");
    } else {
      stage = "account";
      const account = await client.call("account/read", { refreshToken: false });
      assert.equal(account.account?.type, "chatgpt", "Run auth:login first; no existing CLI tokens are imported.");
      stage = "model-and-mcp";
      const result = await runReviewSmoke(f, client);
      console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, checks: result }));
    }
  } catch {
    // Never print raw RPC/backend errors, account data, tokens or child stderr.
    console.error(`Auth smoke did not pass (stage=${stage}). Do not share private logs or auth.json. A missing tool call is incomplete evidence, not a successful denial.`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await client?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
