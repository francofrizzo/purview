import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { provider } from "./provider.mjs";
import { runReviewSmoke } from "./auth-smoke.mjs";
import { codexBin, codexClient, codexConfig, claudeQuery, claudeTurn, nodeRuntimeReadRoots, until } from "./runtime.mjs";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "purview-agent-spike-")));
  const f = {
    root, cwd: path.join(root, "checkout"), codexHome: path.join(root, "codex"),
    claudeHome: path.join(root, "claude"), statePath: path.join(root, "review.json"),
    env: { HOME: root, PATH: process.env.PATH, TMPDIR: root, LANG: "C.UTF-8",
      // Codex can prepare plugin marketplaces even with activation disabled.
      // This is fixture containment, NOT a Codex production permission control.
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.allow", GIT_CONFIG_VALUE_0: "never" },
    api: await provider(), clients: [],
    read: async () => JSON.parse(await fs.readFile(f.statePath, "utf8")),
    write: state => fs.writeFile(f.statePath, JSON.stringify(state)),
  };
  Object.assign(f.env, { HTTPS_PROXY: f.api.url, HTTP_PROXY: f.api.url, NO_PROXY: "127.0.0.1,localhost" });
  t.after(async () => {
    for (const client of f.clients) await client.close();
    await f.api.close();
    // An aborted Claude Code child still writes its MCP shutdown log under
    // the fixture HOME a moment after `abort()` returns. Wait for every
    // child of this process to be gone before the directory is removed, and
    // fail loudly if one lingers: a leftover would be invisible otherwise.
    await until(() => children().length === 0, "fixture children to exit", 10000);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  for (const dir of [f.cwd, f.codexHome, f.claudeHome]) await fs.mkdir(dir);
  await f.write({ pr: "fixture/repo#17", revision: 7, task: "chat", active: true, comments: {
    draft: { pr: "fixture/repo#17", status: "draft", body: "original" },
    foreign: { pr: "fixture/repo#18", status: "draft", body: "other-review" },
    published: { pr: "fixture/repo#17", status: "submitted", body: "public-original" },
  } });
  return f;
}

/** Resolves once `read()` has not changed for `ms`; bounded by `until`'s timeout. */
async function quiet(read, ms) {
  let last = read();
  let since = Date.now();
  await until(() => {
    const now = read();
    if (now !== last) { last = now; since = Date.now(); }
    return Date.now() - since >= ms;
  }, "egress to settle");
}

/** Live child processes of the test process, by pid. */
function children() {
  const out = spawnSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
  return out.stdout.split("\n").filter(Boolean);
}

function catalog(request) {
  const tools = request.body.tools ?? request.body.input?.find(i => i.type === "additional_tools")?.tools ?? [];
  return tools.flatMap(t => t.type === "namespace"
    ? t.tools.map(x => `${t.name}.${x.name}`) : [t.name ?? t.type]);
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function authorizationCases(t, f, turn) {
  await t.test("read and write cross the real MCP transport", async () => {
    f.api.plan([{ tool: "read_review", args: {} }, { tool: "edit_draft", args: { commentId: "draft", revision: 7, body: "allowed-update" } }]);
    const start = f.api.requests.length;
    await turn();
    assert.equal((await f.read()).comments.draft.body, "allowed-update");
    const transcript = JSON.stringify(f.api.requests.slice(start).map(r => r.body.messages ?? r.body.input));
    assert.ok(transcript.includes("fixture/repo#17"), "read result must reach the next model request");
    assert.ok(transcript.includes('updated'), "mutation result must reach the next model request");
  });

  for (const [label, args, error] of [
    ["foreign review", { commentId: "foreign", revision: 7, body: "must-not-write" }, "outside_review"],
    ["submitted comment", { commentId: "published", revision: 7, body: "must-not-write" }, "not_draft"],
    ["stale revision", { commentId: "draft", revision: 6, body: "must-not-write" }, "stale_revision"],
  ]) await t.test(`rejects ${label} without mutation`, async () => {
    const before = await f.read();
    const start = f.api.requests.length;
    f.api.plan([{ tool: "edit_draft", args }]);
    await turn();
    assert.deepEqual(await f.read(), before);
    const transcript = JSON.stringify(f.api.requests.slice(start).map(r => r.body.messages ?? r.body.input));
    assert.ok(transcript.includes(error), `handler denial ${error} must reach the harness`);
  });

  for (const [label, change, error] of [
    ["operation not granted to analysis", { task: "analysis" }, "operation_not_granted"],
    ["revoked run", { active: false }, "revoked"],
  ]) await t.test(`rechecks ${label} on an existing session`, async () => {
    const before = { ...await f.read(), ...change };
    await f.write(before);
    const start = f.api.requests.length;
    f.api.plan([{ tool: "edit_draft", args: { commentId: "draft", revision: 7, body: "must-not-write" } }]);
    await turn();
    assert.deepEqual(await f.read(), before);
    assert.ok(JSON.stringify(f.api.requests.slice(start).map(r => r.body.messages ?? r.body.input)).includes(error));
    await f.write({ ...before, task: "chat", active: true });
  });
}

test("Claude 2.1.305: tool-only sessions and scoped operations", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  // Deliberately permissive personal/project settings must not widen this run.
  await fs.writeFile(path.join(f.claudeHome, "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" }, env: { SPIKE_AMBIENT: "ambient-setting" } }));
  await fs.mkdir(path.join(f.cwd, ".claude"));
  await fs.writeFile(path.join(f.cwd, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
  await fs.writeFile(path.join(f.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { ambient: { command: "/definitely-not-a-real-program" } } }));
  let session;
  async function turn() {
    const events = await claudeTurn(f, session);
    const init = events.find(e => e.type === "system" && e.subtype === "init");
    assert.equal(init.claude_code_version, "2.1.305");
    assert.equal(init.permissionMode, "dontAsk");
    if (session) assert.equal(init.session_id, session);
    session = init.session_id;
    const result = events.findLast(e => e.type === "result");
    assert.equal(result.is_error, false, JSON.stringify(result));
    return events;
  }
  await authorizationCases(t, f, turn);
  await t.test("only the two owned tools reach the model", async () => {
    for (const req of f.api.requests) assert.deepEqual(catalog(req).sort(), ["mcp__purview__edit_draft", "mcp__purview__read_review"]);
  });
  await t.test("a forged native shell call cannot create a file", async () => {
    f.api.plan([{ forceTool: "Bash", args: { command: `echo escaped > ${path.join(f.cwd, "escaped")}` } }]);
    await turn();
    await assert.rejects(fs.access(path.join(f.cwd, "escaped")), { code: "ENOENT" });
    assert.ok(JSON.stringify(f.api.requests.at(-1).body.messages).match(/not available|unknown tool|no such tool/i));
  });
  await t.test("abort ends a turn stalled at the model transport", async () => {
    const start = f.api.requests.length;
    f.api.plan([{ hold: true }]);
    const abort = new AbortController();
    const q = claudeQuery(f, session, abort);
    const drained = (async () => { try { for await (const e of q) { /* drain */ } } catch (error) { return error; } })();
    try {
      await until(() => f.api.requests.length > start, "Claude request before abort");
      const before = await f.read();
      const time = Date.now();
      abort.abort();
      const error = await drained;
      t.diagnostic(`abort result: ${error?.name}: ${error?.message}`);
      assert.ok(Date.now() - time < 5000);
      assert.equal(f.api.requests.length, start + 1);
      assert.deepEqual(await f.read(), before);
    } finally { q.close(); }
  });
});

test("Codex 0.163.0: app-server, MCP and resumed authority", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  let client = await codexClient(f);
  const started = await client.call("thread/start", { cwd: f.cwd, model: "gpt-6.1-sol", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only" });
  const id = started.thread.id;
  async function turn() {
    const result = await client.turn(id);
    assert.equal(result.status, "completed", JSON.stringify(result));
  }
  await authorizationCases(t, f, turn);
  await t.test("reopens persisted thread in a fresh app-server process", async () => {
    await client.close();
    client = await codexClient(f);
    const resumed = await client.call("thread/resume", { threadId: id });
    assert.equal(resumed.thread.id, id);
    f.api.plan([{ tool: "read_review", args: {} }]);
    await turn();
    const output = f.api.requests.at(-1).body.input.findLast(i => i.type === "function_call_output");
    assert.ok(JSON.stringify(output).includes("fixture/repo#17"));
  });
  await t.test("top-level catalog excludes shell, search and agents but retains Code Mode", () => {
    const names = catalog(f.api.requests[0]);
    t.diagnostic(`model tool inventory: ${JSON.stringify(names)}`);
    for (const forbidden of ["exec_command", "shell", "shell_command", "write_stdin", "web_search", "spawn_agent", "view_image"]) assert.ok(!names.includes(forbidden));
    assert.ok(names.some(n => n.endsWith(".edit_draft")));
    assert.deepEqual(client.serverRequests, [], "owned MCP calls must work without approval callbacks");
  });
  await t.test("nested Code Mode patch cannot write the checkout", async () => {
    const patch = `*** Begin Patch\n*** Add File: ${path.join(f.cwd, "escaped")}\n+escaped\n*** End Patch`;
    f.api.plan([{ tool: "exec", customInput: `text(await tools.apply_patch(${JSON.stringify(patch)}));` }]);
    await turn();
    await assert.rejects(fs.access(path.join(f.cwd, "escaped")), { code: "ENOENT" });
    const output = JSON.stringify(f.api.requests.at(-1).body.input.findLast(i => i.type === "custom_tool_call_output"));
    assert.match(output, /reject|denied|not.*allow|read.only|permission/i);
    assert.doesNotMatch(output, /unknown tool|unrecognized tool|unsupported tool/i);
    t.diagnostic(`nested patch result: ${output}`);
  });
  await t.test("Code Mode reports its nested tool inventory and absent ambient APIs", async () => {
    f.api.plan([{ tool: "exec", customInput: 'text({apis:{fetch:typeof fetch,process:typeof process,require:typeof require},names:ALL_TOOLS.map(t=>t.name)});' }]);
    await turn();
    const output = JSON.stringify(f.api.requests.at(-1).body.input.findLast(i => i.type === "custom_tool_call_output"));
    assert.match(output, /fetch.*undefined/);
    assert.match(output, /process.*undefined/);
    assert.match(output, /require.*undefined/);
    assert.match(output, /apply_patch/);
    assert.doesNotMatch(output, /exec_command|shell_command|spawn_agent|web_search/);
    t.diagnostic(`Code Mode surface: ${output}`);
  });
  await t.test("interrupt completes a stalled turn as interrupted", async () => {
    f.api.plan([{ hold: true }]);
    const start = f.api.requests.length;
    const { turn: pending } = await client.call("turn/start", { threadId: id, input: [{ type: "text", text: "Wait for fixture" }] });
    await until(() => f.api.requests.length > start, "Codex request before interrupt");
    await client.call("turn/interrupt", { threadId: id, turnId: pending.id });
    const done = await until(() => client.events.find(e => e.method === "turn/completed" && e.params.turn.id === pending.id), "interrupted turn");
    assert.equal(done.params.turn.status, "interrupted");
  });
});

test("Codex sandbox: effects, positive controls, and restricted-read limitation", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const client = await codexClient(f);
  const outside = path.join(f.root, "outside.txt");
  await fs.writeFile(outside, "outside-root-sentinel");
  await fs.symlink(outside, path.join(f.cwd, "outside-link"));
  async function exec(command, sandboxPolicy = { type: "readOnly" }) {
    return client.call("command/exec", { command, cwd: f.cwd, sandboxPolicy, timeoutMs: 5000 });
  }
  const write = ["/bin/sh", "-c", "printf changed > effect"];
  const denied = await exec(write);
  assert.notEqual(denied.exitCode, 0);
  await assert.rejects(fs.access(path.join(f.cwd, "effect")), { code: "ENOENT" });
  const control = await exec(write, { type: "workspaceWrite", writableRoots: [f.cwd], excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false });
  assert.equal(control.exitCode, 0, JSON.stringify(control));
  assert.equal(await fs.readFile(path.join(f.cwd, "effect"), "utf8"), "changed");

  const probe = [process.execPath, "-e", `fetch(${JSON.stringify(f.api.url)}).then(()=>process.exit(0),()=>process.exit(7))`];
  assert.equal((await exec(probe, { type: "readOnly", networkAccess: true })).exitCode, 0);
  assert.notEqual((await exec(probe)).exitCode, 0);

  // Current published docs use an obsolete shape. Verify rejection, not a
  // successful parse or an assumed silently ignored access restriction.
  const restricted = { type: "readOnly", access: { type: "restricted", includePlatformDefaults: true, readableRoots: [f.cwd] } };
  await assert.rejects(exec(["/bin/cat", outside], restricted), /readOnly.access is no longer supported/);
  const direct = await exec(["/bin/cat", outside]);
  const symlink = await exec(["/bin/cat", path.join(f.cwd, "outside-link")]);
  assert.equal(direct.stdout, "outside-root-sentinel");
  assert.equal(symlink.stdout, "outside-root-sentinel");
  t.diagnostic("LIMITATION: legacy readOnly allows outside-root reads; readOnly.access is rejected, not enforced");
  const schemaDir = path.join(f.root, "schema");
  execFileSync(codexBin, ["app-server", "generate-json-schema", "--out", schemaDir], { env: f.env, stdio: "pipe" });
  const schema = await fs.readFile(path.join(schemaDir, "v2/CommandExecParams.json"), "utf8");
  assert.ok(!schema.includes("readableRoots"));
});

test("Codex configuration: startup overrides do not eliminate inherited tools", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.codexHome, "config.toml"), `[mcp_servers.ambient]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([path.join(import.meta.dirname, "review-fixture.mjs"), f.statePath])}\n`);
  const client = await codexClient(f, codexConfig(f));
  const { thread } = await client.call("thread/start", { cwd: f.cwd, model: "gpt-6.1-sol", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only" });
  assert.equal((await client.turn(thread.id)).status, "completed");
  const status = await client.call("mcpServerStatus/list", {});
  assert.ok(status.data.some(s => s.name === "ambient" && s.tools.read_review));
  t.diagnostic("BLOCKER: runtime mcp_servers overrides merge with user config; ambient MCP server starts and connects");
});

