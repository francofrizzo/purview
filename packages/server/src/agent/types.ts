/**
 * The agent harness contract: what Purview asks of whatever runs its
 * analysis, chat and re-anchoring turns.
 *
 * A harness is more than a model: it owns process execution, tools,
 * permissions, sessions, auth and its own event protocol. Purview describes
 * *what* a run is for (a semantic task with access constraints) and the
 * harness translates that into its own flags and rules. Nothing outside a
 * harness adapter builds CLI arguments, parses native events, locates native
 * transcripts or writes native permission rules.
 */

export type HarnessId = "claude-code" | (string & {});

/* ------------------------------------------------------------- manifest */

export interface HarnessManifest {
  id: HarnessId;
  /** the product, e.g. "Claude Code" */
  name: string;
  /** what the agent is called in copy, e.g. "Claude" */
  agentName: string;
  capabilities: {
    /** a session can be continued by a later run (see `canResume`) */
    resume: boolean;
    /** `createHandoff` exists */
    handoff: boolean;
  };
  /**
   * How prompts refer to the harness's tools. Purview's instructions name
   * them ("the Write tool", "one Bash call"); the words have to be the ones
   * this harness's model actually sees.
   */
  toolNames: {
    shell: string;
    read: string;
    write: string;
    edit: string;
  };
}

/** Injectable, synchronous process runner for probes. Never throws. */
export type Exec = (cmd: string, args: string[]) => ExecResult;

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface HarnessStatus {
  available: boolean;
  version?: string;
  /** one line for a status display, e.g. the version line or "not found" */
  detail?: string;
  /** where to get the harness when it is unavailable */
  setupHint?: string;
}

/* ---------------------------------------------------------------- tasks */

/**
 * Every `reviewer-state` subcommand. A task lists the ones it may run; a
 * harness denies the rest, so a subcommand added here is denied by default.
 */
export const REVIEWER_COMMANDS = [
  "init",
  "refresh",
  "discard-revision",
  "report",
  "triage",
  "show",
  "changes",
  "base-file",
  "set-analysis",
  "set-unit",
  "set-units",
  "units",
  "view",
  "sync",
  "list",
  "comment",
] as const;
export type ReviewerCommand = (typeof REVIEWER_COMMANDS)[number];

/**
 * Automatic analysis: reads PR state, the skill docs and (optionally) a
 * checkout; writes only inside `scratchDir`; changes state only through
 * `reviewerCommands`. No network.
 */
export interface AnalysisTask {
  kind: "analysis";
  scratchDir: string;
  reviewerCommands: readonly ReviewerCommand[];
}

/**
 * A review-chat turn: reads PR state and code; mutates only draft comments,
 * through `reviewerCommands`. The server enforces draft-only on top (the
 * actor marker in `environment`), whatever the harness allows. No network.
 */
export interface ChatTask {
  kind: "chat";
  reviewerCommands: readonly ReviewerCommand[];
}

/** A one-shot, tool-free answer that the caller validates itself. */
export interface ReanchorTask {
  kind: "reanchor";
}

export type AgentTask = AnalysisTask | ChatTask | ReanchorTask;

/* ------------------------------------------------------------------ runs */

export interface AgentSession {
  harness: HarnessId;
  /** opaque to Purview */
  id: string;
  /** the working directory the session was started in */
  cwd: string;
}

export interface AgentRunRequest {
  task: AgentTask;
  /** the stable behavioral contract (appended to the harness's own system prompt) */
  instructions?: string;
  /** the run-specific input; never placed in argv */
  prompt: string;
  cwd: string;
  /** readable roots beyond `cwd` */
  readRoots?: string[];
  /** always explicit: a run must never inherit the harness's own default model */
  model: string;
  /** a harness-specific effort level; "none" means do not set one */
  effort?: string;
  /**
   * "new": start a session a later run can resume (reported as a `session`
   * event before any output). A session: continue it — only one for which
   * `canResume` said yes. Omitted: the run is one-off.
   */
  session?: "new" | AgentSession;
  timeoutMs?: number;
  /** added to the child's environment (non-secret markers only) */
  environment?: Record<string, string>;
}

export interface AgentAction {
  kind: "command" | "read" | "write" | "search" | "tool";
  /** the harness's own tool name, for display */
  name: string;
  /** the full command or path the action targets, untruncated */
  target: string;
  /** `target` shortened for display */
  summary: string;
}

export interface AgentUsage {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  turns?: number;
  durationMs?: number;
  apiDurationMs?: number;
  costUsd?: number;
}

export type AgentEvent =
  /** the session this run belongs to, plus what the harness reported about itself */
  | { type: "session"; session: AgentSession; resolvedModel?: string; harnessVersion?: string }
  /** incremental text (chat only) */
  | { type: "output-delta"; text: string }
  /** a complete block of text */
  | { type: "output"; text: string }
  | { type: "action"; action: AgentAction }
  | { type: "usage"; usage: AgentUsage }
  /** terminal; always emitted exactly once, even when the run never started */
  | { type: "completed"; ok: boolean; error?: string; session?: AgentSession };

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  /** stop now; the stream still ends with `completed` */
  cancel(): void;
}

/* --------------------------------------------------------------- handoff */

export interface HandoffContext {
  /** a file holding the instructions the continued session should get */
  contextPath: string;
  /** readable roots the context file points at */
  readRoots: string[];
}

export interface AgentHandoff {
  /** a shell one-liner the reader pastes into a terminal */
  command: string;
}

/* --------------------------------------------------------------- harness */

export interface AgentHarness {
  readonly manifest: HarnessManifest;
  probe(exec: Exec): HarnessStatus;
  run(request: AgentRunRequest): AgentRun;
  /** whether `session` can be continued by a run in `cwd` */
  canResume(session: AgentSession, cwd: string): boolean;
  createHandoff?(session: AgentSession, context: HandoffContext): AgentHandoff;
}
