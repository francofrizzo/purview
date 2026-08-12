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
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { errorText } from "../api/errors";
import type { ChatMessage, ChatRef } from "../api/types";
import { addRef as addRefTo, refKey, removeRef as removeRefFrom } from "./chatRefs";

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

  refs: ChatRef[];
  attachRef: (ref: ChatRef, options?: { open?: boolean }) => void;
  detachRef: (key: string) => void;
  clearRefs: () => void;

  send: (text: string) => void;
  retry: () => void;
  clearConversation: () => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [prKey, setPrKeyState] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState<{ text: string; tools: ToolActivity[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  const [refs, setRefs] = useState<ChatRef[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef<string | null>(null);
  keyRef.current = prKey;

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
      return key;
    });
  }, []);

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

  const run = useCallback((key: string, text: string, sent: ChatRef[]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setFailure(null);
    setStreaming({ text: "", tools: [] });

    // A plain object rather than locals: these are written from the event
    // callback, and TypeScript's narrowing of captured `let`s across an await
    // is not something to lean on.
    const outcome: { failed: string | null; message: LocalMessage | null; text: string } = {
      failed: null,
      message: null,
      text: "",
    };

    void (async () => {
      let seenTools: ToolActivity[] = [];
      try {
        await api.streamChat(
          key,
          { text, ...(sent.length ? { refs: sent } : {}) },
          (event) => {
            if (event.type === "delta") {
              outcome.text += event.text;
              setStreaming((cur) => (cur ? { ...cur, text: cur.text + event.text } : cur));
            } else if (event.type === "tool") {
              seenTools = [...seenTools, { name: event.name, detail: event.detail }];
              setStreaming((cur) =>
                cur ? { ...cur, tools: [...cur.tools, { name: event.name, detail: event.detail }] } : cur,
              );
            } else if (event.type === "done") {
              outcome.message = { ...event.message, tools: seenTools.length ? seenTools : undefined };
            } else if (event.type === "error") {
              outcome.failed = event.error;
            }
          },
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        outcome.failed = errorText(err);
      }
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
        text: outcome.text,
        ts: new Date().toISOString(),
        tools: seenTools.length ? seenTools : undefined,
      };
      if (message.text.trim()) setMessages((cur) => [...cur, message]);
    })();
  }, []);

  const send = useCallback(
    (text: string) => {
      const key = keyRef.current;
      const body = text.trim();
      if (!key || !body || busy) return;
      const sent = refs;
      setMessages((cur) => [
        ...cur,
        { role: "user", text: body, ts: new Date().toISOString(), refs: sent.length ? sent : undefined },
      ]);
      setRefs([]);
      run(key, body, sent);
    },
    [busy, refs, run],
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
      refs,
      attachRef,
      detachRef,
      clearRefs,
      send,
      retry,
      clearConversation,
    }),
    [
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
      send,
      retry,
      clearConversation,
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
