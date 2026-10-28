import { log, shortKey, duration } from "./log.js";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  cachedViewerLogin,
  keyToString,
  loadState,
  prDir,
  readMeta,
  stateRoot,
  type PrKey,
} from "@reviewer/core";
import { ensureCodingCheckout, resolveRunCheckout } from "./pr-checkout.js";
import { cliEnvironment, getHarness } from "./agent/registry.js";
import { actionGerund } from "./agent/types.js";
import type { AgentAction, AgentRun, AgentSession, HarnessId } from "./agent/types.js";
import { skillDir } from "./skill-paths.js";
import { effectiveChatAgent, effectiveRepoPath } from "./repo-config.js";
import { loadCommittedConfig } from "./team-config.js";
import {
  appendChatMessage,
  buildChatPrompt,
  CHAT_CLI_SUBCOMMANDS,
  chatSystemPrompt,
  readChat,
  replayTranscript,
  resolveRefs,
  terminalContext,
  writeChat,
  type ChatMessage,
  type ChatRef,
} from "./chat.js";
import { HttpError } from "./http-error.js";
import { authoredByYou } from "./comment-audience.js";
import { readConfig } from "./config.js";
import { reviewSystemPrompt, checkoutGuidance } from "./agent/review-tools/prompts.js";

/**
 * A chat turn runs independently of the HTTP request that started it: the SSE
 * response subscribes to an emitter, and the run persists its answer to
 * chat.json whether or not anyone is still listening. Closing the browser tab
 * mid-answer must not lose the answer.
 */

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  /** `kind` is the normalized action kind; absent on Purview's own steps (e.g. the checkout) */
  | { type: "tool"; name: string; detail: string; kind?: AgentAction["kind"] }
  | { type: "done"; message: ChatMessage & { role: "assistant" } }
  | { type: "error"; error: string };

export interface ChatTurn {
  emitter: EventEmitter;
  /** events already emitted before the subscriber attached */
  backlog: ChatStreamEvent[];
  done: Promise<void>;
  /**
   * Stop the turn: the agent child gets SIGTERM (then SIGKILL after a grace),
   * and the turn finalizes with whatever had streamed so far as an
   * `interrupted` reply. Idempotent; `done` still resolves exactly once.
   */
  stop(): void;
}

const turns = new Map<string, ChatTurn>();

export function chatBusy(key: PrKey): boolean {
  return turns.has(keyToString(key));
}

/** `stop()` landed before the agent child was spawned; nothing to kill. */
class StoppedBeforeRun extends Error {}

/**
 * Stop the turn running for this PR and wait for it to finalize, so the
 * caller's response means "the slot is free": a send right after it is not
 * refused with `chat_busy`. Resolves with the interrupted reply as persisted.
 */
export async function stopChatTurn(key: PrKey): Promise<ChatMessage & { role: "assistant" }> {
  const keyStr = keyToString(key);
  const turn = turns.get(keyStr);
  if (!turn) throw new HttpError(409, "chat_idle", `No chat turn is running for ${keyStr}`);
  turn.stop();
  await turn.done;
  const done = turn.backlog.find((e) => e.type === "done");
  if (!done || done.type !== "done") {
    // Only reachable if the turn finished on an error in the same instant.
    throw new HttpError(409, "chat_idle", `The chat turn for ${keyStr} had already ended`);
  }
  return done.message;
}

const CHAT_TIMEOUT_MS = 10 * 60_000;

/**
 * Environment the chat's agent child (and so its shell tool, and so the
 * reviewer-state CLI it runs) gets on top of the server's own:
 * PURVIEW_ACTOR=chat makes the CLI send `X-Purview-Actor: chat`,
 * PURVIEW_AGENT names the harness it runs on (which labels its drafts), and
 * PURVIEW_PORT points it at the port this server actually listens on.
 */
export function chatChildEnv(serverPort?: number, harness?: HarnessId): Record<string, string> {
  return {
    PURVIEW_ACTOR: "chat",
    ...(harness ? { PURVIEW_AGENT: harness } : {}),
    ...(serverPort !== undefined ? { PURVIEW_PORT: String(serverPort) } : {}),
  };
}

/**
 * Start a turn. Throws before anything is persisted if a reference cannot be
 * resolved (no partial sends) or if a turn is already in flight for this PR.
 */
