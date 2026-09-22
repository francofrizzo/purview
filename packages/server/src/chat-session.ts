import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  keyToString,
  loadState,
  prCheckoutPath,
  prDir,
  readMeta,
  stateRoot,
  type PrKey,
} from "@reviewer/core";
import { resolveRunCheckout } from "./pr-checkout.js";
import { runClaude } from "./claude-runner.js";
import { skillDir } from "./skill-paths.js";
import { effectiveChatModel, effectiveRepoPath } from "./repo-config.js";
import { loadCommittedConfig } from "./team-config.js";
import { resolveCheckout, type CheckoutResolution } from "./worktree.js";
import {
  appendChatMessage,
  buildChatPrompt,
  chatSystemPrompt,
  chatToolFlags,
  handoffCommand,
  newSessionId,
  readChat,
  resolveRefs,
  terminalContext,
  writeChat,
  type ChatRef,
} from "./chat.js";
import { HttpError } from "./http-error.js";

/**
 * A chat turn runs independently of the HTTP request that started it: the SSE
 * response subscribes to an emitter, and the run persists its answer to
 * chat.json whether or not anyone is still listening. Closing the browser tab
 * mid-answer must not lose the answer.
 */

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "done"; message: { role: "assistant"; text: string; ts: string } }
  | { type: "error"; error: string };

export interface ChatTurn {
  emitter: EventEmitter;
  /** events already emitted before the subscriber attached */
  backlog: ChatStreamEvent[];
  done: Promise<void>;
}

const turns = new Map<string, ChatTurn>();

export function chatBusy(key: PrKey): boolean {
  return turns.has(keyToString(key));
}

const CHAT_TIMEOUT_MS = 10 * 60_000;

/**
 * Environment the chat's Claude child (and so its Bash tool, and so the
 * reviewer-state CLI it runs) gets on top of the server's own:
 * PURVIEW_ACTOR=chat makes the CLI send `X-Purview-Actor: chat`, and
 * PURVIEW_PORT points it at the port this server actually listens on.
 */
