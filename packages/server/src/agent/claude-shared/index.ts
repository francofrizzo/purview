import { promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { stateRoot } from "@reviewer/core";
import { claudeCodeHarness } from "../claude-code/index.js";
import { buildArgv, translate } from "../claude-code/protocol.js";
import { superviseProcess, type ProcessSpawner } from "../process-runner.js";
import { startReviewTools } from "../review-tools/run.js";
import type { AgentEvent, AgentHarness, AgentRunRequest, AgentSession } from "../types.js";

/**
 * The oldest CLI whose permission flags were verified to behave as this
 * adapter assumes. Newer versions are accepted and then checked by behaviour:
 * the init event must list the review tools and nothing else. A flag a future
 * version silently ignores would show up there as a native tool.
 */
const MIN_VERSION = "2.1.305";
/** `2.1.306 (Claude Code)` -> `2.1.306`; undefined for anything else or anything older than MIN_VERSION. */
export function acceptedClaudeVersion(output: string): string | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(output.trim());
  if (!m) return undefined;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const min = MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] > min[i]) return `${m[1]}.${m[2]}.${m[3]}`;
    if (have[i] < min[i]) return undefined;
  }
  return `${m[1]}.${m[2]}.${m[3]}`;
}
/**
 * The capability check on the CLI's init event: every tool it offers must be
 * one of ours, and the review MCP must be connected when the run has one.
 * Returns the reason to refuse, or undefined.
 */
export function unexpectedCapability(init: Record<string, unknown>, expectedTools: string[] | undefined): string | undefined {
  if (!Array.isArray(init.tools)) return "Unexpected Claude session without a tool list";
  const allowed = new Set(expectedTools ?? []);
  const foreign = (init.tools as unknown[]).filter((t) => typeof t !== "string" || !allowed.has(t));
  if (foreign.length) return `Unexpected native tool offered by Claude Code: ${foreign.map(String).join(", ")}`;
  if (expectedTools?.length) {
    const servers = Array.isArray(init.mcp_servers) ? (init.mcp_servers as { name?: string; status?: string }[]) : [];
    if (!servers.some((s) => s?.name === "purview" && s.status === "connected")) return "Unexpected Claude session without the review tools connected";
  }
  return undefined;
}
const executable = () => process.env.PURVIEW_CLAUDE_BIN ?? process.env.REVIEWER_CLAUDE_BIN ?? "claude";
const fingerprint = (value?: string) => `shared1:${createHash("sha256").update(value ?? "").digest("hex")}`;
const canResume: AgentHarness["canResume"] = (session, next) => session.harness === "claude-shared" &&
  session.cwd === next.cwd && session.fingerprint === fingerprint(next.instructions);