export function startChatTurn(
  key: PrKey,
  input: { text: string; refs?: ChatRef[] },
  root = stateRoot(),
  opts: { timeoutMs?: number; serverPort?: number } = {},
): ChatTurn {
  const keyStr = keyToString(key);
  if (turns.has(keyStr)) {
    throw new HttpError(409, "chat_busy", `A chat turn is already running for ${keyStr}`);
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new HttpError(400, "invalid_body", "Body must include a non-empty { text }");
  const refs = input.refs ?? [];

  // Read before this turn's message is appended: `buildChatPrompt` replays
  // history when the session is fresh, and must not replay the very message
  // it is about to send.
  const chat = readChat(key, root);
  // Resolution first: it (and the agent choice below) are the only steps
  // allowed to reject the send. The prompt itself is rebuilt once the
  // checkout (and so the cwd) is known.
  resolveRefs(key, refs, root);

  const meta = (() => {
    try {
      return readMeta(key, root);
    } catch {
      return undefined;
    }
  })();
  // The conversation's own pin first, then the layered repo/global choice.
  // Never absent: an unset model would fall through to the harness's own
  // default. A choice that cannot run rejects the send like a bad reference
  // does, before anything is persisted.
  const agent = effectiveChatAgent(key, root, { meta: meta ?? null }, chat.agent);
  const harness = getHarness(agent.harness);

  appendChatMessage(
    key,
    { role: "user", text, ts: new Date().toISOString(), refs: refs.length ? refs : undefined },
    root,
  );

  const stateDir = prDir(key, root);
  const stored: AgentSession | undefined = chat.session ?? undefined;
  const state = loadState(key, root);
  const revisionInfo = state.revisions.find((r) => r.revision === state.currentRevision);
  const headSha = revisionInfo?.headSha;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const backlog: ChatStreamEvent[] = [];
  const emit = (event: ChatStreamEvent) => {
    backlog.push(event);
    emitter.emit("event", event);
  };

  // `stop()` may arrive before the child exists (the checkout is still being
  // resolved): the flag makes the turn skip the run altogether, and the run
  // handle lets a later stop reach the child.
  const turnStarted = Date.now();
  let toolsUsed = 0;
  log.info("chat", `${shortKey(key)}  turn started`, { model: agent.model });
  let stopped = false;
  let run: AgentRun | undefined;
  const stop = () => {
    stopped = true;
    run?.cancel();
  };

  const done = (async () => {
    let full = "";
    /** text the agent wrote before its latest action (see the `action` case) */
    let narration = "";
    /**
     * Deltas of the block in progress. A complete `output` block supersedes
     * them; only a stop mid-block (no `output` ever arrives for it) needs them.
     */
    let partial = "";
    let streamed = false;
    let failure: string | undefined;
    /** the harness reported a clean end: a stop landing after it changes nothing */
    let completed = false;
    let session = stored;
    try {
      // Cached per revision; the chat sees the same layered rubric as the analysis.
      const committed = await loadCommittedConfig(key, root);
      // Resolved per turn: the managed checkout follows the current head, and
      // a reader worktree for this PR's branch may have appeared or vanished.
      const checkout = await resolveRunCheckout(key, root, {
        meta: meta ?? null,
        revision: revisionInfo,
        label: "chat",
        onStep: (detail) => emit({ type: "tool", name: "checkout", detail }),
      });
      if (checkout.error) {
        log.warn("chat", `${shortKey(key)}  checkout unavailable`, { reason: checkout.error });
      }
      let cwd = stateDir;
      const readRoots = [skillDir()];
      if (checkout.path) {
        // The checkout is the more useful working directory (grep/glob land in
        // the code), so the state dir becomes the extra root instead.
        cwd = checkout.path;
        readRoots.push(stateDir);
      }

      // Built every turn: they carry the current head, checkout, CLI path and
      // team overlays, and the read-only contract.
      const instructions = harness.manifest.reviewTools
        ? reviewSystemPrompt(key, root, { task: "chat", committed })
        : chatSystemPrompt(key, root, { resolution: checkout, headSha }, { committed });
      // A session the harness cannot continue with these instructions from
      // this cwd (or none at all) means a fresh session that replays the kept
      // transcript, exactly like a rewind does. Claude Code, for one, freezes
      // a session's instructions at its first turn, so any change to them
      // (a new revision, another checkout) starts over.
      const resume = stored && harness.canResume(stored, { cwd, instructions }) ? stored : undefined;
      const prompt = buildChatPrompt(
        key,
        text,
        refs,
        { sessionId: resume ? resume.id : null, priorMessages: chat.messages },
        root,
      );

      if (stopped) throw new StoppedBeforeRun();
      run = harness.run({
        task: { kind: "chat", reviewerCommands: CHAT_CLI_SUBCOMMANDS },
        prompt: harness.manifest.reviewTools ? `${checkoutGuidance(checkout)}\n\n${prompt}` : prompt,
        review: harness.manifest.reviewTools ? { root, key, revision: state.currentRevision,
          checkout: checkout.error ? undefined : checkout.path || undefined,
          serverUrl: opts.serverPort === undefined ? undefined : `http://127.0.0.1:${opts.serverPort}` } : undefined,
        cwd,
        readRoots,
        instructions,
        model: agent.model,
        session: resume ?? "new",
        timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
        // Marks the chat's `reviewer-state comment` calls as the agent's (the
        // server enforces draft-only on them) and points them at this server.
        environment: { ...chatChildEnv(opts.serverPort, harness.manifest.id), ...cliEnvironment(harness.manifest) },
      });

      for await (const event of run.events) {
        switch (event.type) {
          case "session":
            session = event.session;
            break;
          case "output-delta":
            streamed = true;
            partial += event.text;
            emit({ type: "delta", text: event.text });
            break;
          case "output":
            // Complete blocks are the authoritative transcript; when deltas
            // were streamed they already carried this text to the client.
            full += (full ? "\n" : "") + event.text;
            partial = "";
            if (!streamed) emit({ type: "delta", text: event.text });
            break;
          case "action":
            toolsUsed++;
            // Text before an action is narration ("Git is denied, I'll read
            // the files directly"), not the answer: the saved reply is what
            // the agent wrote after its last action. The narration is kept
            // only as a fallback for a turn that ends on an action.
            if (full) {
              narration = full;
              full = "";
            }
            partial = "";
            emit({
              type: "tool",
              name: actionGerund(event.action.name),
              detail: event.action.summary,
              kind: event.action.kind,
            });
            break;
          case "completed":
            if (event.ok) completed = true;
            else failure = event.error ?? "agent run failed";
            if (event.session) session = event.session;
            break;
        }
      }
    } catch (err) {
      if (!(err instanceof StoppedBeforeRun)) failure = (err as Error).message;
    }

    log[failure && !stopped ? "error" : "info"]("chat", `${shortKey(key)}  ${stopped && !completed ? "stopped" : failure ? "failed" : "turn finished"}`, { duration: duration(Date.now() - turnStarted), tools: toolsUsed, reason: stopped ? undefined : failure });
    const ts = new Date().toISOString();
    const persisted = { session: session ?? null };
    if (stopped && !completed) {
      // A stopped turn is not a failure: the "cancelled" the harness reports
      // is what was asked for. The reply is whatever had streamed — the
      // block in progress included — and it is always persisted, even empty,
      // so the transcript shows that the question was answered by a stop
      // rather than left hanging. The session is kept: the harness's own
      // transcript has the partial turn, and the next message resumes it.
      if (partial) full += (full ? "\n" : "") + partial;
      if (!full) full = narration;
      const message: ChatMessage & { role: "assistant" } = { role: "assistant", text: full, ts, interrupted: true };
      const current = readChat(key, root);
      writeChat(key, { ...current, ...persisted, messages: [...current.messages, message] }, root);
      emit({ type: "done", message });
    } else if (failure && !full && !narration) {
      writeChat(key, { ...readChat(key, root), ...persisted }, root);
      emit({ type: "error", error: failure });
    } else {
      if (!full) full = narration;
      const current = readChat(key, root);
      writeChat(
        key,
        {
          ...current,
          ...persisted,
          messages: [...current.messages, { role: "assistant", text: full, ts }],
        },
        root,
      );
      emit({ type: "done", message: { role: "assistant", text: full, ts } });
      if (failure) emit({ type: "error", error: failure });
    }
    turns.delete(keyStr);
  })();

  const turn: ChatTurn = { emitter, backlog, done, stop };
  turns.set(keyStr, turn);
  return turn;
}

/* ------------------------------------------------------ terminal hand-off */

export interface ChatHandoff {
  command: string;
  cwd: string;
  branch: string;
  startSha: string;
  headSha: string;
  /** false: the reader's own checkout of their PR branch, not a worktree Purview made */
  owned: boolean;
  contextPath: string;
}

export function terminalContextPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "terminal-context.md");
}

