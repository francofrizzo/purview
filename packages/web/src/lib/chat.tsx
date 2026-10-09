/**
 * Chat session state, held above the routes.
 *
 * The panel itself is stateless about the conversation: everything that must
 * outlive a re-render (or the reader switching units, files and tabs inside the
 * PR view) lives here — the transcript, the in-flight stream, the refs staged
 * for the next message, and whether the panel is open.
 *
 * Only one PR is ever on screen, so the store keeps one session and resets it
 * when the key changes. The stream is *not* cancelled when the panel closes:
 * closing the panel is a view decision, and losing a half-written answer to it
 * would be surprising.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { qk, useAgentName } from "../api/hooks";
import { errorText } from "../api/errors";
import type { ChatAgentSelection, ChatMessage, ChatRef, ChatStreamEvent, ResolvedAgent, ToolKind } from "../api/types";
import {
  autoRefReducer,
  effectiveRefs as deriveEffectiveRefs,
  initialAutoRefState,
  isAutoRef as deriveIsAutoRef,
} from "./autoRef";
import { addRef as addRefTo, refKey, removeRef as removeRefFrom } from "./chatRefs";
import { isCommentWriteTool } from "./comments";

export interface ToolActivity {
  name: string;
  detail?: string;
  kind?: ToolKind;
}

/** A transcript entry; `tools` is local colour the wire format does not carry. */
export type LocalMessage = ChatMessage & { tools?: ToolActivity[] };

/** A message typed while a reply was streaming, waiting for its turn. */
export interface QueuedMessage {
  id: number;
  text: string;
  /** captured when it was queued, so later chip changes don't leak into it */
  refs: ChatRef[];
}

export interface ChatFailure {
  message: string;
  /** exactly what was sent, so "retry" is a re-send and not a re-compose */
  retry: { text: string; refs: ChatRef[] };
}

interface ChatContextValue {
  prKey: string | null;
  open: boolean;
  setPrKey: (key: string | null) => void;
  openChat: () => void;
  closeChat: () => void;
  toggleChat: () => void;

  messages: LocalMessage[];
  loading: boolean;
  /** the reply being streamed right now, or null */
  streaming: { text: string; tools: ToolActivity[] } | null;
  busy: boolean;
  failure: ChatFailure | null;

  /** the agent the next message will use; null until the transcript loads */
  agent: ResolvedAgent | null;
  /** what the repo/global layers say, i.e. what "inherit" means here */
  configuredAgent: ResolvedAgent | null;
  /** non-null only while this conversation overrides the configured agent */
  sessionAgent: ChatAgentSelection | null;
  /** the harness the conversation's session belongs to, while there is one */
  sessionHarness: string | null;
  /** pin (or unpin, with null) the agent; applies from the next message on */
  setAgent: (agent: ChatAgentSelection | null) => Promise<void>;

  refs: ChatRef[];
  attachRef: (ref: ChatRef, options?: { open?: boolean }) => void;
  detachRef: (key: string) => void;
  clearRefs: () => void;

  /** explicit refs, else the auto-attached unit ref unless suppressed/absent */
  effectiveRefs: ChatRef[];
  /** whether `ref` is the auto-attached chip rather than an explicit one */
  isAutoRef: (ref: ChatRef) => boolean;
  /** the unit currently in context (units tab) drives the auto chip; null elsewhere */
  setUnitContext: (unitId: string | null) => void;
  /** dismiss the auto chip until the unit changes or the panel reopens */
  removeAutoRef: () => void;

  /**
   * `extraRefs` ride along on this one message only (e.g. the line a comment
   * box points at). While a reply is streaming (or a failure is unresolved)
   * the message is queued instead, and sent when the turn before it ends.
   */
  send: (text: string, extraRefs?: ChatRef[]) => void;
  /** messages waiting to be sent, oldest first */
  queue: QueuedMessage[];
  /** drop a queued message; returns it, so "edit" can load it back into the composer */
  unqueue: (id: number) => QueuedMessage | undefined;
  /**
   * Stop the reply in flight. The server keeps what had streamed as an
   * `interrupted` message and ends the stream, which is what moves the queue
   * on; this resolves when the stop was acknowledged (or refused: idle).
   */
  stop: () => Promise<void>;
  /**
   * Stop the current reply and send this queued message next: it moves to
   * the head of the queue, the rest keep their order behind it.
   */
  sendQueuedNow: (id: number) => void;
  /** give up on the failed turn (no retry), letting the queue move on */
  dismissFailure: () => void;
  retry: () => void;
  clearConversation: () => Promise<void>;

