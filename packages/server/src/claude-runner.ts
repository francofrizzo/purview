import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Headless Claude Code runs.
 *
 * Everything that shells out to the `claude` CLI goes through here: analysis
 * jobs and the review chat both spawn `claude -p --output-format stream-json`
 * and consume the same parsed event stream. Auth is whatever the user's own
 * CLI already has — we never read, pass or store credentials.
 *
 * The spawn itself is injectable (`setClaudeSpawner`) so tests can drive a
 * scripted child process that emits canned stream-json instead of paying for
 * a real model call.
 */

/* ------------------------------------------------------------- child shape */

export interface ClaudeChild {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type ClaudeSpawner = (
  argv: string[],
  opts: { cwd: string },
) => ClaudeChild;

const defaultSpawner: ClaudeSpawner = (argv, opts) =>
  spawn(process.env.REVIEWER_CLAUDE_BIN ?? "claude", argv, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // No secrets are injected; the CLI reuses the user's own auth.
    env: process.env,
  }) as unknown as ClaudeChild;

let spawner: ClaudeSpawner = defaultSpawner;

/** Swap the spawner (tests). Pass null to restore the real `claude` CLI. */
export function setClaudeSpawner(next: ClaudeSpawner | null): void {
  spawner = next ?? defaultSpawner;
}

/* -------------------------------------------------------------- our events */

export type ClaudeEvent =
  /** the CLI reported the session id (first `system:init` line) */
  | { type: "session"; sessionId: string }
  /** incremental text (only when partialMessages is on) */
  | { type: "delta"; text: string }
  /** a complete assistant text block */
  | { type: "text"; text: string }
  /** Claude used a tool; `detail` is a short human-readable argument summary */
  | { type: "tool"; name: string; detail: string }
  /** terminal; always emitted exactly once, even on spawn failure */
  | { type: "done"; ok: boolean; error?: string; sessionId?: string };

export interface ClaudeRunOptions {
  /** written to the child's stdin — never placed in argv, so it never lands in logs */
  prompt: string;
  cwd: string;
  /** appended to Claude Code's own system prompt (keeps its tool instructions intact) */
  systemPrompt?: string;
  /** extra readable roots beyond cwd */
  addDirs?: string[];
  /** built-in tool surface (`--tools`); "" disables all tools */
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
  /** SIGTERM after this long. Analysis runs are slow — keep it generous. */
  timeoutMs?: number;
  /** label used in the argv log line */
  label?: string;
}

export interface ClaudeRun {
  events: AsyncIterable<ClaudeEvent>;
  /** SIGTERM now (cancel); the stream ends with a `done` event. */
  kill(): void;
  argv: string[];
}

/** Everything except the prompt (which never enters argv anyway). */
export function buildArgv(opts: ClaudeRunOptions): string[] {
  const argv = ["-p", "--output-format", "stream-json", "--verbose"];
  // Customizations (plugins/MCP/hooks/CLAUDE.md) are irrelevant to these runs
  // and would widen the tool surface with whatever the user happens to have
  // installed, so both are switched off rather than trusted.
  argv.push("--safe-mode", "--strict-mcp-config");
  if (opts.partialMessages) argv.push("--include-partial-messages");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.systemPrompt) argv.push("--append-system-prompt", opts.systemPrompt);
  for (const dir of opts.addDirs ?? []) argv.push("--add-dir", dir);
  if (opts.tools) argv.push("--tools", opts.tools.join(","));
  if (opts.allowedTools?.length) argv.push("--allowedTools", ...opts.allowedTools);
  if (opts.disallowedTools?.length)
    argv.push("--disallowedTools", ...opts.disallowedTools);
  if (opts.resumeSessionId) argv.push("--resume", opts.resumeSessionId);
  else if (opts.sessionId) argv.push("--session-id", opts.sessionId);
  return argv;
}

