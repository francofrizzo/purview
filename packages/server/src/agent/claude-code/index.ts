import { randomUUID } from "node:crypto";
import { cliCommand } from "../../skill-paths.js";
import { spawnProcess, superviseProcess, type ChildProcessLike, type ProcessExit } from "../process-runner.js";
import type {
  AgentEvent,
  AgentHarness,
  AgentRun,
  AgentRunRequest,
  AgentSession,
  Exec,
  HarnessManifest,
  HarnessStatus,
} from "../types.js";
import { handoffCommand } from "./handoff.js";
import { analysisPolicy, chatPolicy, claudeProjectDir, type ClaudeToolPolicy } from "./permissions.js";
import { buildArgv, loggableArgv, translate, type ClaudeArgs } from "./protocol.js";

/**
 * Claude Code as an agent harness: headless `claude -p --output-format
 * stream-json` runs. Auth is whatever the user's own CLI already has — we
 * never read, pass or store credentials.
 *
 * The spawn is injectable (`setClaudeSpawner`) so tests can drive a scripted
 * child process that emits canned stream-json instead of paying for a real
 * model call.
 */

export type ClaudeSpawner = (
  argv: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => ChildProcessLike;

const defaultSpawner: ClaudeSpawner = (argv, opts) =>
  spawnProcess(process.env.REVIEWER_CLAUDE_BIN ?? "claude", argv, opts);

let spawner: ClaudeSpawner = defaultSpawner;

/** Swap the spawner (tests). Pass null to restore the real `claude` CLI. */
export function setClaudeSpawner(next: ClaudeSpawner | null): void {
  spawner = next ?? defaultSpawner;
}

const HARNESS_ID = "claude-code";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const manifest: HarnessManifest = {
  id: HARNESS_ID,
  name: "Claude Code",
  agentName: "Claude",
  capabilities: { resume: true, handoff: true },
  toolNames: { shell: "Bash", read: "Read", write: "Write", edit: "Edit" },
};

const LABELS = { analysis: "analysis", chat: "chat", reanchor: "comment-reanchor" } as const;

/** The task's tool surface and the run-shape flags that go with it. */
function taskArgs(request: AgentRunRequest): ClaudeArgs {
  const cli = cliCommand();
  const { task } = request;
  let policy: ClaudeToolPolicy;
  switch (task.kind) {
    case "analysis":
      policy = analysisPolicy(task, cli, { transcriptDir: claudeProjectDir(request.cwd) });
      // Analysis instructions are a large, identical-across-runs block: keep
      // Claude Code's per-machine sections out of it so the prefix caches.
      return { ...policy, stableSystemPrompt: true };
    case "chat":
      policy = chatPolicy(task, cli);
      return { ...policy, partialMessages: true };
    case "reanchor":
      // Everything the model needs is inline in the prompt; no filesystem or
      // network access is warranted (or wanted) for a one-shot answer.
      return { tools: [] };
  }
}

function failedRun(error: string): AgentRun {
  return {
    cancel: () => {},
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "completed", ok: false, error };
    })(),
  };
}

function exitError(exit: ProcessExit, resultError: string | undefined): string | undefined {
  switch (exit.reason) {
    case "cancelled":
      return "cancelled";
    case "timeout":
      return `claude timed out after ${exit.timeoutMs}ms`;
    case "error":
      return exit.spawnFailed ? `could not start claude: ${exit.message}` : exit.message;
    case "exited": {
      if (exit.code === 0) return undefined;
      const result = resultError ? ` (${resultError})` : "";
      return `claude exited with code ${exit.code}${result}${exit.stderrTail ? `: ${exit.stderrTail}` : ""}`;
    }
  }
}

function run(request: AgentRunRequest): AgentRun {
  const resume = typeof request.session === "object" ? request.session : undefined;
  if (resume && !canResume(resume, request.cwd)) {
    return failedRun(`cannot resume ${resume.harness} session ${resume.id} from ${request.cwd}`);
  }
  // A new resumable session gets its id up front, so it is known even if the
  // CLI dies before its init line.
  const newSessionId = request.session === "new" ? randomUUID() : undefined;
  const partialMessages = request.task.kind === "chat";

  const argv = buildArgv({
    ...taskArgs(request),
    systemPrompt: request.instructions,
    addDirs: request.readRoots,
    model: request.model,
    effort: request.effort && request.effort !== "none" ? request.effort : undefined,
    sessionId: newSessionId,
    resumeSessionId: resume?.id,
  });
  const label = LABELS[request.task.kind];
  if (!process.env.VITEST) {
    console.log(`[claude:${label}] spawn (cwd=${request.cwd}) ` + loggableArgv(argv).join(" "));
  }

  const proc = superviseProcess({
    spawn: (_command, args, opts) => spawner(args, opts),
    command: "claude",
    argv,
    cwd: request.cwd,
    env: request.environment,
    // The prompt goes over stdin: it can be large (a chat message with
    // resolved references), and keeping it out of argv keeps it out of
    // process listings and log lines.
    stdin: request.prompt,
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const events = (async function* (): AsyncGenerator<AgentEvent> {
    const sessionFor = (id: string): AgentSession => ({ harness: HARNESS_ID, id, cwd: request.cwd });
    let session = resume ?? (newSessionId ? sessionFor(newSessionId) : undefined);
    if (newSessionId) yield { type: "session", session: session! };
    let resultError: string | undefined;

    for await (const event of proc.events) {
      if (event.type === "exit") {
        const error = exitError(event.exit, resultError);
        if (!error && resultError) console.warn(`[claude:${label}] exited 0 after an error result: ${resultError}`);
        yield { type: "completed", ok: !error, error, session };
        return;
      }
      const trimmed = event.line.trim();
      if (!trimmed) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Non-JSON noise on stdout is not fatal; the CLI occasionally prints
        // warnings there and dropping them beats aborting a 20-minute run.
        continue;
      }
      for (const parsed of translate(raw, partialMessages)) {
        if (parsed.type === "result-error") {
          resultError = parsed.detail;
        } else if (parsed.type === "session") {
          session = sessionFor(parsed.sessionId);
          yield {
            type: "session",
            session,
            resolvedModel: parsed.resolvedModel,
            harnessVersion: parsed.harnessVersion,
          };
        } else {
          yield parsed;
        }
      }
    }
  })();

  return { events, cancel: proc.cancel };
}

/**
 * The CLI files sessions per cwd: resuming from another cwd may not find the
 * session, so only a session started in this very cwd is resumable.
 */
function canResume(session: AgentSession, cwd: string): boolean {
  return session.harness === HARNESS_ID && session.cwd === cwd;
}

/**
 * `claude` missing is reported, not fatal: the diff viewer, GitHub sync and
 * the review lifecycle work without it.
 */
function probe(exec: Exec): HarnessStatus {
  const r = exec("claude", ["--version"]);
  if (!r.ok) {
    return { available: false, detail: "not found", setupHint: "https://claude.com/claude-code" };
  }
  const version = r.stdout.trim().split("\n")[0];
  return { available: true, version: version || undefined, detail: version || "ok" };
}

export const claudeCodeHarness: AgentHarness = {
  manifest,
  probe,
  run,
  canResume,
  createHandoff(session, context) {
    // The context file sends the fork to other roots (state, skill docs);
    // granting them up front spares a permission prompt on the first read.
    const addDirs = context.readRoots.filter((d) => d !== session.cwd);
    return {
      command: handoffCommand({
        cwd: session.cwd,
        sessionId: session.id,
        contextPath: context.contextPath,
        addDirs,
      }),
    };
  },
};