export function chatChildEnv(serverPort?: number): Record<string, string> {
  return {
    PURVIEW_ACTOR: "chat",
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
  // Resolution first: it is the only step allowed to reject the send. The
  // prompt itself is rebuilt once the checkout (and so the cwd) is known.
  resolveRefs(key, refs, root);

  appendChatMessage(
    key,
    { role: "user", text, ts: new Date().toISOString(), refs: refs.length ? refs : undefined },
    root,
  );

  const meta = (() => {
    try {
      return readMeta(key, root);
    } catch {
      return undefined;
    }
  })();
  const stateDir = prDir(key, root);
  const flags = chatToolFlags();
  const state = loadState(key, root);
  const revisionInfo = state.revisions.find((r) => r.revision === state.currentRevision);
  const headSha = revisionInfo?.headSha;
  // Cached per revision; the chat sees the same layered rubric as the analysis.
  const committed = loadCommittedConfig(key, root);

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const backlog: ChatStreamEvent[] = [];
  const emit = (event: ChatStreamEvent) => {
    backlog.push(event);
    emitter.emit("event", event);
  };

  const done = (async () => {
    let full = "";
    /** text Claude wrote before its latest tool call (see the `tool` case) */
    let narration = "";
    let streamed = false;
    let failure: string | undefined;
    let resolvedSessionId: string | null = chat.sessionId;
    let cwd = stateDir;
    try {
      // Resolved per turn: the managed checkout follows the current head, and
      // a reader worktree for this PR's branch may have appeared or vanished.
      const checkout = await resolveRunCheckout(key, root, {
        meta: meta ?? null,
        revision: revisionInfo,
        label: "chat",
        onPreparing: () => emit({ type: "tool", name: "checkout", detail: "preparing checkout" }),
      });
      if (checkout.error) {
        console.warn(`[chat] ${keyStr}: ${checkout.error}; running without a checkout`);
      }
      const addDirs = [skillDir()];
      if (checkout.path) {
        // The checkout is the more useful working directory (grep/glob land in
        // the code), so the state dir becomes the extra root instead.
        cwd = checkout.path;
        addDirs.push(stateDir);
      }

      // The CLI files sessions per cwd: resuming from another cwd may not find
      // the session, so a changed (or unknown) cwd starts a fresh session and
      // replays the kept transcript, exactly like a rewind does.
      const resume = chat.sessionId !== null && chat.sessionCwd === cwd;
      const sessionId = resume ? chat.sessionId! : newSessionId();
      resolvedSessionId = sessionId;
      const prompt = buildChatPrompt(
        key,
        text,
        refs,
        { sessionId: resume ? chat.sessionId : null, priorMessages: chat.messages },
        root,
      );

      const run = runClaude({
        label: "chat",
        prompt,
        cwd,
        addDirs,
        ...flags,
        // The system prompt is re-sent on resume too: it is cheap, and it keeps
        // the read-only contract in force for every turn.
        systemPrompt: chatSystemPrompt(key, root, { resolution: checkout, headSha }, { committed }),
        // Session pin first, then the layered repo/global default. Never
        // absent: an unset model would fall through to the CLI's own default.
        model: chat.model ?? effectiveChatModel(key, root, { meta: meta ?? null }),
        sessionId: resume ? undefined : sessionId,
        resumeSessionId: resume ? sessionId : undefined,
        partialMessages: true,
        timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
        // Marks the chat's `reviewer-state comment` calls as Claude's (the
        // server enforces draft-only on them) and points them at this server.
        env: chatChildEnv(opts.serverPort),
      });

      for await (const event of run.events) {
        switch (event.type) {
          case "session":
            resolvedSessionId = event.sessionId;
            break;
          case "delta":
            streamed = true;
            emit({ type: "delta", text: event.text });
            break;
          case "text":
            // Complete blocks are the authoritative transcript; when deltas
            // were streamed they already carried this text to the client.
            full += (full ? "\n" : "") + event.text;
            if (!streamed) emit({ type: "delta", text: event.text });
            break;
          case "tool":
            // Text before a tool call is narration ("Git is denied, I'll read
            // the files directly"), not the answer: the saved reply is what
            // Claude wrote after its last tool call. The narration is kept
            // only as a fallback for a turn that ends on a tool call.
            // `result-error` is the runner's end-of-run error report, not a
            // tool Claude used, and must not discard the answer before it.
            if (event.name !== "result-error" && full) {
              narration = full;
              full = "";
            }
            emit({ type: "tool", name: event.name, detail: event.detail });
            break;
          case "done":
            if (!event.ok) failure = event.error ?? "claude run failed";
            break;
        }
      }
    } catch (err) {
      failure = (err as Error).message;
    }

    if (!full) full = narration;
    const ts = new Date().toISOString();
    const session = { sessionId: resolvedSessionId, sessionCwd: resolvedSessionId ? cwd : null };
    if (failure && !full) {
      writeChat(key, { ...readChat(key, root), ...session }, root);
      emit({ type: "error", error: failure });
    } else {
      const current = readChat(key, root);
      writeChat(
        key,
        {
          ...current,
          ...session,
          messages: [...current.messages, { role: "assistant", text: full, ts }],
        },
        root,
      );
      emit({ type: "done", message: { role: "assistant", text: full, ts } });
      if (failure) emit({ type: "error", error: failure });
    }
    turns.delete(keyStr);
  })();

  const turn: ChatTurn = { emitter, backlog, done };
  turns.set(keyStr, turn);
  return turn;
}

/* ------------------------------------------------------ terminal hand-off */

export interface ChatHandoff {
  command: string;
  cwd: string;
  sessionId: string;
  contextPath: string;
}

export function terminalContextPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "terminal-context.md");
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The checkout the session actually lives in, described without touching it:
 * the hand-off must not fetch, move or create anything, and `--resume` only
 * works from the cwd the session was filed under, so that cwd is the truth
 * here — not whatever a fresh turn would resolve to.
 */