test("Codex named permission profile confines direct and symlink reads", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const config = codexConfig(f);
  delete config.sandbox_mode;
  config.default_permissions = "purview-read";
  config.permissions = { "purview-read": { filesystem: { ":minimal": "read", [f.cwd]: "read" }, network: { enabled: false } } };
  // The sandbox re-execs Codex's own bundled helper before running cat.
  config.permissions["purview-read"].filesystem[path.dirname(path.dirname(codexBin))] = "read";
  const client = await codexClient(f, config, true);
  const outside = path.join(f.root, "outside.txt");
  await fs.writeFile(outside, "outside-root-sentinel");
  const inside = path.join(f.cwd, "inside.txt");
  await fs.writeFile(inside, "inside-root-sentinel");
  await fs.symlink(outside, path.join(f.cwd, "link"));
  const exec = command => client.call("command/exec", { command, cwd: f.cwd, permissionProfile: "purview-read", timeoutMs: 5000 });
  const allowed = await exec(["/bin/cat", inside]);
  assert.equal(allowed.exitCode, 0, JSON.stringify(allowed));
  assert.equal(allowed.stdout, "inside-root-sentinel");
  for (const target of [outside, path.join(f.cwd, "link")]) {
    const denied = await exec(["/bin/cat", target]);
    assert.notEqual(denied.exitCode, 0);
    assert.ok(!denied.stdout.includes("outside-root-sentinel"));
  }
});

