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
import { qk } from "../api/hooks";
import { errorText } from "../api/errors";
import type { ChatMessage, ChatRef, ChatStreamEvent, ClaudeModel, ConfigSource } from "../api/types";
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
}

/** A transcript entry; `tools` is local colour the wire format does not carry. */
export type LocalMessage = ChatMessage & { tools?: ToolActivity[] };

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

  /** the model the next message will use */
  model: ClaudeModel;
  /** what the repo/global layers say, i.e. what "inherit" means here */
  configuredModel: ClaudeModel;
  configuredModelSource: ConfigSource;
  /** non-null only while this conversation overrides the configured model */
  sessionModel: ClaudeModel | null;
  /** pin (or unpin, with null) the model; applies from the next message on */
  setModel: (model: ClaudeModel | null) => Promise<void>;

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

  send: (text: string) => void;
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
  const [autoRefState, dispatchAutoRef] = useReducer(autoRefReducer, initialAutoRefState);
  // Seeded with the built-in default so the header never renders blank; the
  // real values arrive with the transcript.
  const [modelState, setModelState] = useState<{
    model: ClaudeModel;
    configuredModel: ClaudeModel;
    configuredModelSource: ConfigSource;
    sessionModel: ClaudeModel | null;
  }>({
    model: "sonnet",
    configuredModel: "sonnet",
    configuredModelSource: "default",
    sessionModel: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef<string | null>(null);
  keyRef.current = prKey;
  const modelStateRef = useRef(modelState);
  modelStateRef.current = modelState;

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
      dispatchAutoRef({ type: "reset" });
      setModelState({
        model: "sonnet",
        configuredModel: "sonnet",
        configuredModelSource: "default",
        sessionModel: null,
      });
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
        setModelState({
          model: state.model,
          configuredModel: state.configuredModel,
          configuredModelSource: state.configuredModelSource,
          sessionModel: state.sessionModel,
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
    // event arrives when Claude *starts* a call, so the comments are refetched
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
          seenTools = [...seenTools, { name: event.name, detail: event.detail }];
          // Text before a tool call is narration, not the answer; the server
          // saves only what follows the last tool call, so the live bubble
          // starts over too rather than gluing blocks together. Keep the old
          // text as the fallback for a stream that ends before any new text.
          const fresh = event.name === "result-error" ? null : "";
          if (fresh !== null && outcome.text) outcome.narration = outcome.text;
          if (fresh !== null) outcome.text = fresh;
          setStreaming((cur) =>
            cur
              ? {
                  ...cur,
                  text: fresh ?? cur.text,
                  tools: [...cur.tools, { name: event.name, detail: event.detail }],
                }
              : cur,
          );
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
      if (message.text.trim()) setMessages((cur) => [...cur, message]);
    })();
  }, [queryClient]);

  const send = useCallback(
    (text: string) => {
      const key = keyRef.current;
      const body = text.trim();
      if (!key || !body || busy) return;
      // The auto ref rides along like any other — the server just sees a
      // unit ref — but it is never *consumed*: clearing explicit refs after
      // send leaves the auto chip to reappear (unless dismissed) for the
      // next turn, same unit.
      const sent = effectiveRefs;
      setMessages((cur) => [
        ...cur,
        { role: "user", text: body, ts: new Date().toISOString(), refs: sent.length ? sent : undefined },
      ]);
      setRefs([]);
      run(key, body, sent);
    },
    [busy, effectiveRefs, run],
  );

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
  const setModel = useCallback(
    async (model: ClaudeModel | null) => {
      const key = keyRef.current;
      if (!key) return;
      const previous = modelStateRef.current;
      setModelState((cur) => ({
        ...cur,
        sessionModel: model,
        model: model ?? cur.configuredModel,
      }));
      try {
        const result = await api.setChatModel(key, model);
        if (keyRef.current !== key) return;
        setModelState({
          model: result.model,
          configuredModel: result.configuredModel,
          configuredModelSource: result.configuredModelSource,
          sessionModel: result.sessionModel,
        });
      } catch {
        if (keyRef.current === key) setModelState(previous);
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
    // The server drops the pin with the transcript; mirror it.
    setModelState((cur) => ({ ...cur, sessionModel: null, model: cur.configuredModel }));
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
      ...modelState,
      setModel,
      refs,
      attachRef,
      detachRef,
      clearRefs,
      effectiveRefs,
      isAutoRef,
      setUnitContext,
      removeAutoRef,
      send,
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
      modelState,
      setModel,
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
