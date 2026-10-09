/**
 * The review chat panel.
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
import { api, errorText } from "../api/client";
import { useAgents } from "../api/hooks";
import type {
  AgentsInfo,
  ChatHandoff,
  ChatRef,
  DraftComment,
  HarnessManifest,
  PrDetail,
  ResolvedAgent,
} from "../api/types";
import { capitalized, editSelection, manifestOf, modelLabel, modelOptions } from "../lib/agentSelection";
import { copyText, handoffDisabledReason, isLoopbackHostname } from "../lib/chatHandoff";
import { refContext, refKey, refLabel, refTitle } from "../lib/chatRefs";
import { useChat, useChatAgentName, type LocalMessage, type ToolActivity } from "../lib/chat";
import {
  clampChatPanelWidth,
  MAX_CHAT_PANEL_WIDTH,
  MIN_CHAT_PANEL_WIDTH,
  useSettings,
} from "../lib/settings";
import { CHAT_TEXT, CodeLinkContext, Markdown, type CodeLink } from "./Markdown";
import { unitDisplayNumbers } from "../lib/unitOrder";
import { resolveCodeTarget, unitIdSet } from "../lib/codeLinks";
import { useModalBackground } from "./Modal";
import {
  IconArrowDown,
  IconChat,
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconEdit,
  IconFile,
  IconQuote,
  IconRewind,
  IconSettings,
  IconSpinner,
  IconStop,
  IconTerminal,
} from "./icons";

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
  auto,
  onRemove,
}: {
  refValue: ChatRef;
  label: string;
  title?: string;
  /** the auto-attached chip: dimmed/outline with an "auto" affix, same X */
  auto?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      className="chip max-w-full"
      data-testid={auto ? "chat-ref-auto" : undefined}
      title={title}
      style={
        auto
          ? { background: "transparent", color: "var(--fg-faint)", border: "1px dashed var(--border)" }
          : { background: "var(--bg-inset)", color: "var(--fg-muted)", border: "1px solid var(--border)" }
      }
    >
      <span style={{ color: auto ? "var(--fg-faint)" : "var(--accent)" }}>{KIND_GLYPH[refValue.kind]}</span>
      <span className="truncate font-mono">{label}</span>
      {auto ? <span className="flex-none text-2xs italic">auto</span> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          title="Remove this reference"
          className="-mr-0.5 flex-none px-0.5 leading-none"
          style={{ color: "var(--fg-faint)" }}
        >
          <IconClose width={9} height={9} />
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
    <span
      className="text-2xs uppercase tracking-wider"
      style={{ color: role === "user" ? "var(--fg-faint)" : "var(--accent)" }}
    >
      {role === "user" ? "you" : "claude"}
    </span>
  );
}