test("Codex model turns enforce a named profile, including after cold resume", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const neutral = path.join(f.root, "neutral");
  await fs.mkdir(neutral);
  f.launchCwd = neutral;
  const config = codexConfig(f);
  delete config.sandbox_mode;
  config.default_permissions = "purview-read";
  config.allow_login_shell = false;
  // Deliberately expose shell here: hiding it would not test enforcement.
  config.features.shell_tool = true;
  config.permissions = {
    "purview-read": { filesystem: { ":minimal": "read", [neutral]: "read", [f.cwd]: "read",
      [path.dirname(path.dirname(codexBin))]: "read", ...Object.fromEntries(nodeRuntimeReadRoots().map(root => [root, "read"])) },
      network: { enabled: false } },
    "probe-control": { filesystem: { ":root": "read", [f.cwd]: "write" }, network: { enabled: true } },
  };
  let client = await codexClient(f, config, true);
  const started = await client.call("thread/start", { cwd: neutral, permissions: "purview-read", approvalPolicy: "never" });
  assert.equal(started.activePermissionProfile.id, "purview-read");
  const id = started.thread.id;
  const inside = path.join(f.cwd, "inside.txt");
  const outside = path.join(f.root, "outside.txt");
  await fs.writeFile(inside, "inside-model-sentinel");
  await fs.writeFile(outside, "outside-model-sentinel");
  await fs.symlink(outside, path.join(f.cwd, "link"));
  async function shell(command, permissions) {
    const args = { cmd: command, login: false, max_output_tokens: 1000 };
    f.api.plan([{ tool: "exec", customInput: `text(await tools.exec_command(${JSON.stringify(args)}));` }]);
    const done = await client.turn(id, permissions ? { permissions } : {});
    assert.equal(done.status, "completed", JSON.stringify(done));
    const output = f.api.requests.at(-1).body.input.findLast(i => i.type === "custom_tool_call_output");
    return JSON.parse(output.output.at(-1).text);
  }
  await t.test("normal model shell can read inside the allowed root", async () => {
    const result = await shell(`/bin/cat ${quote(inside)}`);
    assert.equal(result.exit_code, 0);
    assert.equal(result.output, "inside-model-sentinel");
  });
  await t.test("outside and symlink reads fail through the model tool", async () => {
    for (const file of [outside, path.join(f.cwd, "link")]) {
      const result = await shell(`/bin/cat ${quote(file)}`);
      assert.notEqual(result.exit_code, 0);
      assert.doesNotMatch(result.output, /outside-model-sentinel/);
    }
  });
  await t.test("turn selector has positive controls for reads, writes and network", async () => {
    const read = await shell(`/bin/cat ${quote(outside)}`, "probe-control");
    assert.equal(read.exit_code, 0);
    assert.equal(read.output, "outside-model-sentinel");
    const command = `printf effect > ${quote(path.join(f.cwd, "effect"))}`;
    assert.equal((await shell(command, "probe-control")).exit_code, 0);
    assert.equal(await fs.readFile(path.join(f.cwd, "effect"), "utf8"), "effect");
    await fs.rm(path.join(f.cwd, "effect"));
    assert.notEqual((await shell(command, "purview-read")).exit_code, 0);
    await assert.rejects(fs.access(path.join(f.cwd, "effect")), { code: "ENOENT" });
    const code = `fetch(${JSON.stringify(f.api.url)}).then(()=>console.log('network-reached'),()=>console.log('network-blocked'))`;
    const network = `${quote(process.execPath)} -e ${quote(code)}`;
    const allowed = await shell(network, "probe-control");
    assert.equal(allowed.exit_code, 0);
    assert.equal(allowed.output, "network-reached\n");
    const denied = await shell(network, "purview-read");
    assert.equal(denied.exit_code, 0);
    assert.equal(denied.output, "network-blocked\n");
  });
  await t.test("nested patch remains denied under the named profile", async () => {
    const patch = `*** Begin Patch\n*** Add File: ${path.join(f.cwd, "escaped")}\n+escaped\n*** End Patch`;
    f.api.plan([{ tool: "exec", customInput: `text(await tools.apply_patch(${JSON.stringify(patch)}));` }]);
    assert.equal((await client.turn(id)).status, "completed");
    await assert.rejects(fs.access(path.join(f.cwd, "escaped")), { code: "ENOENT" });
    const output = JSON.stringify(f.api.requests.at(-1).body.input.findLast(i => i.type === "custom_tool_call_output"));
    assert.match(output, /patch rejected/);
  });
  await t.test("cold resume restores the restricted selection and enforces it", async () => {
    await client.close();
    client = await codexClient(f, config, true);
    const resumed = await client.call("thread/resume", { threadId: id });
    assert.equal(resumed.activePermissionProfile.id, "purview-read");
    assert.equal(resumed.thread.cwd, neutral);
    const insideResult = await shell(`/bin/cat ${quote(inside)}`);
    assert.equal(insideResult.exit_code, 0);
    assert.equal(insideResult.output, "inside-model-sentinel");
    const outsideResult = await shell(`/bin/cat ${quote(outside)}`);
    assert.notEqual(outsideResult.exit_code, 0);
    assert.doesNotMatch(outsideResult.output, /outside-model-sentinel/);
    assert.deepEqual(client.serverRequests, []);
  });
});