// Explicit auth/routing environment: no unrelated app secrets or CLI feature
// switches. USER/LOGNAME are needed to find macOS's existing Keychain login.
function environment(): Record<string, string> {
  const env: Record<string, string> = { LANG: "C.UTF-8", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}
const nativeSpawner: ProcessSpawner = (command, args, opts) => {
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  // Own the whole native process group, not just a shell/npm launcher.
  const kill = child.kill.bind(child);
  child.kill = signal => {
    if (!child.pid) return kill(signal);
    try { process.kill(-child.pid, signal ?? "SIGTERM"); return true; } catch { return false; }
  };
  return child;
};
let spawner = nativeSpawner;
export function setSharedClaudeSpawner(next: ProcessSpawner | null) { spawner = next ?? nativeSpawner; }

function run(request: AgentRunRequest) {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let cancelled = false;
  let proc: ReturnType<typeof superviseProcess> | undefined;
  let binding: Awaited<ReturnType<typeof startReviewTools>> | undefined;
  const emit = (event: AgentEvent) => { queue.push(event); wake?.(); };
  void (async () => {
    let session: AgentSession | undefined;
    let error: string | undefined;
    try {
      const resume = typeof request.session === "object" ? request.session : undefined;
      if (resume && !canResume(resume, request)) throw new Error("Incompatible Claude shared-tools session");
      const env = environment();
      const reported = (await promisify(execFile)(executable(), ["--version"], { env, encoding: "utf8", timeout: 5000 })).stdout.trim();
      const version = acceptedClaudeVersion(reported);
      if (!version) throw new Error(`Requires Claude Code ${MIN_VERSION} or newer; found "${reported.slice(0, 40)}"`);
      // Stable per logical cwd so cold resume finds the same transcript, but
      // outside the repository so project instructions cannot widen authority.
      const cwd = path.join(request.review?.root ?? stateRoot(), "agents", "claude-shared", createHash("sha256").update(request.cwd).digest("hex"));
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      if (request.task.kind !== "reanchor") binding = await startReviewTools(request, "claude-shared",
        action => emit({ type: "action", action }), operation => emit({ type: "operation-result", operation }));
      if (cancelled) throw new Error("cancelled");
      const id = resume?.id ?? (request.session === "new" ? randomUUID() : undefined);
      if (id) session = { harness: "claude-shared", id, cwd: request.cwd, fingerprint: fingerprint(request.instructions) };
      const argv = [
        // --safe-mode disables even explicit MCP; the spike verified this
        // restricted, empty-settings alternative with an owned MCP allowlist.
        ...buildArgv({ tools: [], allowedTools: binding?.names.map(name => `mcp__purview__${name}`),
          permissionMode: "dontAsk", systemPrompt: request.instructions, model: request.model,
          effort: request.effort === "none" ? undefined : request.effort,
          partialMessages: request.task.kind === "chat", sessionId: resume ? undefined : id, resumeSessionId: resume?.id,
        }).filter(arg => arg !== "--safe-mode"),
        "--restricted", "--setting-sources", "", "--disable-slash-commands",
        "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
        "--mcp-config", JSON.stringify({ mcpServers: binding ? { purview: { type: "http", url: binding.url } } : {} }),
      ];
      proc = superviseProcess({ command: executable(), argv, cwd, env, spawn: spawner, stdin: request.prompt, timeoutMs: request.timeoutMs ?? 30 * 60_000 });
      if (session) emit({ type: "session", session, harnessVersion: version });
      let resultSeen = false;
      for await (const event of proc.events) {
        if (event.type === "exit") {
          const exit = event.exit;
          if (exit.reason === "cancelled") error = "cancelled";
          else if (exit.reason === "timeout") error = "Claude timed out";
          else if (exit.reason !== "exited" || exit.code !== 0) error = "Claude process failed; check the CLI installation and login";
          else if (!resultSeen) error = "Claude ended without a result";
          break;
        }
        let raw: Record<string, unknown>;
        try { raw = JSON.parse(event.line); } catch { continue; }
        if (raw.type === "system" && raw.subtype === "init") {
          const refusal = unexpectedCapability(raw, binding?.names.map(name => `mcp__purview__${name}`));
          if (refusal) throw new Error(refusal);
        }
        if (raw.type === "result") {
          resultSeen = true;
          if (Array.isArray(raw.permission_denials) && raw.permission_denials.length) error = "Claude denied a required review tool";
        }
        for (const parsed of translate(raw, request.task.kind === "chat")) {
          if (parsed.type === "result-error") error = "Claude returned an error result";
          else if (parsed.type === "session") {
            if (session && parsed.sessionId !== session.id) throw new Error("Unexpected Claude session identity");
            if (session) emit({ type: "session", session, resolvedModel: parsed.resolvedModel, harnessVersion: parsed.harnessVersion });
          } else if (parsed.type !== "action") emit(parsed); // authoritative operations emit their own actions
        }
      }
    } catch (e) {
      error = cancelled ? "cancelled" : e instanceof Error && /^(Requires |Incompatible |Unexpected )/.test(e.message)
        ? e.message : "Could not run Claude shared tools; verify the pinned CLI and its existing login";
      proc?.cancel();
    } finally {
      try { await binding?.close(); } catch { error ??= "Could not close Claude review tools"; }
      emit({ type: "completed", ok: !error, error, session });
      done = true;
      wake?.();
    }
  })();
  return {
    cancel() { if (done) return; cancelled = true; void binding?.close(); proc?.cancel(); },
    events: (async function* () {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    })(),
  };
}

export const claudeSharedHarness: AgentHarness = {
  manifest: { ...claudeCodeHarness.manifest, id: "claude-shared", name: "Claude Code", reviewTools: true,
    capabilities: { resume: true, handoff: true }, toolNames: { shell: "unavailable", read: "read_code", write: "unavailable", edit: "edit_draft" } },
  canResume, run,
  createHandoff: claudeCodeHarness.createHandoff,
  probe(exec) {
    const result = exec(executable(), ["--version"]);
    if (!result.ok) return { available: false, detail: "not found", setupHint: "https://claude.com/claude-code" };
    const version = acceptedClaudeVersion(result.stdout);
    if (version) return { available: true, version, detail: result.stdout.trim().split("\n")[0] };
    return {
      available: false,
      detail: `Requires Claude Code ${MIN_VERSION} or newer; found ${result.stdout.trim().split("\n")[0] || "an unknown version"}`,
      setupHint: "run `claude update`, or choose Claude Code (Legacy) in Settings",
    };
  },
};