function sessionCheckout(
  key: PrKey,
  root: string,
  cwd: string,
): { resolution: CheckoutResolution; headSha?: string } | undefined {
  const real = realOrSelf(cwd);
  if (real === realOrSelf(prDir(key, root))) return undefined; // ran without a checkout

  const state = loadState(key, root);
  const revisionHead = state.revisions.find((r) => r.revision === state.currentRevision)?.headSha;

  if (real === realOrSelf(prCheckoutPath(key, root))) {
    // Name the commit the checkout is really on: it only moves on a turn, so
    // it can trail a revision that arrived since.
    let headSha = revisionHead ?? "";
    try {
      headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    } catch {
      /* keep the revision's head */
    }
    return { resolution: { path: cwd, resolvedWorktree: true, managed: { headSha } }, headSha };
  }

  // A reader's own worktree. Re-resolving is local-only (no fetch) and keeps
  // the mismatch warning when the tree is on another branch.
  let meta: ReturnType<typeof readMeta> | null = null;
  try {
    meta = readMeta(key, root);
  } catch {
    /* no meta */
  }
  const resolved = resolveCheckout(effectiveRepoPath(key, root, { meta }), {
    headRef: meta?.headRef,
    headSha: revisionHead,
  });
  if (resolved.path && realOrSelf(resolved.path) === real) {
    return { resolution: resolved, headSha: revisionHead };
  }
  return { resolution: { path: cwd, resolvedWorktree: false }, headSha: revisionHead };
}

/**
 * Hand the chat's Claude session to the reader's own terminal: write the PR
 * context next to the state (overwritten, so it always matches the current
 * analysis) and return the one-liner that forks the session with it.
 */
export function chatHandoff(key: PrKey, root = stateRoot()): ChatHandoff {
  if (chatBusy(key)) {
    throw new HttpError(
      409,
      "chat_busy",
      "Claude is still answering. Wait for the reply to finish, then continue in Claude Code.",
    );
  }
  const chat = readChat(key, root);
  if (!chat.sessionId) {
    throw new HttpError(
      409,
      "no_session",
      "This chat has no Claude session yet. Send a message first, then continue in Claude Code.",
    );
  }
  if (!chat.sessionCwd) {
    throw new HttpError(
      409,
      "no_session",
      "Purview does not know where this chat's session lives (it predates that being recorded). " +
        "Send one more message first; from then on it can continue in Claude Code.",
    );
  }
  if (!fs.existsSync(chat.sessionCwd)) {
    throw new HttpError(
      409,
      "session_cwd_missing",
      `The chat's working directory ${chat.sessionCwd} no longer exists. ` +
        "Send a message to move the session, then continue in Claude Code.",
    );
  }

  const context = terminalContext(key, root, {
    checkout: sessionCheckout(key, root, chat.sessionCwd),
    committed: loadCommittedConfig(key, root),
  });
  const contextPath = terminalContextPath(key, root);
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, context, "utf8");

  const handoff = { cwd: chat.sessionCwd, sessionId: chat.sessionId, contextPath };
  // The context file sends the fork to the PR state dir (triage, show, the
  // diff) and the skill docs; granting them up front spares a permission
  // prompt on the first read. Skipped when the session already lives there.
  const addDirs = [prDir(key, root), skillDir()].filter((d) => d !== chat.sessionCwd);
  return { ...handoff, command: handoffCommand({ ...handoff, addDirs }) };
}

/** Only for tests: wait for any in-flight turn on this PR. */
export function chatTurnDone(key: PrKey): Promise<void> {
  return turns.get(keyToString(key))?.done ?? Promise.resolve();
}