test("Codex private home plus neutral cwd avoids planted user and project MCP startup", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const personal = path.join(f.root, "personal-codex");
  const neutral = path.join(f.root, "neutral");
  await fs.mkdir(personal);
  await fs.mkdir(neutral);
  await fs.mkdir(path.join(f.cwd, ".git"));
  await fs.mkdir(path.join(f.cwd, ".codex"));
  const projectMarker = path.join(f.root, "project-started");
  const userMarker = path.join(f.root, "user-started");
  function plantedConfig(name, marker) {
    const command = `printf started > ${quote(marker)}; exec ${quote(process.execPath)} ${quote(path.join(import.meta.dirname, "review-fixture.mjs"))} ${quote(f.statePath)}`;
    return `[mcp_servers.${name}]\ncommand = "/bin/sh"\nargs = ${JSON.stringify(["-c", command])}\n`;
  }
  await fs.writeFile(path.join(personal, "config.toml"), plantedConfig("personal", userMarker));
  await fs.writeFile(path.join(f.cwd, ".codex/config.toml"), plantedConfig("project", projectMarker));
  const config = codexConfig(f);
  // Make the hostile project trusted: an untrusted, skipped config is not
  // a useful positive control for discovery and server startup.
  config.projects = { [f.cwd]: { trust_level: "trusted" } };
  await t.test("positive control actually starts both planted servers", async () => {
    const client = await codexClient({ ...f, codexHome: personal }, config);
    const { thread } = await client.call("thread/start", { cwd: f.cwd });
    assert.equal((await client.turn(thread.id)).status, "completed");
    assert.equal(await fs.readFile(userMarker, "utf8"), "started");
    assert.equal(await fs.readFile(projectMarker, "utf8"), "started");
    await client.close();
    await fs.rm(userMarker);
    await fs.rm(projectMarker);
  });
  await t.test("controlled startup and thread cwd do not start those servers", async () => {
    const client = await codexClient({ ...f, launchCwd: neutral }, config);
    const read = await client.call("config/read", { cwd: neutral, includeLayers: true });
    assert.deepEqual(Object.keys(read.config.mcp_servers), ["purview"]);
    assert.equal(read.config.features.hooks, false);
    assert.deepEqual(read.config.notify, []);
    assert.equal(read.config.plugins._default.enabled, false);
    assert.equal(read.config.features.plugins, false);
    assert.equal(read.config.features.remote_plugin, false);
    assert.equal(read.config.orchestrator.mcp.enabled, false);
    const { thread } = await client.call("thread/start", { cwd: neutral });
    f.api.plan([{ tool: "read_review", args: {} }]);
    assert.equal((await client.turn(thread.id)).status, "completed");
    const status = await client.call("mcpServerStatus/list", {});
    assert.deepEqual(status.data.map(s => s.name), ["purview"]);
    for (const marker of [userMarker, projectMarker]) await assert.rejects(fs.access(marker), { code: "ENOENT" });
    assert.ok(!JSON.stringify(read.layers).includes(path.join(f.cwd, ".codex")));
  });
});

