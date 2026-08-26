/**
 * The Claude chat panel.
 *
 * Deliberately not a chat app: no avatars, no rounded speech bubbles, no
 * timestamps competing with the text. It reads like the rest of the tool — a
 * role label, then the content, with the refs the message carried shown as
 * chips under the label so a reply is always traceable to what it was asked
 * about.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import type { ChatRef, DraftComment, PrDetail } from "../api/types";
import { refContext, refKey, refLabel, refTitle } from "../lib/chatRefs";
import { useChat, type LocalMessage, type ToolActivity } from "../lib/chat";
import {
  clampChatPanelWidth,
  MAX_CHAT_PANEL_WIDTH,
  MIN_CHAT_PANEL_WIDTH,
  useSettings,
} from "../lib/settings";
import { Markdown } from "./Markdown";
import { IconArrowDown, IconChat, IconFile, IconQuote, IconSettings, IconSpinner } from "./icons";

const STARTERS = [
  "Summarize the riskiest changes in this PR.",
  "Explain the selected unit and what could go wrong.",
  "What should I check first as a reviewer?",
  "Are the tests covering the new behaviour?",
];

const KIND_GLYPH: Record<ChatRef["kind"], string> = {
  unit: "▤",
  hunk: "◧",
  file: "◈",
  "line-range": "⌗",
  comment: "❝",
};

export function RefChip({
  refValue,
  label,
  title,
  onRemove,
}: {
  refValue: ChatRef;
  label: string;
  title?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      className="chip max-w-full"
      title={title}
      style={{ background: "var(--bg-inset)", color: "var(--fg-muted)", border: "1px solid var(--border)" }}
    >
      <span style={{ color: "var(--accent)" }}>{KIND_GLYPH[refValue.kind]}</span>
      <span className="truncate font-mono">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          title="Remove this reference"
          className="-mr-0.5 flex-none px-0.5 leading-none"
          style={{ color: "var(--fg-faint)" }}
        >
          ✕
        </button>
      ) : null}
    </span>
  );
}

function ToolLine({ tool }: { tool: ToolActivity }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
      <span style={{ color: "var(--accent)" }}>›</span>
      <span>{tool.name}</span>
      {tool.detail ? <span className="truncate">{tool.detail}</span> : null}
    </div>
  );
}

function RoleLabel({ role }: { role: "user" | "assistant" }) {
  return (
    <div
      className="mb-1 text-2xs uppercase tracking-wider"
      style={{ color: role === "user" ? "var(--fg-faint)" : "var(--accent)" }}
    >
      {role === "user" ? "you" : "claude"}
    </div>
  );
}

function MessageBlock({
  message,
  labelFor,
  titleFor,
}: {
  message: LocalMessage;
  labelFor: (ref: ChatRef) => string;
  titleFor: (ref: ChatRef) => string;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  return (
    <div
      className="border-b px-3 py-2.5"
      style={{
        borderColor: "var(--border)",
        background: message.role === "user" ? "var(--bg-inset)" : "transparent",
      }}
    >
      <RoleLabel role={message.role} />
      {message.refs?.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {message.refs.map((r) => (
            <RefChip key={refKey(r)} refValue={r} label={labelFor(r)} title={titleFor(r)} />
          ))}
        </div>
      ) : null}
      {message.role === "user" ? (
        <p className="whitespace-pre-wrap text-xs leading-[19px]" style={{ color: "var(--fg)" }}>
          {message.text}
        </p>
      ) : (
        <>
          {message.tools?.length ? (
            <div className="mb-1.5">
              <button
                type="button"
                className="text-2xs"
                style={{ color: "var(--fg-faint)" }}
                onClick={() => setToolsOpen((v) => !v)}
              >
                {toolsOpen ? "▾" : "▸"} {message.tools.length} tool{" "}
                {message.tools.length === 1 ? "call" : "calls"}
              </button>
              {toolsOpen ? (
                <div className="mt-0.5 space-y-0.5">
                  {message.tools.map((t, i) => (
                    <ToolLine key={i} tool={t} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <Markdown text={message.text} />
        </>
      )}
    </div>
  );
}

export function ChatPanel({
  prKey,
  detail,
  comments,
}: {
  prKey: string;
  detail?: PrDetail;
  comments: DraftComment[];
}) {
  const chat = useChat();
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState("");
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pinned, setPinned] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ctx = useMemo(() => refContext(detail, comments), [detail, comments]);
  const labelFor = useCallback((r: ChatRef) => refLabel(r, ctx), [ctx]);
  const titleFor = useCallback((r: ChatRef) => refTitle(r, ctx), [ctx]);

  const width = dragWidth ?? settings.chatPanelWidth;

  /* ------------------------------------------------------------ resizing */

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setDragWidth(clampChatPanelWidth(window.innerWidth - ev.clientX));
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Commit once, at the end: the store writes to localStorage on every
      // update and a drag would otherwise produce hundreds of writes.
      const final = clampChatPanelWidth(window.innerWidth - ev.clientX);
      update({ chatPanelWidth: final });
      setDragWidth(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /* ---------------------------------------------------------- scrolling */

  const atBottom = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Deltas arrive many times a second; following them is only right while the
  // reader has not scrolled up to re-read something.
  useLayoutEffect(() => {
    if (pinned) scrollToBottom();
  }, [chat.messages, chat.streaming, pinned, scrollToBottom]);

  const onScroll = () => setPinned(atBottom());

  /* ---------------------------------------------------------- composing */

  const grow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // ~6 lines, then the textarea scrolls instead of eating the transcript.
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  useEffect(grow, [draft]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = (text?: string) => {
    const body = (text ?? draft).trim();
    if (!body || chat.busy) return;
    chat.send(body);
    setDraft("");
    setPinned(true);
    requestAnimationFrame(() => scrollToBottom());
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      chat.closeChat();
    }
  };

  const empty = !chat.messages.length && !chat.streaming && !chat.loading;

  return (
    <aside
      className="relative flex flex-none flex-col border-l"
      data-testid="chat-panel"
      style={{ width, borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize"
        data-testid="chat-resize"
        style={{ background: dragWidth === null ? "transparent" : "var(--accent)" }}
      />

      <header
        className="flex flex-none items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border)" }}
      >
        <IconChat width={12} height={12} />
        <span className="text-xs font-semibold">Claude</span>
        {chat.busy ? (
          <span className="flex items-center gap-1 text-2xs" style={{ color: "var(--accent)" }}>
            <IconSpinner width={10} height={10} />
            thinking…
          </span>
        ) : null}
        <button
          type="button"
          className="ml-auto"
          title="Claude settings for this PR"
          aria-label="Claude settings"
          onClick={() => setSettingsOpen((v) => !v)}
          style={{ color: settingsOpen ? "var(--fg)" : "var(--fg-faint)" }}
        >
          <IconSettings width={12} height={12} />
        </button>
        <button
          type="button"
          className="text-xs"
          onClick={chat.closeChat}
          title="Close (c)"
          aria-label="Close chat"
          style={{ color: "var(--fg-faint)" }}
        >
          ✕
        </button>
      </header>

      {settingsOpen ? (
        <ChatSettings
          prKey={prKey}
          onClearConversation={() => {
            setConfirmClear(true);
            setSettingsOpen(false);
          }}
        />
      ) : null}

      {confirmClear ? (
        <div
          className="flex flex-none items-center gap-2 border-b px-3 py-2 text-2xs"
          style={{ borderColor: "var(--border)", background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          Clear this conversation? It cannot be recovered.
          <button type="button" className="btn ml-auto" onClick={() => setConfirmClear(false)}>
            cancel
          </button>
          <button
            type="button"
            className="btn"
            data-testid="chat-clear-confirm"
            onClick={() => {
              setConfirmClear(false);
              void chat.clearConversation();
            }}
          >
            clear
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="chat-transcript"
      >
        {chat.loading ? (
          <p className="p-3 text-xs" style={{ color: "var(--fg-faint)" }}>
            Loading the conversation…
          </p>
        ) : null}

        {empty ? (
          <div className="p-3">
            <p className="text-xs leading-5" style={{ color: "var(--fg-muted)" }}>
              Ask about this pull request. Quote a unit, a hunk, a file, a range of lines or one of
              your comments to point Claude at exactly what you mean.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip text-left"
                  style={{
                    background: "var(--bg-inset)",
                    border: "1px solid var(--border)",
                    color: "var(--fg-muted)",
                  }}
                  onClick={() => submit(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {chat.messages.map((m, i) => (
          <MessageBlock key={`${m.ts}-${i}`} message={m} labelFor={labelFor} titleFor={titleFor} />
        ))}

        {chat.streaming ? (
          <div className="px-3 py-2.5" data-testid="chat-streaming">
            <RoleLabel role="assistant" />
            {chat.streaming.tools.length ? (
              <div className="mb-1.5 space-y-0.5">
                {chat.streaming.tools.map((t, i) => (
                  <ToolLine key={i} tool={t} />
                ))}
              </div>
            ) : null}
            {chat.streaming.text ? (
              <Markdown text={chat.streaming.text} />
            ) : (
              <span className="text-xs" style={{ color: "var(--fg-faint)" }}>
                …
              </span>
            )}
          </div>
        ) : null}

        {chat.failure ? (
          <div
            className="mx-3 my-2 rounded p-2 text-2xs leading-4"
            data-testid="chat-error"
            style={{ background: "var(--risk-soft)", color: "var(--risk)" }}
          >
            {chat.failure.message}
            <div className="mt-1.5 flex">
              <button type="button" className="btn" onClick={chat.retry} disabled={chat.busy}>
                retry
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!pinned ? (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            scrollToBottom("smooth");
          }}
          className="absolute bottom-24 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1 rounded-full px-2 py-1 text-2xs shadow-lg"
          style={{ background: "var(--bg-hover)", border: "1px solid var(--border-strong)", color: "var(--fg)" }}
        >
          <IconArrowDown width={10} height={10} />
          jump to latest
        </button>
      ) : null}

      <div className="flex-none border-t p-2" style={{ borderColor: "var(--border)" }}>
        {chat.refs.length ? (
          <div className="mb-1.5 flex flex-wrap items-center gap-1" data-testid="chat-refs">
            {chat.refs.map((r) => (
              <RefChip
                key={refKey(r)}
                refValue={r}
                label={labelFor(r)}
                title={titleFor(r)}
                onRemove={() => chat.detachRef(refKey(r))}
              />
            ))}
            <button
              type="button"
              className="text-2xs"
              style={{ color: "var(--fg-faint)" }}
              onClick={chat.clearRefs}
            >
              clear all
            </button>
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          data-testid="chat-input"
          className="input resize-none text-xs leading-[18px]"
          rows={2}
          placeholder={chat.busy ? "Claude is replying…" : "Ask about this PR…  (↵ send · ⇧↵ newline)"}
          value={draft}
          disabled={chat.busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            {chat.busy ? "streaming the reply…" : `${chat.refs.length || "no"} refs attached`}
          </span>
          <button
            type="button"
            data-testid="chat-send"
            className="btn btn-primary ml-auto"
            disabled={chat.busy || !draft.trim()}
            onClick={() => submit()}
          >
            {chat.busy ? "…" : "send"}
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * The repo checkout moved to the per-repo settings page (it is shared by every
 * PR in the repo, so a per-PR field was the wrong home for it); what is left
 * here is the pointer to it plus the conversation controls.
 */
function ChatSettings({
  prKey,
  onClearConversation,
}: {
  prKey: string;
  onClearConversation: () => void;
}) {
  // prKey is `host/owner/repo/number`; the repo settings route takes the first three.
  const [host, owner, repo] = prKey.split("/");

  return (
    <div className="flex-none border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
      <span className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
        local repo path
      </span>
      <p className="mt-1 flex items-center gap-1.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
        <IconFile width={11} height={11} />
        <Link
          to={`/repo/${host}/${owner}/${repo}/settings`}
          data-testid="chat-repo-settings-link"
          className="underline underline-offset-2"
          style={{ color: "var(--accent)" }}
        >
          set in repo settings
        </Link>
        <span>— it is shared by every PR in {owner}/{repo}.</span>
      </p>
      <button type="button" className="btn mt-2" onClick={onClearConversation}>
        clear conversation
      </button>
    </div>
  );
}

export { MIN_CHAT_PANEL_WIDTH, MAX_CHAT_PANEL_WIDTH };

/** The top-bar toggle. */
export function ChatButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn"
      data-testid="chat-toggle"
      onClick={onClick}
      title="Ask Claude about this PR (c)"
      style={open ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
    >
      <IconChat width={11} height={11} />
      chat
    </button>
  );
}

/** Small quote affordance reused by hunk headers, file rows and comments. */
export function QuoteButton({
  onClick,
  title,
  className,
}: {
  onClick: () => void;
  title: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid="quote-button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex-none rounded p-0.5 opacity-50 transition-opacity hover:opacity-100 ${className ?? ""}`}
      style={{ color: "var(--fg-muted)" }}
    >
      <IconQuote width={11} height={11} />
    </button>
  );
}
