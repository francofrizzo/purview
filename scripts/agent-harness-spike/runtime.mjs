import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Resolve the same platform package as Codex's npm launcher, but spawn the
// native process so teardown reaches the actual server. POSIX probes only.
if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("The spike requires Linux or macOS, x64 or arm64; Windows probes are not implemented.");
}
const target = `${process.arch === "x64" ? "x86_64" : "aarch64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
export const codexBin = realpathSync(path.join(import.meta.dirname, `node_modules/@openai/codex-${process.platform}-${process.arch}/vendor/${target}/bin/codex`));
export const mcpBin = path.join(import.meta.dirname, "review-fixture.mjs");

/**
 * Read roots a restricted profile needs so that the Node that runs this spike
 * can start at all. On Linux the executable is enough. On macOS a packaged
 * Node (Homebrew's, for one) is dynamically linked: dyld must open
 * libnode and its dependencies, spread over several directories reached
 * through symlinks, or the process aborts (exit 134) before running any
 * JavaScript. The closure is walked with `otool -L`, resolving `@rpath`,
 * `@loader_path` and `@executable_path` the way dyld does for this binary;
 * libraries under /usr/lib and /System come from the shared cache and need
 * no grant. Each library's directory is granted both as spelled and as its
 * real path, plus the directory holding every symlink on the spelled path
 * (Homebrew's `opt/` of `opt/<pkg>` links): the sandbox canonicalizes a
 * granted root, so granting the link itself grants its target and not the
 * link, and the link can only be followed where its parent is readable.
 * Homebrew's libcrypto also opens its OPENSSLDIR config at startup and Node
 * exits 1 without it, so that directory is granted when it can be found.
 */
export function nodeRuntimeReadRoots(executable = process.execPath) {
  const exe = realpathSync(executable);
  const roots = new Set([executable, exe]);
  if (process.platform !== "darwin") return [...roots];
  const system = p => p.startsWith("/usr/lib/") || p.startsWith("/System/");
  const load = (file, flag) => execFileSync("otool", [flag, file], { encoding: "utf8" }).split("\n");
  const rpaths = file => {
    const out = [];
    const lines = load(file, "-l");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("LC_RPATH")) {
        const m = /^\s*path (\S+)/.exec(lines[i + 2] ?? "");
        if (m) out.push(m[1]);
      }
    }
    return out;
  };
  const expand = (p, loader) => p.replace("@loader_path", path.dirname(loader)).replace("@executable_path", path.dirname(exe));
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const line of load(file, "-L").slice(1)) {
      const m = /^\s+(\S+) \(/.exec(line);
      if (!m || system(m[1])) continue;
      let candidates;
      if (m[1].startsWith("@rpath/")) candidates = rpaths(file).map(r => path.join(expand(r, file), m[1].slice("@rpath/".length)));
      else candidates = [expand(m[1], file)];
      const found = candidates.find(c => existsSync(c));
      if (!found) continue;
      const real = realpathSync(found);
      if (real === file) continue;
      roots.add(path.dirname(found));
      roots.add(path.dirname(real));
      for (let dir = path.dirname(found); dir !== "/"; dir = path.dirname(dir)) {
        if (lstatSync(dir).isSymbolicLink()) roots.add(path.dirname(dir));
      }
      if (path.basename(real).startsWith("libcrypto")) {
        const openssl = path.join(path.dirname(real), "..", "bin", "openssl");
        if (existsSync(openssl)) {
          const dir = /OPENSSLDIR: "([^"]+)"/.exec(execFileSync(openssl, ["version", "-d"], { encoding: "utf8" }));
          if (dir && existsSync(dir[1])) roots.add(dir[1]);
        }
      }
      visit(real);
    }
  };
  visit(exe);
  return [...roots];
}

export function toml(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function codexConfig(fixture) {
  return {
    model: "gpt-6.1-sol", model_provider: "fixture", approval_policy: "never", sandbox_mode: "read-only",
    web_search: "disabled", notify: [],
    plugins: { _default: { enabled: false } }, orchestrator: { mcp: { enabled: false } },
    features: { shell_tool: false, view_image: false, multi_agent: false, multi_agent_v2: false,
      apps: false, browser_use: false, computer_use: false, goals: false, hooks: false,
      code_mode_only_strict_3p_tools: false,
      code_mode: { enabled: false, direct_only_tool_namespaces: ["mcp__purview"] } },
    agents: { enabled: false },
    tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
    analytics: { enabled: false },
    mcp_servers: { purview: { command: process.execPath, args: [mcpBin, fixture.statePath], required: true,
      enabled_tools: ["read_review", "edit_draft"], default_tools_approval_mode: "approve" } },
    model_providers: { fixture: { name: "Local fixture", base_url: fixture.api.url, wire_api: "responses", requires_openai_auth: false } },
  };
}

export async function until(read, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function codexClient(fixture, config = codexConfig(fixture), experimental = false) {
  const args = Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${toml(v)}`]);
  const child = spawn(codexBin, ["app-server", "--listen", "stdio://", ...args], {
    cwd: fixture.launchCwd ?? fixture.cwd, env: { ...fixture.env, CODEX_HOME: fixture.codexHome }, stdio: ["pipe", "pipe", "pipe"],
    detached: true, // Test-owned process group; never unref or leave it running.
  });
  let stderr = "";
  let serial = 0;
  let closing;
  const pending = new Map();
  const events = [];
  const serverRequests = [];
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const fail = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", code => fail(new Error(`codex exit ${code}: ${stderr}`)));
  createInterface({ input: child.stdout }).on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      events.push(message);
      if (message.id !== undefined) {
        serverRequests.push(message.method);
        // No automatic approvals or grants, including future request types.
        send({ id: message.id, error: { code: -32601, message: "Spike denies unhandled server request" } });
      }
    } else if (pending.has(message.id)) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(p.timer);
      message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
    }
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method}: ${stderr}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  const client = {
    call, events, serverRequests, stderr: () => stderr,
    async turn(threadId, overrides = {}) {
      const { turn } = await call("turn/start", { threadId, input: [{ type: "text", text: "Run the local fixture scenario." }], ...overrides });
      return (await until(() => events.find(e => e.method === "turn/completed" && e.params.turn.id === turn.id), "Codex turn")).params.turn;
    },
    async close() {
      return closing ??= (async () => {
        const stopGroup = () => {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        };
        child.stdin.end();
        const timer = setTimeout(stopGroup, 2000);
        await closed;
        clearTimeout(timer);
        stopGroup(); // Includes plugin preparation children outliving app-server.
      })();
    },
  };
  try {
    await call("initialize", { clientInfo: { name: "purview_spike", version: "0.0.0" }, capabilities: { experimentalApi: experimental } });
    send({ method: "initialized" });
    fixture.clients.push(client);
    return client;
  } catch (error) { await client.close(); throw error; }
}

export function claudeQuery(fixture, resume, abortController = new AbortController()) {
  return query({ prompt: "Run the local fixture scenario.", options: {
    cwd: fixture.cwd, resume, model: "claude-haiku-4-5", maxTurns: 4, tools: [], settingSources: [],
    strictMcpConfig: true, permissionMode: "dontAsk", abortController,
    mcpServers: { purview: { command: process.execPath, args: [mcpBin, fixture.statePath] } },
    allowedTools: ["mcp__purview__read_review", "mcp__purview__edit_draft"],
    env: { ...fixture.env, ANTHROPIC_BASE_URL: fixture.api.url, ANTHROPIC_API_KEY: "local-fixture-not-a-secret",
      CLAUDE_CONFIG_DIR: fixture.claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" },
  } });
}

export async function claudeTurn(fixture, resume) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  const q = claudeQuery(fixture, resume, abort);
  const events = [];
  try {
    for await (const e of q) events.push(e);
    return events;
  } finally { clearTimeout(timer); q.close(); }
}