  /** index of the user message currently loaded into the composer, or null */
  editingIndex: number | null;
  /** load a user message's text/refs into the composer for editing; caller supplies the text */
  startEdit: (index: number) => void;
  /** leave editing mode; the composer's own contents are the caller's to restore */
  cancelEdit: () => void;
  /** resend the message at `editingIndex` with new text — discards it and everything after first */
  sendEdit: (text: string) => void;
  /** discard the message at `index` and everything after it */
  rewindTo: (index: number) => Promise<void>;
  /** true from a rewind/edit until the next turn finishes — the session is fresh and will replay history */
  sessionReset: boolean;
}

const ChatContext = createContext<ChatContextValue | null>(null);

type AgentState = Pick<ChatContextValue, "agent" | "configuredAgent" | "sessionAgent" | "sessionHarness">;

const NO_AGENT: AgentState = { agent: null, configuredAgent: null, sessionAgent: null, sessionHarness: null };

/**
 * What a pin will resolve to, for the instant before the server says so: the
 * pin's model when it names one on the configured harness, else the
 * configured agent. A different harness waits for the server's answer.
 */
function optimisticAgent(cur: AgentState, pin: ChatAgentSelection | null): ResolvedAgent | null {
  const configured = cur.configuredAgent;
  if (!configured || !pin) return configured;
  if (pin.harness !== configured.harness) return cur.agent;
  return pin.model
    ? { ...configured, model: pin.model, sources: { ...configured.sources, model: "chat" } }
    : configured;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [prKey, setPrKeyState] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState<{ text: string; tools: ToolActivity[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  const [refs, setRefs] = useState<ChatRef[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [preEditRefs, setPreEditRefs] = useState<ChatRef[] | null>(null);
  const [sessionReset, setSessionReset] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const nextQueueId = useRef(1);
  const [autoRefState, dispatchAutoRef] = useReducer(autoRefReducer, initialAutoRefState);
  // Empty until the transcript arrives: the agent is the server's to resolve,
  // so there is no default worth guessing at here.
  const [agentState, setAgentState] = useState<AgentState>(NO_AGENT);

  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef<string | null>(null);
  keyRef.current = prKey;
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;

  // Switching PRs is a different conversation: drop everything, including any
  // stream still running for the PR we just left.
  const setPrKey = useCallback((key: string | null) => {
    setPrKeyState((cur) => {
      if (cur === key) return cur;
      abortRef.current?.abort();
      abortRef.current = null;
      setMessages([]);
      setStreaming(null);
      setBusy(false);
      setFailure(null);
      setRefs([]);
      setEditingIndex(null);
      setPreEditRefs(null);
      setSessionReset(false);
      setQueue([]);
      dispatchAutoRef({ type: "reset" });
      setAgentState(NO_AGENT);
      return key;
    });
  }, []);

  // Reopening the panel is one of the two ways the auto chip's dismissal
  // lifts (the other is switching units) — watch `open` rather than routing
  // this through every place that can set it true (openChat, toggleChat,
  // attachRef's implicit open) so none of them have to remember it.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) dispatchAutoRef({ type: "panel-opened" });
    prevOpenRef.current = open;
  }, [open]);

  // Load the transcript once per PR — the server owns the history.
  useEffect(() => {
    if (!prKey) return;
    let alive = true;
    setLoading(true);
    void api
      .getChat(prKey)
      .then((state) => {
        if (!alive) return;
        setMessages(state.messages);
        setBusy(state.busy);
        setAgentState({
          agent: state.agent,
          configuredAgent: state.configuredAgent,
          sessionAgent: state.sessionAgent,
          sessionHarness: state.sessionHarness,
        });
      })
      .catch(() => {
        /* an unreachable chat endpoint leaves an empty transcript, not an error
           wall: the reader can still see the rest of the review */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [prKey]);

  const attachRef = useCallback((ref: ChatRef, options?: { open?: boolean }) => {
    setRefs((cur) => addRefTo(cur, ref));
    if (options?.open !== false) setOpen(true);
  }, []);

  const detachRef = useCallback((key: string) => {
    setRefs((cur) => removeRefFrom(cur, key));
  }, []);

  const clearRefs = useCallback(() => setRefs([]), []);

  const setUnitContext = useCallback((unitId: string | null) => {
    dispatchAutoRef({ type: "select-unit", unitId });
  }, []);

  const removeAutoRef = useCallback(() => {
    dispatchAutoRef({ type: "remove-auto" });
  }, []);

  const effectiveRefs = useMemo(() => deriveEffectiveRefs(refs, autoRefState), [refs, autoRefState]);
  const isAutoRef = useCallback((ref: ChatRef) => deriveIsAutoRef(ref, refs, autoRefState), [refs, autoRefState]);

  /**
   * `editIndex` set means this turn is an edit's resend: the message at that
   * index (and everything after) was already truncated by the caller, and
   * the server does the same truncation itself before resending, via the
   * edit endpoint rather than the plain one.
   */
  const run = useCallback((key: string, text: string, sent: ChatRef[], editIndex?: number) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setFailure(null);
    // The note's whole point is "the *next* reply replays history"; once
    // that reply is in flight, it no longer describes something upcoming.
    setSessionReset(false);
    setStreaming({ text: "", tools: [] });

    // A plain object rather than locals: these are written from the event
    // callback, and TypeScript's narrowing of captured `let`s across an await
    // is not something to lean on.
    const outcome: {
      failed: string | null;
      message: LocalMessage | null;
      text: string;
      narration: string;
    } = {
      failed: null,
      message: null,
      text: "",
      narration: "",
    };

    // The chat can write draft comments (`reviewer-state comment ...`). A tool
    // event arrives when the agent *starts* a call, so the comments are refetched
    // on the next event after one (it has finished by then) and at turn end.
    const refreshComments = () =>
      void queryClient.invalidateQueries({ queryKey: qk.comments(key) });
    let commentWritePending = false;

    void (async () => {
      let seenTools: ToolActivity[] = [];
      const onEvent = (event: ChatStreamEvent) => {
        if (commentWritePending) {
          commentWritePending = false;
          refreshComments();
        }
        if (event.type === "tool" && isCommentWriteTool(event)) commentWritePending = true;
        if (event.type === "delta") {
          outcome.text += event.text;
          setStreaming((cur) => (cur ? { ...cur, text: cur.text + event.text } : cur));
        } else if (event.type === "tool") {
          const tool = { name: event.name, detail: event.detail, kind: event.kind };
          seenTools = [...seenTools, tool];
          // Text before a tool call is narration, not the answer; the server
          // saves only what follows the last tool call, so the live bubble
          // starts over too rather than gluing blocks together. Keep the old
          // text as the fallback for a stream that ends before any new text.
          if (outcome.text) outcome.narration = outcome.text;
          outcome.text = "";
          setStreaming((cur) => (cur ? { ...cur, text: "", tools: [...cur.tools, tool] } : cur));
        } else if (event.type === "done") {
          outcome.message = { ...event.message, tools: seenTools.length ? seenTools : undefined };
        } else if (event.type === "error") {
          outcome.failed = event.error;
        }
      };
      try {
        if (editIndex === undefined) {
          await api.streamChat(key, { text, ...(sent.length ? { refs: sent } : {}) }, onEvent, controller.signal);
        } else {
          await api.streamEditChat(
            key,
            { index: editIndex, text, ...(sent.length ? { refs: sent } : {}) },
            onEvent,
            controller.signal,
          );
        }
      } catch (err) {
        if (!controller.signal.aborted) outcome.failed = errorText(err);
      }
      // Even a cancelled or failed turn may have changed comments before it ended.
      if (seenTools.some(isCommentWriteTool)) refreshComments();
      if (controller.signal.aborted || keyRef.current !== key) return;

      abortRef.current = null;
      setStreaming(null);
      setBusy(false);
      if (outcome.failed) {
        setFailure({ message: outcome.failed, retry: { text, refs: sent } });
        return;
      }
      // A stream that ends without a `done` frame still leaves the text it did
      // produce; keeping it beats discarding a mostly-complete answer.
      const message: LocalMessage = outcome.message ?? {
        role: "assistant",
        text: outcome.text || outcome.narration,
        ts: new Date().toISOString(),
        tools: seenTools.length ? seenTools : undefined,
      };
      // An interrupted reply stays even when empty: its "stopped" marker is
      // what tells the reader why the question above it has no answer.
      if (message.text.trim() || message.interrupted) setMessages((cur) => [...cur, message]);
    })();
  }, [queryClient]);

  const sendNow = useCallback(
    (key: string, body: string, sent: ChatRef[]) => {
      setMessages((cur) => [
        ...cur,
        { role: "user", text: body, ts: new Date().toISOString(), refs: sent.length ? sent : undefined },
      ]);
      run(key, body, sent);
    },
    [run],
  );

  const send = useCallback(
    (text: string, extraRefs: ChatRef[] = []) => {
      const key = keyRef.current;
      const body = text.trim();
      if (!key || !body) return;
      // The auto ref rides along like any other — the server just sees a
      // unit ref — but it is never *consumed*: clearing explicit refs after
      // send leaves the auto chip to reappear (unless dismissed) for the
      // next turn, same unit.
      const sent = extraRefs.reduce(addRefTo, effectiveRefs);
      setRefs([]);
      // Behind a running turn, or behind messages already waiting (which a
      // failure holds): join the line rather than jump it.
      if (busy || queueRef.current.length) {
        setQueue((cur) => [...cur, { id: nextQueueId.current++, text: body, refs: sent }]);
        return;
      }
      sendNow(key, body, sent);
    },
    [busy, failure, effectiveRefs, sendNow],
  );

  const dismissFailure = useCallback(() => setFailure(null), []);

  // Only a request: the running stream sees the server's `done` (marked
  // interrupted) and winds the turn down itself, exactly as a natural end
  // would, so there is no second code path for the transcript to get out of
  // step on. A refusal (the turn ended on its own first) is nothing to show.
  const stop = useCallback(async () => {
    const key = keyRef.current;
    if (!key || !abortRef.current) return;
    await api.stopChat(key).catch(() => {});
  }, []);

  const sendQueuedNow = useCallback(
    (id: number) => {
      setQueue((cur) => {
        const pick = cur.find((q) => q.id === id);
        return pick ? [pick, ...cur.filter((q) => q.id !== id)] : cur;
      });
      void stop();
    },
    [stop],
  );

  const unqueue = useCallback((id: number) => {
    const found = queueRef.current.find((q) => q.id === id);
    setQueue((cur) => cur.filter((q) => q.id !== id));
    return found;
  }, []);

  // Drain: once a turn ends cleanly, the oldest queued message goes next. A
  // failure holds the line (the reader decides: retry, or drop what's
  // queued); so does an edit in progress, which would resend over it.
  useEffect(() => {
    const key = keyRef.current;
    if (!key || busy || failure || loading || editingIndex !== null) return;
    const next = queue[0];
    if (!next) return;
    setQueue((cur) => cur.slice(1));
    sendNow(key, next.text, next.refs);
  }, [busy, failure, loading, editingIndex, queue, sendNow]);

  /** Re-send the message that failed, dropping the transcript entry it left. */
  const retry = useCallback(() => {
    const key = keyRef.current;
    if (!key || !failure || busy) return;
    const { text, refs: sent } = failure.retry;
    setFailure(null);
    setMessages((cur) => {
      const last = cur[cur.length - 1];
      return last?.role === "user" && last.text === text ? cur.slice(0, -1) : cur;
    });
    setMessages((cur) => [
      ...cur,
      { role: "user", text, ts: new Date().toISOString(), refs: sent.length ? sent : undefined },
    ]);
    run(key, text, sent);
  }, [busy, failure, run]);

  /**
   * Load a user message into the composer for editing. The message's own
   * refs replace the staged ones (mirroring what sending it again would
   * carry); the previous staged refs are kept so `cancelEdit` can put them
   * back. The composer's own text is the caller's responsibility — this only
   * tracks which message is being edited.
   */
  const startEdit = useCallback(
    (index: number) => {
      const target = messages[index];
      if (!target || target.role !== "user" || busy) return;
      setPreEditRefs(refs);
      setRefs(target.refs ?? []);
      setEditingIndex(index);
    },
    [messages, refs, busy],
  );

  const cancelEdit = useCallback(() => {
    setRefs(preEditRefs ?? []);
    setPreEditRefs(null);
    setEditingIndex(null);
  }, [preEditRefs]);

  /** Resend the message being edited: discards it and everything after, then resends with `text`. */
  const sendEdit = useCallback(
    (text: string) => {
      const key = keyRef.current;
      const body = text.trim();
      const index = editingIndex;
      if (!key || !body || busy || index === null) return;
      const sent = effectiveRefs;
      setMessages((cur) => [
        ...cur.slice(0, index),
        { role: "user", text: body, ts: new Date().toISOString(), refs: sent.length ? sent : undefined },
      ]);
      setRefs([]);
      setEditingIndex(null);
      setPreEditRefs(null);
      setSessionReset(true);
      run(key, body, sent, index);
    },
    [busy, editingIndex, effectiveRefs, run],
  );

  /** Discard the message at `index` and everything after it; unrecoverable. */
  const rewindTo = useCallback(
    async (index: number) => {
      const key = keyRef.current;
      if (!key || busy) return;
      const result = await api.rewindChat(key, index);
      if (keyRef.current !== key) return;
      setMessages(result.messages);
      setFailure(null);
      setSessionReset(true);
      // The message being edited may itself have just been discarded.
      setEditingIndex((cur) => (cur !== null && cur >= index ? null : cur));
    },
    [busy],
  );

  /**
   * The switch is optimistic: the header should move the instant it is
   * clicked. The server's answer is authoritative and replaces it, and a
   * failure puts the old value back rather than leaving a lie on screen.
   */
  const setAgent = useCallback(
    async (agent: ChatAgentSelection | null) => {
      const key = keyRef.current;
      if (!key) return;
      const previous = agentStateRef.current;
      setAgentState((cur) => ({
        ...cur,
        sessionAgent: agent,
        agent: optimisticAgent(cur, agent),
      }));
      try {
        const result = await api.setChatAgent(key, agent);
        if (keyRef.current !== key) return;
        setAgentState((cur) => ({
          agent: result.agent,
          configuredAgent: result.configuredAgent,
          sessionAgent: result.sessionAgent,
          sessionHarness: result.restartedSession ? null : cur.sessionHarness,
        }));
      } catch {
        if (keyRef.current === key) setAgentState(previous);
      }
    },
    [],
  );

  const clearConversation = useCallback(async () => {
    const key = keyRef.current;
    if (!key) return;
    abortRef.current?.abort();
    abortRef.current = null;
    await api.clearChat(key).catch(() => {});
    setMessages([]);
    setStreaming(null);
    setBusy(false);
    setFailure(null);
    setEditingIndex(null);
    setPreEditRefs(null);
    setSessionReset(false);
    setQueue([]);
    // The server drops the pin with the transcript; mirror it.
    setAgentState((cur) => ({ ...cur, sessionAgent: null, sessionHarness: null, agent: cur.configuredAgent }));
  }, []);

  const value = useMemo<ChatContextValue>(
    () => ({
      prKey,
      open,
      setPrKey,
      openChat: () => setOpen(true),
      closeChat: () => setOpen(false),
      toggleChat: () => setOpen((v) => !v),
      messages,
      loading,
      streaming,
      busy,
      failure,
      ...agentState,
      setAgent,
      refs,
      attachRef,
      detachRef,
      clearRefs,
      effectiveRefs,
      isAutoRef,
      setUnitContext,
      removeAutoRef,
      send,
      queue,
      unqueue,
      stop,
      sendQueuedNow,
      dismissFailure,
      retry,
      clearConversation,
      editingIndex,
      startEdit,
      cancelEdit,
      sendEdit,
      rewindTo,
      sessionReset,
    }),
    [
      agentState,
      setAgent,
      prKey,
      open,
      setPrKey,
      messages,
      loading,
      streaming,
      busy,
      failure,
      refs,
      attachRef,
      detachRef,
      clearRefs,
      effectiveRefs,
      isAutoRef,
      setUnitContext,
      removeAutoRef,
      send,
      queue,
      unqueue,
      stop,
      sendQueuedNow,
      dismissFailure,
      retry,
      clearConversation,
      editingIndex,
      startEdit,
      cancelEdit,
      sendEdit,
      rewindTo,
      sessionReset,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
  return ctx;
}

/**
 * What copy calls the chat's agent: the harness the next message goes to, or
 * the default one outside a chat (or before it loads).
 */
export function useChatAgentName(): string {
  return useAgentName(useContext(ChatContext)?.agent?.harness);
}

/** Bind the store to the PR currently on screen. */
export function useChatFor(prKey: string) {
  const chat = useChat();
  const { setPrKey } = chat;
  useEffect(() => {
    setPrKey(prKey);
  }, [prKey, setPrKey]);
  return chat;
}

export { refKey };