/** argv with the system prompt body elided — safe and useful to log. */
function loggableArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (argv[i] === "--append-system-prompt" || argv[i] === "--system-prompt") {
      out.push(`<${argv[++i]?.length ?? 0} chars>`);
    }
  }
  return out;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export function runClaude(opts: ClaudeRunOptions): ClaudeRun {
  const argv = buildArgv(opts);
  if (!process.env.VITEST) {
    console.log(
      `[claude${opts.label ? ":" + opts.label : ""}] spawn (cwd=${opts.cwd}) ` +
        loggableArgv(argv).join(" "),
    );
  }

  const queue: ClaudeEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  let sessionId: string | undefined;

  const push = (event: ClaudeEvent) => {
    if (finished) return;
    if (event.type === "done") finished = true;
    queue.push(event);
    resolveNext?.();
    resolveNext = null;
  };

  let child: ClaudeChild;
  try {
    child = spawner(argv, { cwd: opts.cwd });
  } catch (err) {
    const failed: ClaudeRun = {
      argv,
      kill: () => {},
      events: (async function* () {
        yield {
          type: "done",
          ok: false,
          error: `could not start claude: ${(err as Error).message}`,
        } as ClaudeEvent;
      })(),
    };
    return failed;
  }

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      terminate();
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let killTimer: NodeJS.Timeout | undefined;
  function terminate() {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // A wedged child must not hold the slot forever.
    killTimer ??= setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5_000);
    killTimer.unref?.();
  }

  let cancelled = false;
  const stderrChunks: string[] = [];
  child.stderr?.on("data", (d: Buffer) => {
    stderrChunks.push(d.toString());
    if (stderrChunks.length > 200) stderrChunks.shift();
  });

  let buffer = "";
  child.stdout?.on("data", (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  });

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Non-JSON noise on stdout is not fatal; the CLI occasionally prints
      // warnings there and dropping them beats aborting a 20-minute run.
      return;
    }
    for (const parsed of translate(event, opts.partialMessages ?? false)) {
      if (parsed.type === "session") sessionId = parsed.sessionId;
      push(parsed);
    }
  }

  child.on("error", (err: Error) => {
    clearTimeout(timer);
    push({ type: "done", ok: false, error: err.message, sessionId });
  });

  child.on("exit", (code: number | null) => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (buffer.trim()) handleLine(buffer);
    buffer = "";
    if (cancelled) {
      push({ type: "done", ok: false, error: "cancelled", sessionId });
      return;
    }
    if (timedOut) {
      push({
        type: "done",
        ok: false,
        error: `claude timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        sessionId,
      });
      return;
    }
    if (code === 0) {
      push({ type: "done", ok: true, sessionId });
      return;
    }
    const tail = stderrChunks.join("").trim().slice(-2000);
    push({
      type: "done",
      ok: false,
      error: `claude exited with code ${code}${tail ? `: ${tail}` : ""}`,
      sessionId,
    });
  });

  // The prompt goes over stdin: it can be large (a chat message with resolved
  // references), and keeping it out of argv keeps it out of process listings
  // and log lines.
  try {
    child.stdin?.end(opts.prompt);
  } catch {
    /* the exit/error handler reports it */
  }

  const events = (async function* (): AsyncGenerator<ClaudeEvent> {
    for (;;) {
      if (queue.length === 0) {
        if (finished) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        continue;
      }
      const next = queue.shift()!;
      yield next;
      if (next.type === "done") return;
    }
  })();

  return {
    argv,
    events,
    kill: () => {
      cancelled = true;
      terminate();
    },
  };
}

/* ------------------------------------------------------- stream-json shapes */

interface AssistantContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** One raw stream-json line -> zero or more of our events. */
export function translate(
  raw: Record<string, unknown>,
  partialMessages: boolean,
): ClaudeEvent[] {
  const out: ClaudeEvent[] = [];
  const type = raw.type as string | undefined;

  if (type === "system" && raw.subtype === "init" && raw.session_id) {
    out.push({ type: "session", sessionId: String(raw.session_id) });
    return out;
  }

  if (type === "stream_event" && partialMessages) {
    const ev = raw.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      out.push({ type: "delta", text: ev.delta.text });
    }
    return out;
  }

  if (type === "assistant") {
    const message = raw.message as { content?: AssistantContentBlock[] } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === "text" && block.text) {
        out.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        out.push({
          type: "tool",
          name: block.name,
          detail: toolDetail(block.name, block.input ?? {}),
        });
      }
    }
    return out;
  }

  if (type === "result") {
    // `done` is emitted from the exit handler (it knows about cancellation and
    // timeouts); a result line only carries the error text worth surfacing.
    if (raw.is_error === true) {
      const errors = Array.isArray(raw.errors) ? (raw.errors as string[]) : [];
      const detail = errors.join("; ") || String(raw.subtype ?? "error");
      out.push({ type: "tool", name: "result-error", detail });
    }
    return out;
  }

  return out;
}

/** A one-line, non-sensitive summary of a tool call for the activity feed. */
function toolDetail(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  };
  const value =
    name === "Bash"
      ? pick("command")
      : pick("file_path", "path", "pattern", "query", "url", "prompt");
  return value.length > 200 ? value.slice(0, 197) + "..." : value;
}
