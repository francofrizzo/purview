import type { AgentAction, AgentEvent, AgentUsage } from "../types.js";

/**
 * Claude Code's side of the wire: the `claude -p --output-format stream-json`
 * argv, and the translation of its event lines into agent events.
 */

export interface ClaudeArgs {
  /** appended to Claude Code's own system prompt (keeps its tool instructions intact) */
  systemPrompt?: string;
  /** extra readable roots beyond cwd */
  addDirs?: string[];
  /**
   * `--permission-mode`. Without it the run inherits the user's own
   * `permissions.defaultMode` (e.g. `auto`, where a classifier approves
   * commands no allow rule names) — see permissions.ts.
   */
  permissionMode?: "default" | "dontAsk" | "acceptEdits" | "plan";
  /**
   * `--exclude-dynamic-system-prompt-sections`: per-machine sections (cwd,
   * env, git status) move into the first user message, so the system prompt
   * — Claude Code's own plus `systemPrompt` — is byte-identical across runs
   * in different directories and its cache prefix can be reused.
   */
  stableSystemPrompt?: boolean;
  /** built-in tool surface (`--tools`); [] disables all tools */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  /** start a fresh session with this id (must be a uuid) */
  sessionId?: string;
  /** resume an existing session instead of starting one */
  resumeSessionId?: string;
  /** stream token-level deltas (`--include-partial-messages`) */
  partialMessages?: boolean;
  model?: string;
  /** reasoning effort (`--effort`); omitted when unset */
  effort?: string;
}

/** Everything except the prompt (which never enters argv anyway). */
export function buildArgv(opts: ClaudeArgs): string[] {
  const argv = ["-p", "--output-format", "stream-json", "--verbose"];
  // Customizations (plugins/MCP/hooks/CLAUDE.md) are irrelevant to these runs
  // and would widen the tool surface with whatever the user happens to have
  // installed, so both are switched off rather than trusted.
  argv.push("--safe-mode", "--strict-mcp-config");
  if (opts.partialMessages) argv.push("--include-partial-messages");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts.systemPrompt) argv.push("--append-system-prompt", opts.systemPrompt);
  if (opts.stableSystemPrompt) argv.push("--exclude-dynamic-system-prompt-sections");
  for (const dir of opts.addDirs ?? []) argv.push("--add-dir", dir);
  if (opts.tools) argv.push("--tools", opts.tools.join(","));
  if (opts.allowedTools?.length) argv.push("--allowedTools", ...opts.allowedTools);
  if (opts.disallowedTools?.length) argv.push("--disallowedTools", ...opts.disallowedTools);
  if (opts.resumeSessionId) argv.push("--resume", opts.resumeSessionId);
  else if (opts.sessionId) argv.push("--session-id", opts.sessionId);
  return argv;
}

/** argv with the system prompt body elided — safe and useful to log. */
export function loggableArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (argv[i] === "--append-system-prompt" || argv[i] === "--system-prompt") {
      out.push(`<${argv[++i]?.length ?? 0} chars>`);
    }
  }
  return out;
}

/* ------------------------------------------------------- stream-json shapes */

/**
 * What one stream-json line means. `result-error` is not an agent event: the
 * harness folds it into `completed.error` once the process has exited.
 */
export type ClaudeLineEvent =
  | Exclude<AgentEvent, { type: "session" } | { type: "completed" }>
  | { type: "session"; sessionId: string; resolvedModel?: string; harnessVersion?: string }
  | { type: "result-error"; detail: string };

interface AssistantContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** One raw stream-json line -> zero or more events. */
export function translate(raw: Record<string, unknown>, partialMessages: boolean): ClaudeLineEvent[] {
  const out: ClaudeLineEvent[] = [];
  const type = raw.type as string | undefined;

  if (type === "system" && raw.subtype === "init" && raw.session_id) {
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    out.push({
      type: "session",
      sessionId: String(raw.session_id),
      resolvedModel: str(raw.model),
      harnessVersion: str(raw.claude_code_version),
    });
    return out;
  }

  if (type === "stream_event" && partialMessages) {
    const ev = raw.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      out.push({ type: "output-delta", text: ev.delta.text });
    }
    return out;
  }

  if (type === "assistant") {
    const message = raw.message as { content?: AssistantContentBlock[] } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === "text" && block.text) {
        out.push({ type: "output", text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        out.push({ type: "action", action: toAction(block.name, block.input ?? {}) });
      }
    }
    return out;
  }

  if (type === "result") {
    if (raw.is_error === true) {
      const errors = Array.isArray(raw.errors) ? (raw.errors as string[]) : [];
      out.push({ type: "result-error", detail: errors.join("; ") || String(raw.subtype ?? "error") });
    }
    out.push({ type: "usage", usage: translateUsage(raw) });
    return out;
  }

  return out;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The `result` line's timing/cost/usage fields, every one of them optional. */
function translateUsage(raw: Record<string, unknown>): AgentUsage {
  const usage = raw.usage as Record<string, unknown> | undefined;
  const tokens = usage && typeof usage === "object" ? usage : {};
  return {
    inputTokens: num(tokens.input_tokens),
    cacheCreationInputTokens: num(tokens.cache_creation_input_tokens),
    cacheReadInputTokens: num(tokens.cache_read_input_tokens),
    outputTokens: num(tokens.output_tokens),
    turns: num(raw.num_turns),
    durationMs: num(raw.duration_ms),
    apiDurationMs: num(raw.duration_api_ms),
    costUsd: num(raw.total_cost_usd),
  };
}

const ACTION_KINDS: Record<string, AgentAction["kind"]> = {
  Bash: "command",
  Read: "read",
  Write: "write",
  Edit: "write",
  NotebookEdit: "write",
  Glob: "search",
  Grep: "search",
};

/** A tool call as an action: its kind, and a non-sensitive one-line target. */
function toAction(name: string, input: Record<string, unknown>): AgentAction {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  };
  const target = name === "Bash" ? pick("command") : pick("file_path", "path", "pattern", "query", "url", "prompt");
  return {
    kind: ACTION_KINDS[name] ?? "tool",
    name,
    target,
    summary: target.length > 200 ? target.slice(0, 197) + "..." : target,
  };
}
