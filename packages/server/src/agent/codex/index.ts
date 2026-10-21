import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { stateRoot } from "@reviewer/core";
import { startReviewTools } from "../review-tools/run.js";
import type { AgentEvent, AgentHarness, AgentRunRequest, AgentSession, Exec, HarnessManifest } from "../types.js";

/**
 * The oldest native Codex whose app-server configuration keys were verified
 * to behave as this adapter assumes. Newer versions are accepted; the
 * effective configuration is still read back before the first turn, so a key
 * a future version drops or renames fails the run instead of widening it.
 */
const MIN_VERSION = "0.163.0";
/** `codex-cli 0.164.0` -> `0.164.0`; undefined for anything else or older than MIN_VERSION. */
export function acceptedCodexVersion(output: string): string | undefined {
  const m = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(output.trim());
  if (!m) return undefined;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const min = MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] > min[i]) return `${m[1]}.${m[2]}.${m[3]}`;
    if (have[i] < min[i]) return undefined;
  }
  return `${m[1]}.${m[2]}.${m[3]}`;
}
const ADDENDUM = "[Purview Codex adaptation]\nKeep evidence excerpts <=200 characters and text fields <=300 characters. For targeted questions use selective reads/search; for full analysis cover all relevant hunks. These limits do not change the task's permissions.";
const instructions = (value?: string) => `${value ?? ""}\n\n${ADDENDUM}`;
const fingerprint = (value?: string) => createHash("sha256").update(instructions(value)).digest("hex");
const executable = () => process.env.PURVIEW_CODEX_BIN || "codex";
function nativePath(): string {
  const command = executable();
  const found = command.includes(path.sep) ? command : (process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, command)).find(file => existsSync(file));
  if (!found) throw new Error(`Requires native Codex ${MIN_VERSION} or newer; install it or set PURVIEW_CODEX_BIN to its executable path`);
  const file = realpathSync(found);
  // Spawning npm's JS launcher does not reliably own the native server group.
  const fd = openSync(file, "r");
  const header = Buffer.alloc(4);
  try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
  const magic = header.toString("hex");
  if (!["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe"].includes(magic)) throw new Error("Requires native Codex 0.163.0 executable, not a script launcher");
  return file;
}
const loginHint = "Manually log in with HOME=<private-home> CODEX_HOME=<private-codex-home> codex login, then retry. Purview never logs in automatically or copies ~/.codex.";
export type CodexSpawner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: true; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
let spawner: CodexSpawner = spawn;
export function setCodexSpawner(next: CodexSpawner | null): void { spawner = next ?? spawn; }

