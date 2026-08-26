import { EventEmitter } from "node:events";
import {
  keyToString,
  loadState,
  prDir,
  readMeta,
  stateRoot,
  type PrKey,
} from "@reviewer/core";
import { resolveCheckout } from "./worktree.js";
import { runClaude } from "./claude-runner.js";
import { skillDir } from "./skill-paths.js";
import { effectiveRepoPath } from "./repo-config.js";
import { loadCommittedConfig } from "./team-config.js";
import {
  appendChatMessage,
  buildChatPrompt,
  chatSystemPrompt,
  chatToolFlags,
  newSessionId,
  readChat,
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
 * Start a turn. Throws before anything is persisted if a reference cannot be
 * resolved (no partial sends) or if a turn is already in flight for this PR.
 */
export function startChatTurn(
  key: PrKey,
  input: { text: string; refs?: ChatRef[] },
  root = stateRoot(),
  opts: { timeoutMs?: number } = {},
): ChatTurn {
  const keyStr = keyToString(key);
  if (turns.has(keyStr)) {
    throw new HttpError(409, "chat_busy", `A chat turn is already running for ${keyStr}`);
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new HttpError(400, "invalid_body", "Body must include a non-empty { text }");
  const refs = input.refs ?? [];

  // Resolution first: it is the only step allowed to reject the send.
  const prompt = buildChatPrompt(key, text, refs, root);

  const chat = readChat(key, root);
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
  const addDirs = [skillDir()];
  // Resolved per turn: a worktree for this PR's branch may have appeared (or
  // been removed) since the previous message.
  const state = loadState(key, root);
  const headSha = state.revisions.find((r) => r.revision === state.currentRevision)?.headSha;
  const checkout = resolveCheckout(effectiveRepoPath(key, root, { meta: meta ?? null }), {
    headRef: meta?.headRef,
    headSha,
  });
  if (checkout.error) {
    console.warn(`[chat] ${keyStr}: ${checkout.error}; running without a checkout`);
  }
  // Cached per revision; the chat sees the same layered rubric as the analysis.
  const committed = loadCommittedConfig(key, root);
  let cwd = stateDir;
  if (checkout.path) {
    // The checkout is the more useful working directory (grep/glob land in the
    // code), so the state dir becomes the extra root instead.
    cwd = checkout.path;
    addDirs.push(stateDir);
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const backlog: ChatStreamEvent[] = [];
  const emit = (event: ChatStreamEvent) => {
    backlog.push(event);
    emitter.emit("event", event);
  };

  const isFirstTurn = chat.sessionId === null;
  const sessionId = chat.sessionId ?? newSessionId();

  const run = runClaude({
    label: "chat",
    prompt,
    cwd,
    addDirs,
    ...flags,
    // The system prompt is re-sent on resume too: it is cheap, and it keeps
    // the read-only contract in force for every turn.
    systemPrompt: chatSystemPrompt(key, root, { resolution: checkout, headSha }, { committed }),
    sessionId: isFirstTurn ? sessionId : undefined,
    resumeSessionId: isFirstTurn ? undefined : sessionId,
    partialMessages: true,
    timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
  });

  const done = (async () => {
    let full = "";
    let streamed = false;
    let failure: string | undefined;
    let resolvedSessionId = sessionId;
    try {
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

    const ts = new Date().toISOString();
    if (failure && !full) {
      writeChat(key, { ...readChat(key, root), sessionId: resolvedSessionId }, root);
      emit({ type: "error", error: failure });
    } else {
      const current = readChat(key, root);
      writeChat(
        key,
        {
          sessionId: resolvedSessionId,
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

/** Only for tests: wait for any in-flight turn on this PR. */
export function chatTurnDone(key: PrKey): Promise<void> {
  return turns.get(keyToString(key))?.done ?? Promise.resolve();
}