/**
 * "Open in Claude Code": a fresh, ordinary Claude Code session in a writable
 * worktree (see `ensureCodingCheckout`), started with the review's context and
 * the chat so far as text. Never a resume of the panel's session: that one
 * keeps its read-only system prompt whatever a fork is told.
 */
export async function chatHandoff(key: PrKey, root = stateRoot()): Promise<ChatHandoff> {
  // Claude Code runs the command whichever harness the chat is on.
  const harness = getHarness("claude-code");
  if (chatBusy(key)) {
    throw new HttpError(409, "chat_busy", "Claude is still answering. Wait for the reply to finish, then open Claude Code.");
  }
  const meta = readMeta(key, root);
  const state = loadState(key, root);
  const revision = state.revisions.find((r) => r.revision === state.currentRevision);
  const ownBranch =
    meta.headRef && authoredByYou(meta.author, cachedViewerLogin(key.host, root), readConfig(root).extraAuthors)
      ? meta.headRef
      : undefined;
  const workspace = await ensureCodingCheckout(key, {
    repoPath: effectiveRepoPath(key, root, { meta }),
    headSha: revision?.headSha,
    ownBranch,
    root,
  });
  if ("error" in workspace) throw new HttpError(409, "coding_checkout_unavailable", workspace.error);
  const context = terminalContext(key, root, {
    coding: { ...workspace, prBranch: workspace.branch === ownBranch },
    conversation: replayTranscript(readChat(key, root).messages),
    committed: await loadCommittedConfig(key, root),
  });
  const contextPath = terminalContextPath(key, root);
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, context, "utf8");

  const { command } = harness.createHandoff!({
    cwd: workspace.path,
    contextPath,
    readRoots: [prDir(key, root), skillDir()],
  });
  const { path: cwd, branch, startSha, headSha, owned } = workspace;
  return { command, cwd, branch, startSha, headSha, owned, contextPath };
}

/** Only for tests: wait for any in-flight turn on this PR. */
export function chatTurnDone(key: PrKey): Promise<void> {
  return turns.get(keyToString(key))?.done ?? Promise.resolve();
}