const manifest: HarnessManifest & { reviewTools: boolean } = {
  id: "codex", name: "Codex (experimental)", agentName: "Codex", reviewTools: true,
  models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }], efforts: ["low", "medium", "high"],
  defaults: { model: "gpt-6.1-sol", effort: "medium" }, capabilities: { resume: true, handoff: false },
  toolNames: { shell: "unavailable", read: "read_code", write: "unavailable", edit: "edit_draft" }, inlineOutputLimit: 200,
};
function probe(exec: Exec) {
  const result = exec(executable(), ["--version"]);
  const version = result.ok ? acceptedCodexVersion(result.stdout) : undefined;
  return { available: !!version, version,
    detail: version ? `Codex ${version} (experimental)` : `Requires native Codex ${MIN_VERSION} or newer`,
    setupHint: `Install native Codex ${MIN_VERSION} or newer. ${loginHint}` };
}
function canResume(session: AgentSession, next: { cwd: string; instructions?: string }) {
  return session.harness === "codex" && session.cwd === next.cwd && session.fingerprint === fingerprint(next.instructions);
}
function toml(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

function run(request: AgentRunRequest) {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let stopped: string | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let rejectWait: ((error: Error) => void) | undefined;
  const emit = (event: AgentEvent) => { queue.push(event); wake?.(); };
  const stop = (reason: string) => {
    stopped ??= reason;
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
    rejectWait?.(new Error(reason));
  };
  const timer = setTimeout(() => stop("Codex timed out"), request.timeoutMs ?? 30 * 60_000);
  void (async () => {
    let binding: Awaited<ReturnType<typeof startReviewTools>> | undefined;
    let neutral: string | undefined;
    let session: AgentSession | undefined;
    let error: string | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      const check = () => { if (stopped) throw new Error(stopped); };
      const resume = typeof request.session === "object" ? request.session : undefined;
      if (resume && !canResume(resume, request)) throw new Error("Incompatible Codex session");
      if (!["linux", "darwin"].includes(process.platform)) throw new Error("Requires native Codex on Linux or macOS");
      const binary = nativePath();
      // Packaged native installs keep resources beside bin/. A standalone
      // override must not accidentally grant its grandparent (possibly /).
      const install = path.dirname(path.dirname(binary));
      const runtimeRoot = path.basename(path.dirname(binary)) === "bin" && install !== path.parse(install).root && existsSync(path.join(install, "codex-package.json")) ? install : binary;
      check();
      const root = path.join(request.review?.root ?? stateRoot(), "agents", "codex");
      const home = path.join(root, "home");
      const codexHome = path.resolve(process.env.PURVIEW_CODEX_HOME || path.join(root, "store"));
      for (const dir of [root, home, codexHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Never merge ambient private configuration: unknown future keys can grant tools.
      if (existsSync(path.join(codexHome, "config.toml")) && readFileSync(path.join(codexHome, "config.toml"), "utf8").trim()) throw new Error("Unsafe ambient Codex config; use a separately authenticated empty store");
      if (!existsSync(path.join(codexHome, "auth.json"))) throw new Error(`Codex login required. Private HOME=${home}; CODEX_HOME=${codexHome}. ${loginHint}`);
      neutral = realpathSync(mkdtempSync(path.join(root, "run-")));
      for (let dir = neutral; ; dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, ".codex", "config.toml"))) throw new Error("Unsafe ambient project Codex config above private working directory");
        if (dir === path.dirname(dir)) break;
      }
      if (request.task.kind !== "reanchor") binding = await startReviewTools(request, "codex",
        action => emit({ type: "action", action }), operation => emit({ type: "operation-result", operation }));
      check();
      const config = {
        model: request.model, model_reasoning_effort: request.effort ?? "medium", cli_auth_credentials_store: "file",
        approval_policy: "never", web_search: "disabled", notify: [],
        plugins: { _default: { enabled: false } }, orchestrator: { mcp: { enabled: false } },
        features: { shell_tool: false, view_image: false, multi_agent: false, multi_agent_v2: false, apps: false,
          browser_use: false, computer_use: false, goals: false, hooks: false, plugins: false, remote_plugin: false,
          code_mode_only_strict_3p_tools: false, code_mode: { enabled: false, direct_only_tool_namespaces: ["mcp__purview"] } },
        agents: { enabled: false }, tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
        analytics: { enabled: false }, default_permissions: "purview",
        permissions: { purview: { filesystem: { ":minimal": "read", [neutral]: "read", [runtimeRoot]: "read" }, network: { enabled: false } } },
        mcp_servers: binding ? { purview: { url: binding.url, required: true, enabled_tools: binding.names, default_tools_approval_mode: "approve" } } : {},
      };
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: neutral, LANG: "C.UTF-8" };
      for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[key]) env[key] = process.env[key];
      child = spawner(binary, ["--version"], { cwd: neutral, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      closed = new Promise(resolve => child!.once("close", resolve));
      let version = "";
      child.stdout.on("data", chunk => { version += String(chunk).slice(0, 256); });
      child.stderr.resume();
      await new Promise<void>((resolve, reject) => {
        rejectWait = reject;
        child!.once("error", () => reject(new Error("Codex version failed")));
        child!.once("close", code => code === 0 ? resolve() : reject(new Error("Codex version failed")));
      });
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }
      child = undefined;
      check();
      const acceptedVersion = acceptedCodexVersion(version);
      if (!acceptedVersion) throw new Error(`Requires native Codex ${MIN_VERSION} or newer`);
      child = spawner(binary, ["app-server", "--listen", "stdio://", ...Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${toml(v)}`])], { cwd: neutral, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      closed = new Promise(resolve => child!.once("close", resolve));
      child.stderr.resume(); // Never surface native auth/RPC diagnostics.
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
      let serial = 0;
      const fail = () => { stop(stopped ?? "Codex process failed"); for (const p of pending.values()) p.reject(new Error("Codex process failed")); pending.clear(); };
      child.on("error", fail);
      child.on("exit", fail);
      const send = (value: unknown) => child!.stdin.write(JSON.stringify(value) + "\n");
      child.stdin.on("error", fail);
      const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
        check(); const id = ++serial; pending.set(id, { resolve, reject }); send({ id, method, params });
      });
      let finishTurn: ((value: any) => void) | undefined;
      const turnDone = new Promise<any>(resolve => { finishTurn = resolve; });
      rejectWait = error => { for (const p of pending.values()) p.reject(error); pending.clear(); finishTurn?.({ status: "failed" }); };
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          const message = JSON.parse(line);
          if (message.method && message.id !== undefined) { send({ id: message.id, error: { code: -32601, message: "Request denied" } }); stop("Codex requested unsupported permissions or interaction"); return; }
          if (!message.method) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p?.reject(new Error("Codex RPC failed")) : p?.resolve(message.result); return; }
          const p = message.params;
          if (message.method === "item/agentMessage/delta" && request.task.kind === "chat") emit({ type: "output-delta", text: p.delta });
          if (message.method === "item/completed" && p.item.type === "agentMessage") emit({ type: "output", text: p.item.text });
          if (message.method === "thread/tokenUsage/updated") { const t = p.tokenUsage.total; emit({ type: "usage", usage: { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadInputTokens: t.cachedInputTokens } }); }
          if (message.method === "turn/completed") finishTurn?.(p.turn);
        } catch { stop("Invalid Codex protocol"); }
      });
      await call("initialize", { clientInfo: { name: "purview", version: "1" }, capabilities: { experimentalApi: true } });
      send({ method: "initialized" });
      const { config: actual } = await call("config/read", { cwd: neutral, includeLayers: true });
      // Compare owned settings; arrays are exact, not a prefix allowlist.
      const equal = (a: any, b: any): boolean => Array.isArray(b) ? Array.isArray(a) && a.length === b.length && b.every((v, i) => equal(a[i], v))
        : b && typeof b === "object" ? !!a && Object.keys(b).every(k => equal(a[k], b[k])) : a === b;
      // 0.163.0 config/read's typed projection omits these two experimental
      // tool overrides. Keep sending the proven overrides, but don't demand
      // fields that this pinned protocol cannot report.
      const { tools: _tools, ...reportedConfig } = config;
      if (!equal(actual, reportedConfig) || JSON.stringify(Object.keys(actual.mcp_servers ?? {}).sort()) !== JSON.stringify(binding ? ["purview"] : [])) throw new Error("Unsafe effective Codex configuration");
      const filesystem = actual.permissions?.purview?.filesystem;
      const roots = Object.keys(filesystem ?? {}).filter(k => !(k === "glob_scan_max_depth" && filesystem[k] === null));
      if (actual.permissions.purview.extends != null || actual.permissions.purview.workspace_roots != null || JSON.stringify(roots.sort()) !== JSON.stringify(Object.keys(config.permissions.purview.filesystem).sort())) throw new Error("Unsafe effective Codex filesystem permissions");
      const mcp = actual.mcp_servers?.purview;
      if (mcp && ["command", "args", "env", "http_headers", "env_http_headers", "bearer_token_env_var"].some(k => mcp[k] != null)) throw new Error("Unsafe effective Codex MCP configuration");
      const { thread } = await call(resume ? "thread/resume" : "thread/start", { ...(resume ? { threadId: resume.id } : {}), cwd: neutral,
        permissions: "purview", approvalPolicy: "never", baseInstructions: instructions(request.instructions) });
      if (resume && thread.id !== resume.id) throw new Error("Codex resumed a different session");
      session = { harness: "codex", id: thread.id, cwd: request.cwd, fingerprint: fingerprint(request.instructions) };
      emit({ type: "session", session, resolvedModel: thread.model, harnessVersion: acceptedVersion });
      await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: request.prompt }] });
      const turn = await turnDone;
      if (turn.status !== "completed") throw new Error("Codex turn failed");
      check();
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      error = stopped ?? (/^(Requires native|Incompatible Codex|Codex login required|Unsafe ambient|Unsafe effective|Codex resumed)/.test(message) ? message : "Codex run failed. " + loginHint);
    } finally {
      clearTimeout(timer);
      // Revoke capability before any terminal event, even when startup failed.
      try { await binding?.close(); } catch { error ??= "Could not close Codex review tools"; }
      stop("Codex stopped");
      await closed;
      try { if (neutral) rmSync(neutral, { recursive: true, force: true }); } catch { error ??= "Could not clean up Codex working directory"; }
      emit({ type: "completed", ok: !error, error, session }); done = true; wake?.();
    }
  })();
  return { cancel: () => { if (!done) stop("cancelled"); }, events: (async function* (): AsyncGenerator<AgentEvent> {
    while (!done || queue.length) { if (queue.length) yield queue.shift()!; else await new Promise<void>(resolve => { wake = resolve; }); }
  })() };
}

export const codexHarness: AgentHarness = { manifest, probe, run, canResume };