test("Codex private auth store: public API login, restart and original-store isolation", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const original = path.join(f.root, ".codex");
  await fs.mkdir(original);
  const originalAuth = JSON.stringify({ OPENAI_API_KEY: "original-fixture-key-not-a-secret" });
  const originalConfig = "notify = [\"/not/a/program\"]\n";
  await fs.writeFile(path.join(original, "auth.json"), originalAuth, { mode: 0o600 });
  await fs.writeFile(path.join(original, "config.toml"), originalConfig);
  const config = codexConfig(f);
  config.cli_auth_credentials_store = "file";
  config.model_providers.fixture.requires_openai_auth = true;
  delete config.sandbox_mode;
  config.default_permissions = "purview-read";
  config.permissions = { "purview-read": { filesystem: { ":minimal": "read", [f.cwd]: "read",
    [path.dirname(path.dirname(codexBin))]: "read" }, network: { enabled: false } } };
  let client = await codexClient(f, config, true);
  await t.test("does not pick up original credentials and does not leak account errors", async () => {
    const account = await client.call("account/read", { refreshToken: false });
    assert.equal(account.account, null);
    const restricted = await codexClient(f, { ...config, forced_login_method: "chatgpt" });
    await assert.rejects(restricted.call("account/login/start", { type: "apiKey", apiKey: "must-not-be-persisted" }), /Account RPC failed/);
    await restricted.close();
    await assert.rejects(fs.access(path.join(f.codexHome, "auth.json")), { code: "ENOENT" });
  });
  await t.test("login persists only in the private file store, with private permissions", async () => {
    const result = await client.call("account/login/start", { type: "apiKey", apiKey: "private-fixture-key-not-a-secret" });
    assert.equal(result.type, "apiKey");
    const stored = JSON.parse(await fs.readFile(path.join(f.codexHome, "auth.json"), "utf8"));
    assert.equal(stored.OPENAI_API_KEY, "private-fixture-key-not-a-secret");
    assert.equal((await fs.stat(path.join(f.codexHome, "auth.json"))).mode & 0o777, 0o600);
  });
  await t.test("fresh process loads private auth and sends it only to the local model fixture", async () => {
    await client.close();
    client = await codexClient(f, config, true);
    assert.equal((await client.call("account/read", { refreshToken: false })).account.type, "apiKey");
    const { thread } = await client.call("thread/start", { cwd: f.cwd });
    f.api.plan([{ tool: "read_review", args: {} }, { tool: "edit_draft", args: { commentId: "draft", revision: 7, body: "private-auth-update" } }]);
    assert.equal((await client.turn(thread.id)).status, "completed");
    assert.equal((await f.read()).comments.draft.body, "private-auth-update");
    assert.ok(f.api.requests.length > 0);
    for (const req of f.api.requests) assert.equal(req.authorization, "Bearer private-fixture-key-not-a-secret");
  });
  await t.test("the real-login smoke validator observes all five MCP outcomes", async () => {
    f.api.plan([{ tool: "read_review", args: {} },
      { tool: "edit_draft", args: { commentId: "draft", revision: 7, body: "authenticated-spike" } },
      ...[["foreign", 7], ["published", 7], ["draft", 6]].map(([commentId, revision]) =>
        ({ tool: "edit_draft", args: { commentId, revision, body: "must-not-write" } })),
    ]);
    assert.deepEqual(await runReviewSmoke(f, client), {
      read: true, draftUpdated: true, foreignDenied: true, publishedDenied: true, staleDenied: true,
    });
  });
  await t.test("a model skipping denial probes cannot make the smoke pass", async () => {
    f.api.plan([{ tool: "read_review", args: {} },
      { tool: "edit_draft", args: { commentId: "draft", revision: 7, body: "authenticated-spike" } },
    ]);
    await assert.rejects(runReviewSmoke(f, client), /Missing observed denial/);
  });
  await t.test("logout removes only the private login", async () => {
    await client.call("account/logout", {});
    assert.equal((await client.call("account/read", { refreshToken: false })).account, null);
    assert.equal(await fs.readFile(path.join(original, "auth.json"), "utf8"), originalAuth);
    assert.equal(await fs.readFile(path.join(original, "config.toml"), "utf8"), originalConfig);
  });
});

