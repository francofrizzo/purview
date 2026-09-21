import { EventEmitter } from "node:events";
import {
  keyToString,
  loadState,
  prDir,
  readMeta,
  stateRoot,
  type PrKey,
} from "@reviewer/core";
import { resolveRunCheckout } from "./pr-checkout.js";
import { runClaude } from "./claude-runner.js";
import { skillDir } from "./skill-paths.js";
import { effectiveChatModel } from "./repo-config.js";
import { loadCommittedConfig } from "./team-config.js";
import {
  appendChatMessage,
  buildChatPrompt,
  chatSystemPrompt,
  chatToolFlags,
  newSessionId,
  readChat,
  resolveRefs,
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

/** Only for tests: wait for any in-flight turn on this PR. */
export function chatTurnDone(key: PrKey): Promise<void> {
  return turns.get(keyToString(key))?.done ?? Promise.resolve();
}