function MessageBlock({
  message,
  index,
  labelFor,
  titleFor,
  busy,
  isEditing,
  rewindConfirming,
  discardCount,
  onEdit,
  onRewindClick,
  onRewindConfirm,
  onRewindCancel,
}: {
  message: LocalMessage;
  index: number;
  labelFor: (ref: ChatRef) => string;
  titleFor: (ref: ChatRef) => string;
  busy: boolean;
  isEditing: boolean;
  rewindConfirming: boolean;
  /** messages this row and everything after it, i.e. what a rewind here removes */
  discardCount: number;
  onEdit: () => void;
  onRewindClick: () => void;
  onRewindConfirm: () => void;
  onRewindCancel: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  return (
    <div
      className="group border-b px-3 py-2.5"
      style={{
        borderColor: "var(--border)",
        background: message.role === "user" ? "var(--bg-inset)" : "transparent",
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <RoleLabel role={message.role} />
        {/* Hidden entirely while streaming: neither action is safe to act on mid-turn. */}
        {!busy && !isEditing ? (
          <div
            className={`chat-message-actions ml-auto flex items-center gap-2 text-2xs ${
              rewindConfirming ? "" : "opacity-0 transition-opacity group-hover:opacity-100"
            }`}
            style={{ color: "var(--fg-faint)" }}
          >
            {message.role === "user" ? (
              <button
                type="button"
                data-testid={`chat-edit-${index}`}
                title="Edit this message"
                aria-label="Edit this message"
                onClick={onEdit}
                className="inline-flex items-center gap-0.5 hover:underline"
              >
                <IconEdit width={10} height={10} />
                edit
              </button>
            ) : null}
            {rewindConfirming ? (
              <span className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid={`chat-rewind-confirm-${index}`}
                  onClick={onRewindConfirm}
                  className="hover:underline"
                  style={{ color: "var(--risk)" }}
                >
                  discard {discardCount} message{discardCount === 1 ? "" : "s"}?
                </button>
                <button type="button" onClick={onRewindCancel} className="hover:underline">
                  cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-testid={`chat-rewind-${index}`}
                title="Discard this message and everything after it"
                aria-label="Rewind to here"
                onClick={onRewindClick}
                className="inline-flex items-center gap-0.5 hover:underline"
              >
                <IconRewind width={10} height={10} />
                rewind here
              </button>
            )}
          </div>
        ) : null}
      </div>
      {message.refs?.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {message.refs.map((r) => (
            <RefChip key={refKey(r)} refValue={r} label={labelFor(r)} title={titleFor(r)} />
          ))}
        </div>
      ) : null}
      {message.role === "user" ? (
        <p className={`whitespace-pre-wrap ${CHAT_TEXT}`} style={{ color: "var(--fg)" }}>
          {message.text}
        </p>
      ) : (
        <>
          {message.tools?.length ? (
            <div className="mb-1.5">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-2xs"
                style={{ color: "var(--fg-faint)" }}
                onClick={() => setToolsOpen((v) => !v)}
              >
                <IconChevron open={toolsOpen} width={9} height={9} />
                {message.tools.length} tool {message.tools.length === 1 ? "call" : "calls"}
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
          {message.text ? <Markdown text={message.text} textClass={CHAT_TEXT} /> : null}
          {message.interrupted ? <StoppedMarker trailing={Boolean(message.text)} /> : null}
        </>
      )}
    </div>
  );
}

/** The quiet trailer under a reply the reader stopped; the text above it is all there was. */
function StoppedMarker({ trailing }: { trailing: boolean }) {
  return (
    <div
      className={`flex items-center gap-1.5 text-2xs italic ${trailing ? "mt-1.5" : ""}`}
      data-testid="chat-stopped"
      style={{ color: "var(--fg-faint)" }}
    >
      <IconStop width={8} height={8} />
      stopped by you
    </div>
  );
}

export function ChatPanel({
  prKey,
  detail,
  comments,
  onOpenUnit,
  onOpenFile,
}: {
  prKey: string;
  detail?: PrDetail;
  comments: DraftComment[];
  /** open a unit in the diff; enables linking the unit ids replies mention */
  onOpenUnit?: (unitId: string) => void;
  /** open a diff file, at a new-side line when given; enables linking paths */
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const chat = useChat();
  // Replies name units (`unit-id`) and places (`path/file.go:23`) in code
  // spans; the ones this PR can open become links (see lib/codeLinks.ts).
  const linkUnit = useMemo(() => {
    if (!detail || (!onOpenUnit && !onOpenFile)) return null;
    const units = new Map(detail.state.units.map((u) => [u.id, u]));
    const numbers = unitDisplayNumbers(detail.state.units);
    const ctx = { unitIds: onOpenUnit ? unitIdSet(detail.state.units) : new Set<string>(), files: detail.files.files };
    return (text: string): CodeLink | null => {
      const target = resolveCodeTarget(text, ctx);
      if (target?.kind === "unit" && onOpenUnit) {
        const unit = units.get(target.unitId)!;
        const n = numbers.get(unit.id);
        const title = unit.title.replace(/`/g, "");
        return {
          title: `${n !== undefined ? `Unit ${n}` : "Unit"}: ${title}`,
          label: { number: n, text: title },
          onOpen: () => onOpenUnit(unit.id),
        };
      }
      if (target?.kind === "file" && onOpenFile) {
        return {
          title: target.line !== undefined ? `${target.path}, line ${target.line}` : target.path,
          onOpen: () => onOpenFile(target.path, target.line),
        };
      }
      return null;
    };
  }, [detail, onOpenUnit, onOpenFile]);
  const { data: agents } = useAgents();
  const agentName = useChatAgentName();
  // Handoff continues the session in its own harness; before there is one,
  // in the harness the next message would start it on.
  const handoffHarness = manifestOf(agents, chat.sessionHarness ?? chat.agent?.harness ?? agents?.default ?? "");
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState("");
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [preEditDraft, setPreEditDraft] = useState<string | null>(null);
  const [rewindConfirmIndex, setRewindConfirmIndex] = useState<number | null>(null);

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

  // Quoting from the diff attaches a chip; the point of quoting is to type
  // about it, so the composer takes focus whenever an *explicit* ref is
  // added while the panel is already open. Auto-chip changes (unit
  // navigation) don't count — those must never steal focus mid-scroll.
  const explicitCount = chat.effectiveRefs.filter((r) => !chat.isAutoRef(r)).length;
  const prevExplicit = useRef(explicitCount);
  useEffect(() => {
    if (explicitCount > prevExplicit.current) textareaRef.current?.focus();
    prevExplicit.current = explicitCount;
  }, [explicitCount]);

  const submit = (text?: string) => {
    const body = (text ?? draft).trim();
    if (!body) return;
    if (chat.editingIndex !== null) {
      if (chat.busy) return;
      chat.sendEdit(body);
    } else {
      chat.send(body);
    }
    setDraft("");
    setPreEditDraft(null);
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
      if (chat.editingIndex !== null) cancelEditing();
      // While a reply streams, Esc stops it: closing the panel would hide the
      // very thing the reader is trying to interrupt.
      else if (chat.busy) void chat.stop();
      else chat.closeChat();
    }
  };

  /** Load a sent message back into the composer; its own refs replace whatever was staged. */
  const beginEdit = (index: number, text: string) => {
    if (chat.busy) return;
    setPreEditDraft(draft);
    setDraft(text);
    chat.startEdit(index);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const cancelEditing = () => {
    setDraft(preEditDraft ?? "");
    setPreEditDraft(null);
    chat.cancelEdit();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** Two-step confirm lives in the row itself; this just fires the request once confirmed. */
  const confirmRewind = async (index: number) => {
    try {
      await chat.rewindTo(index);
    } finally {
      setRewindConfirmIndex(null);
    }
  };

  // A rewind or an edit's resend changes what "later" means; a stale confirm
  // pointed at a row that may no longer exist is worse than none at all.
  useEffect(() => {
    setRewindConfirmIndex(null);
  }, [chat.messages.length]);

  const empty = !chat.messages.length && !chat.streaming && !chat.loading;

  return (
    <CodeLinkContext.Provider value={linkUnit}>
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
        <span className="text-xs font-semibold">{capitalized(agentName)}</span>
        {chat.busy ? (
          <span className="flex items-center gap-1.5 text-2xs" style={{ color: "var(--accent)" }}>
            <IconSpinner width={10} height={10} />
            thinking…
            <button
              type="button"
              data-testid="chat-stop"
              className="inline-flex items-center gap-1 rounded border px-1.5 py-px"
              style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)", background: "var(--bg-inset)" }}
              title="Stop the reply (Esc)"
              aria-label="Stop the reply"
              onClick={() => void chat.stop()}
            >
              <IconStop width={8} height={8} />
              stop
            </button>
          </span>
        ) : null}
        {chat.agent && chat.configuredAgent ? (
          <ModelSelect
            className="ml-auto"
            manifest={manifestOf(agents, chat.agent.harness)}
            value={chat.agent.model}
            configured={modelLabel(manifestOf(agents, chat.configuredAgent.harness), chat.configuredAgent.model)}
            pinned={chat.sessionAgent?.model !== undefined}
            onChange={(m) =>
              void chat.setAgent(
                editSelection(chat.sessionAgent, "model", m, chat.agent!.harness, chat.configuredAgent!.harness),
              )
            }
          />
        ) : (
          <span className="ml-auto" />
        )}
        {handoffHarness?.capabilities.handoff ? (
          <HandoffButton
            prKey={prKey}
            product={handoffHarness.name}
            messageCount={chat.messages.length}
            busy={chat.busy}
          />
        ) : null}
        <button
          type="button"
          title="Chat settings for this PR"
          aria-label="Chat settings"
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
          <IconClose width={11} height={11} />
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
              your comments to point {agentName} at exactly what you mean.
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
          <MessageBlock
            key={`${m.ts}-${i}`}
            message={m}
            index={i}
            labelFor={labelFor}
            titleFor={titleFor}
            busy={chat.busy}
            isEditing={chat.editingIndex === i}
            rewindConfirming={rewindConfirmIndex === i}
            discardCount={chat.messages.length - i}
            onEdit={() => beginEdit(i, m.text)}
            onRewindClick={() => setRewindConfirmIndex(i)}
            onRewindConfirm={() => void confirmRewind(i)}
            onRewindCancel={() => setRewindConfirmIndex(null)}
          />
        ))}

        {chat.streaming ? (
          <div className="px-3 py-2.5" data-testid="chat-streaming">
            <div className="mb-1">
              <RoleLabel role="assistant" />
            </div>
            {chat.streaming.tools.length ? (
              <div className="mb-1.5 space-y-0.5">
                {chat.streaming.tools.map((t, i) => (
                  <ToolLine key={i} tool={t} />
                ))}
              </div>
            ) : null}
            {chat.streaming.text ? (
              <Markdown text={chat.streaming.text} textClass={CHAT_TEXT} />
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
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" className="btn" onClick={chat.retry} disabled={chat.busy}>
                retry
              </button>
              {chat.queue.length ? (
                <button
                  type="button"
                  className="btn"
                  data-testid="chat-skip-failure"
                  onClick={chat.dismissFailure}
                  title="Leave this one unanswered and send the queued messages"
                >
                  skip, send queued ({chat.queue.length})
                </button>
              ) : null}
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
          className="absolute bottom-24 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1 rounded-full px-2 py-1 text-2xs elev-2"
          style={{ background: "var(--bg-hover)", border: "1px solid var(--border-strong)", color: "var(--fg)" }}
        >
          <IconArrowDown width={10} height={10} />
          jump to latest
        </button>
      ) : null}

      <div className="flex-none border-t p-2" style={{ borderColor: "var(--border)" }}>
        {chat.editingIndex !== null ? (
          <div
            className="mb-1.5 flex items-center gap-2 text-2xs"
            data-testid="chat-editing-banner"
            style={{ color: "var(--fg-muted)" }}
          >
            editing — sending will discard {chat.messages.length - chat.editingIndex - 1} later message
            {chat.messages.length - chat.editingIndex - 1 === 1 ? "" : "s"}
            <button type="button" className="btn ml-auto" onClick={cancelEditing}>
              cancel
            </button>
          </div>
        ) : null}
        {chat.sessionReset ? (
          <div
            className="mb-1.5 text-2xs"
            data-testid="chat-session-reset-note"
            style={{ color: "var(--fg-faint)" }}
          >
            starting a fresh session next — the conversation so far will be replayed
          </div>
        ) : null}
        {chat.queue.length ? (
          <ol className="mb-1.5 space-y-1" data-testid="chat-queue">
            {chat.queue.map((q, i) => (
              <li
                key={q.id}
                className="group flex items-start gap-2 rounded border px-2 py-1 text-xs leading-[18px]"
                style={{ borderColor: "var(--border)", background: "var(--bg-inset)", borderStyle: "dashed" }}
              >
                <span className="flex-none pt-px text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
                  {i === 0 ? (chat.failure ? "held" : "next") : `${i + 1}.`}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap" style={{ color: "var(--fg-muted)" }}>
                  {q.text}
                  {q.refs.length ? (
                    <span style={{ color: "var(--fg-faint)" }}>
                      {" "}
                      · {q.refs.length} ref{q.refs.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </span>
                {chat.busy && !chat.failure ? (
                  <button
                    type="button"
                    className="flex-none text-2xs opacity-70 hover:opacity-100"
                    style={{ color: "var(--accent)" }}
                    title="Stop the current reply and send this message next"
                    data-testid="chat-queue-send-now"
                    onClick={() => chat.sendQueuedNow(q.id)}
                  >
                    send now
                  </button>
                ) : null}
                <button
                  type="button"
                  className="flex-none text-2xs opacity-70 hover:opacity-100"
                  style={{ color: "var(--fg-muted)" }}
                  title="Take it back into the composer to edit"
                  onClick={() => {
                    const taken = chat.unqueue(q.id);
                    if (!taken) return;
                    setDraft((cur) => (cur.trim() ? `${cur}\n${taken.text}` : taken.text));
                    for (const r of taken.refs) chat.attachRef(r, { open: false });
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  edit
                </button>
                <button
                  type="button"
                  className="mt-[5px] flex-none opacity-70 hover:opacity-100"
                  style={{ color: "var(--fg-faint)" }}
                  title="Remove from the queue"
                  aria-label="Remove from the queue"
                  data-testid="chat-queue-remove"
                  onClick={() => chat.unqueue(q.id)}
                >
                  <IconClose width={9} height={9} />
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        {chat.effectiveRefs.length ? (
          <div className="mb-1.5 flex flex-wrap items-center gap-1" data-testid="chat-refs">
            {chat.effectiveRefs.map((r) => {
              const auto = chat.isAutoRef(r);
              return (
                <RefChip
                  key={refKey(r)}
                  refValue={r}
                  label={labelFor(r)}
                  title={auto ? `${titleFor(r)} (auto-attached from the selected unit)` : titleFor(r)}
                  auto={auto}
                  onRemove={() => (auto ? chat.removeAutoRef() : chat.detachRef(refKey(r)))}
                />
              );
            })}
            {chat.refs.length ? (
              <button
                type="button"
                className="text-2xs"
                style={{ color: "var(--fg-faint)" }}
                onClick={chat.clearRefs}
              >
                clear all
              </button>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          data-testid="chat-input"
          className="input resize-none text-[13px] leading-[20px]"
          rows={2}
          placeholder={
            chat.busy
              ? `${capitalized(agentName)} is replying — queue a message…  (↵ queue · ⇧↵ newline · esc stop)`
              : chat.editingIndex !== null
                ? "Edit your message…  (↵ send · ⇧↵ newline)"
                : "Ask about this PR…  (↵ send · ⇧↵ newline)"
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            {chat.busy ? "streaming the reply…" : `${chat.effectiveRefs.length || "no"} refs attached`}
          </span>
          {chat.agent ? (
            <ActiveModel agent={chat.agent} configured={chat.configuredAgent} manifests={agents} />
          ) : null}
          <button
            type="button"
            data-testid="chat-send"
            className="btn btn-primary ml-auto"
            disabled={!draft.trim() || (chat.busy && chat.editingIndex !== null)}
            onClick={() => submit()}
          >
            {chat.editingIndex !== null ? "resend" : chat.busy || chat.queue.length ? "queue" : "send"}
          </button>
        </div>
      </div>
    </aside>
    </CodeLinkContext.Provider>
  );
}

/** The model the next message will use, and where that choice came from. */
function ActiveModel({
  agent,
  configured,
  manifests,
}: {
  agent: ResolvedAgent;
  configured: ResolvedAgent | null;
  manifests: AgentsInfo | undefined;
}) {
  const label = (a: ResolvedAgent) => modelLabel(manifestOf(manifests, a.harness), a.model);
  return (
    <span
      className="font-mono text-2xs"
      data-testid="chat-active-model"
      title={
        agent.sources.model === "chat"
          ? `Pinned for this conversation${configured ? ` (the repo default is ${label(configured)})` : ""}`
          : `From the ${agent.sources.model} setting`
      }
      style={{ color: "var(--fg-faint)" }}
    >
      {label(agent)}
    </span>
  );
}

/**
 * The model the next message will use, from the harness's manifest.
 *
 * A native select rather than a segmented control: three options plus the
 * "inherit" row do not fit a 320px panel header side by side, and the current
 * value is what matters at a glance — the alternatives only when asked for.
 *
 * Switching applies from the next message on; the conversation is kept, because
 * the CLI resumes a session happily under a different model.
 */
function ModelSelect({
  manifest,
  value,
  configured,
  pinned,
  onChange,
  className,
}: {
  manifest: HarnessManifest | undefined;
  value: string;
  /** what "inherit" resolves to, as shown */
  configured: string;
  pinned: boolean;
  onChange: (model: string | null) => void;
  className?: string;
}) {
  return (
    <label className={`flex items-center ${className ?? ""}`}>
      <span className="sr-only">Model for the next message</span>
      <select
        data-testid="chat-model-select"
        className="cursor-pointer rounded px-1 py-px text-2xs font-medium outline-none"
        title={`Model for the next message${pinned ? " (pinned for this conversation)" : ""}`}
        value={pinned ? value : "inherit"}
        onChange={(e) => onChange(e.target.value === "inherit" ? null : e.target.value)}
        style={{
          background: "var(--bg-inset)",
          border: "1px solid var(--border)",
          color: pinned ? "var(--fg)" : "var(--fg-muted)",
        }}
      >
        <option value="inherit">{configured} (default)</option>
        {modelOptions(manifest).map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}

type HandoffState =
  | { phase: "loading" }
  | { phase: "ready"; handoff: ChatHandoff; copied: boolean }
  | { phase: "error"; message: string };

/**
 * "Continue in Claude Code" (or whichever `product` holds the session):
 * fetches the one-liner that forks this chat's session into the reader's own
 * terminal, copies it, and shows it in a popover in case the copy did not
 * take (or they want to read it first). The server
 * refuses it over the LAN, so the button says so up front instead.
 */
function HandoffButton({
  prKey,
  product,
  messageCount,
  busy,
}: {
  prKey: string;
  /** the harness's product name, e.g. "Claude Code" */
  product: string;
  messageCount: number;
  busy: boolean;
}) {
  const label = `Continue in ${product}`;
  const [state, setState] = useState<HandoffState | null>(null);
  const [recopied, setRecopied] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  /** Bumped on every open/close, so a reply that lands after a close is dropped. */
  const request = useRef(0);
  const reason = handoffDisabledReason({
    messageCount,
    busy,
    loopback: isLoopbackHostname(window.location.hostname),
  });
  const open = state !== null;
  const close = useCallback(() => {
    request.current++;
    setState(null);
    setRecopied(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Captured and stopped: Escape here closes the popover, not the panel.
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  const start = async () => {
    if (open) return close();
    const id = ++request.current;
    setState({ phase: "loading" });
    try {
      const handoff = await api.chatHandoff(prKey);
      if (id !== request.current) return;
      const copied = await copyText(handoff.command);
      if (id !== request.current) return;
      setState({ phase: "ready", handoff, copied });
    } catch (err) {
      if (id === request.current) setState({ phase: "error", message: errorText(err) });
    }
  };

  const copyAgain = async (command: string) => {
    if (await copyText(command)) {
      setRecopied(true);
      window.setTimeout(() => setRecopied(false), 1500);
    }
  };

  return (
    <span ref={wrapRef} className="relative inline-flex" title={reason ?? label}>
      <button
        type="button"
        data-testid="chat-handoff"
        aria-label={label}
        aria-expanded={open}
        disabled={reason !== null}
        onClick={() => void start()}
        className="disabled:cursor-not-allowed disabled:opacity-40"
        style={{ color: open ? "var(--fg)" : "var(--fg-faint)" }}
      >
        <IconTerminal width={12} height={12} />
      </button>
      {state ? (
        <div
          role="dialog"
          aria-label={label}
          data-testid="chat-handoff-popover"
          className="surface absolute right-0 top-6 z-30 w-72 rounded-md p-2 elev-2"
          onClick={(e) => e.stopPropagation()}
        >
          {state.phase === "loading" ? (
            <p className="flex items-center gap-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
              <IconSpinner width={10} height={10} />
              Preparing the command…
            </p>
          ) : state.phase === "error" ? (
            <p className="text-2xs leading-4" data-testid="chat-handoff-error" style={{ color: "var(--risk)" }}>
              {state.message}
            </p>
          ) : (
            <>
              <p className="text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
                {state.copied
                  ? `Copied. Paste into a terminal to continue this chat in ${product}.`
                  : `Copy this and paste it into a terminal to continue this chat in ${product}.`}
              </p>
              <code
                data-testid="chat-handoff-command"
                className="mt-1.5 block select-text whitespace-pre-wrap rounded px-2 py-1 font-mono text-2xs"
                style={{
                  background: "var(--bg-inset)",
                  color: "var(--fg-muted)",
                  overflowWrap: "anywhere",
                }}
              >
                {state.handoff.command}
              </code>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void copyAgain(state.handoff.command)}
                  style={recopied ? { color: "var(--ok)", borderColor: "var(--ok)" } : undefined}
                >
                  {recopied ? <IconCheck width={11} height={11} /> : <IconCopy width={11} height={11} />}
                  {recopied ? "copied" : "copy"}
                </button>
              </div>
              <p className="mt-1.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
                Forks the conversation: what you do there won&apos;t appear here.
              </p>
            </>
          )}
        </div>
      ) : null}
    </span>
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
  // Opens over the PR the user is reviewing rather than navigating away.
  const background = useModalBackground();

  return (
    <div className="flex-none border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
      <span className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
        local repo path
      </span>
      <p className="mt-1 flex items-center gap-1.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
        <IconFile width={11} height={11} />
        <Link
          to={`/repo/${host}/${owner}/${repo}/settings`}
          state={{ background }}
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
  const agentName = useChatAgentName();
  return (
    <button
      type="button"
      className="btn"
      data-testid="chat-toggle"
      aria-label="Chat"
      onClick={onClick}
      title={`Ask ${agentName} about this PR (c)`}
      style={open ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
    >
      <IconChat width={12} height={12} />
    </button>
  );
}

/** Small quote affordance reused by hunk headers, file rows and comments. */
export function QuoteButton({
  onClick,
  about,
  className,
}: {
  onClick: () => void;
  /** what the chat is asked about, e.g. "this hunk" */
  about: string;
  className?: string;
}) {
  const agentName = useChatAgentName();
  const title = `Ask ${agentName} about ${about}`;
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