test("Codex feature gate suppresses curated plugin preparation, including after login", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const config = codexConfig(f);
  config.cli_auth_credentials_store = "file";
  await t.test("activation deny alone still starts preparation (positive control)", async () => {
    const home = path.join(f.root, "plugins-control");
    await fs.mkdir(home);
    const control = { ...config, features: { ...config.features, plugins: true } };
    const client = await codexClient({ ...f, codexHome: home }, control);
    // Startup creates this lock before Git / HTTP fallback. The rejecting
    // proxy contains HTTP fallback; the Git transport is disabled by the fixture.
    await until(() => client.stderr().includes("curated") || f.api.egress.length > 0, "plugin startup attempt");
    await fs.access(path.join(home, ".tmp/plugins.sync.lock"));
    await client.close();
    // Preparation reaches for more than one host (chatgpt.com, then
    // github.com, ~20 ms apart on macOS) and a connect already in the proxy's
    // accept queue is still delivered after the process group is killed. Wait
    // for the control's egress to go quiet so none of it is charged to the
    // gated run below, which must observe exactly zero.
    await quiet(() => f.api.egress.length, 750);
  });
  await t.test("feature off prevents preparation across startup, login and a real harness turn", async () => {
    const start = f.api.egress.length;
    const client = await codexClient(f, config);
    await client.call("account/login/start", { type: "apiKey", apiKey: "plugin-probe-not-a-secret" });
    const { thread } = await client.call("thread/start", { cwd: f.cwd });
    assert.equal((await client.turn(thread.id)).status, "completed");
    await client.close();
    await assert.rejects(fs.access(path.join(f.codexHome, ".tmp/plugins.sync.lock")), { code: "ENOENT" });
    const entries = await fs.readdir(path.join(f.codexHome, ".tmp")).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.ok(!entries.some(name => name.startsWith("plugins")));
    await quiet(() => f.api.egress.length, 750);
    assert.deepEqual(f.api.egress.slice(start), [], "egress attempted with the plugin feature off");
  });
});
