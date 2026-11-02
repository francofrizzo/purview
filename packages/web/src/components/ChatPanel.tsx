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
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { OverflowMenu } from "./OverflowMenu";
import { api, errorText } from "../api/client";
import { useAgents } from "../api/hooks";
import type {
  ChatHandoff,
  ChatRef,
  DraftComment,
  HarnessManifest,
  PrDetail,
} from "../api/types";
import { capitalized, editSelection, manifestOf, modelLabel, modelOptions } from "../lib/agentSelection";
import { copyText, handoffDisabledReason, isLoopbackHostname } from "../lib/chatHandoff";
import { refContext, refKey, refLabel, refTitle } from "../lib/chatRefs";
import {
  findMentions,
  insertMention,
  mentionAt,
  mentionOptions,
  mentionRefs,
  rankMentions,
  type MentionOption,
  type MentionQuery,
  type MentionSpan,
} from "../lib/mentions";
import { UnitNumber } from "./Chips";
import { useChat, useChatAgentName, type LocalMessage, type ToolActivity } from "../lib/chat";
import {
  MAX_CHAT_PANEL_WIDTH,
  MIN_CHAT_PANEL_WIDTH,
} from "../lib/settings";
import { CHAT_TEXT, CodeLinkContext, Markdown } from "./Markdown";
import { codeLinker } from "../lib/codeLinks";
import { useModalBackground } from "./Modal";
import {
  IconArrowDown,
  IconChat,
  IconCheck,
  IconCode,
  IconComment,
  IconChevron,
  IconClose,
  IconCopy,
  IconEdit,
  IconFile,
  IconQuote,
  IconRewind,
  IconTrash,
  IconSpinner,
  IconStop,
  IconConcept,
  IconTerminal,
  IconUnit,
} from "./icons";

const STARTERS = [
  "Summarize the riskiest changes in this PR.",
  "Explain the selected unit and what could go wrong.",
  "What should I check first as a reviewer?",
  "Are the tests covering the new behaviour?",
];

const KIND_ICON: Record<ChatRef["kind"], ComponentType<{ width?: number; height?: number }>> = {
  unit: IconUnit,
  hunk: IconCode,
  file: IconFile,
  "line-range": IconCode,
  comment: IconComment,
  concept: IconConcept,
};

export function RefChip({
  refValue,
  label,
  tip,
  auto,
  onRemove,
}: {
  refValue: ChatRef;
  label: string;
  tip?: string;
  /** the auto-attached chip: fainter, with an "auto" affix, same X */
  auto?: boolean;
  onRemove?: () => void;
}) {
  const Icon = KIND_ICON[refValue.kind];
  return (
    <span
      className="chip max-w-full"
      data-testid={auto ? "chat-ref-auto" : undefined}
      data-tip={tip}
      style={{
        background: auto ? "transparent" : "var(--bg-inset)",
        color: auto ? "var(--fg-faint)" : "var(--fg-muted)",
        border: "1px solid var(--border)",
      }}
    >
      <span className="flex flex-none" style={{ color: auto ? "var(--fg-faint)" : "var(--accent)" }}>
        <Icon width={11} height={11} />
      </span>
      <span className="truncate">{label}</span>
      {auto ? <span className="flex-none text-2xs">· auto</span> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          data-tip="Remove this reference"
          aria-label="Remove this reference"
          className="-mr-0.5 flex-none px-0.5 leading-none"
          style={{ color: "var(--fg-faint)" }}
        >
          <IconClose width={9} height={9} />
        </button>
      ) : null}
    </span>
  );
}

/** A sent message's text, its @tokens drawn as links: a unit or a file opens, a concept explains itself on hover. */
function MentionText({
  text,
  spans,
  onOpen,
  ink = false,
}: {
  text: string;
  spans: readonly MentionSpan[];
  onOpen?: (o: MentionOption) => void;
  /** the composer's backdrop: only the tint, in the exact width of the words (no padding to shift the wrap) */
  ink?: boolean;
}) {
  if (!spans.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  spans.forEach((m, i) => {
    if (m.start > at) parts.push(text.slice(at, m.start));
    const word = text.slice(m.start, m.end);
    if (ink) {
      parts.push(
        <span key={i} className="mention-ink" data-testid="chat-input-mention">
          {word}
        </span>,
      );
      at = m.end;
      return;
    }
    const opens = onOpen && m.option.kind !== "concept";
    parts.push(
      opens ? (
        <button
          key={i}
          type="button"
          className="mention rounded-sm hover:underline"
          data-testid="chat-mention-link"
          data-tip={m.option.tip}
          onClick={() => onOpen(m.option)}
        >
          {word}
        </button>
      ) : (
        <span key={i} className="mention rounded-sm" data-testid="chat-mention-link" data-tip={m.option.tip}>
          {word}
        </span>
      ),
    );
    at = m.end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The @ list, above the composer: units by number and title, concepts, files
 * with their folder. Mouse down picks without blurring the textarea.
 */
function MentionList({
  options,
  active,
  onHover,
  onPick,
}: {
  options: MentionOption[];
  active: number;
  onHover: (i: number) => void;
  onPick: (o: MentionOption) => void;
}) {
  return (
    <ul
      role="listbox"
      data-testid="chat-mentions"
      className="surface elev-2 absolute inset-x-0 bottom-full z-20 mb-1 rounded-md p-1 text-xs"
    >
      {options.map((o, i) => {
        const Icon = KIND_ICON[o.kind];
        return (
          <li
            key={refKey(o.ref)}
            role="option"
            aria-selected={i === active}
            data-testid="chat-mention"
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1"
            style={{ background: i === active ? "var(--bg-hover)" : undefined, color: "var(--fg)" }}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(o);
            }}
          >
            {o.number !== undefined ? (
              <UnitNumber number={o.number} />
            ) : (
              <span className="flex w-[18px] flex-none justify-center" style={{ color: "var(--fg-faint)" }}>
                <Icon width={12} height={12} />
              </span>
            )}
            <span className="flex-none truncate" style={{ maxWidth: "70%" }}>{o.label}</span>
            {o.hint ? (
              <span className="min-w-0 truncate text-2xs" style={{ color: "var(--fg-faint)" }}>
                {o.hint}
              </span>
            ) : null}
            <span className="ml-auto flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
              {o.kind}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** What the agent is doing, and under it, smaller, what it is doing it to. */
function ToolLine({ tool }: { tool: ToolActivity }) {
  // One line: the name never shrinks or wraps; whatever room is short comes
  // out of the arguments, as an ellipsis.
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs" style={{ color: "var(--fg-faint)" }} data-testid="chat-tool-line">
      <span className="flex-none" style={{ color: "var(--accent)" }}>›</span>
      <span className="flex-none whitespace-nowrap">{tool.name}</span>
      {tool.detail ? (
        <span className="min-w-0 truncate text-2xs" style={{ color: "var(--fg-faint)", opacity: 0.8 }} title={tool.detail}>
          {tool.detail}
        </span>
      ) : null}
    </div>
  );
}

/** Who wrote a message, in sentence case: "You", or the agent the chat runs on. */
function RoleLabel({ role }: { role: "user" | "assistant" }) {
  const agentName = useChatAgentName();
  return (
    <span
      className="text-xs font-semibold"
      style={{ color: role === "user" ? "var(--fg-muted)" : "var(--accent)" }}
    >
      {role === "user" ? "You" : capitalized(agentName)}
    </span>
  );
}

function MessageBlock({
  message,
  index,
  labelFor,
  titleFor,
  mentions,
  onOpenMention,
  busy,
  isEditing,
  rewindConfirming,
  rewinding,
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
  /** what a written @token can name, to draw it as a link and keep it off the chips */
  mentions: readonly MentionOption[];
  onOpenMention?: (o: MentionOption) => void;
  busy: boolean;
  isEditing: boolean;
  rewindConfirming: boolean;
  /** the confirmed rewind is in flight */
  rewinding: boolean;
  /** messages this row and everything after it, i.e. what a rewind here removes */
  discardCount: number;
  onEdit: () => void;
  onRewindClick: () => void;
  onRewindConfirm: () => void;
  onRewindCancel: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const spans = useMemo(
    () => (message.role === "user" ? findMentions(message.text, mentions) : []),
    [message.role, message.text, mentions],
  );
  // A ref the text names is shown there, as a link; the chips are the rest.
  const mentioned = new Set(spans.map((m) => refKey(m.option.ref)));
  const chips = (message.refs ?? []).filter((r) => !mentioned.has(refKey(r)));
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
                data-tip="Edit this message"
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
                  disabled={rewinding}
                  className="hover:underline disabled:opacity-60"
                  style={{ color: "var(--risk)" }}
                >
                  {rewinding ? "discarding…" : `discard ${discardCount} message${discardCount === 1 ? "" : "s"}?`}
                </button>
                <button type="button" onClick={onRewindCancel} className="hover:underline" disabled={rewinding}>
                  cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-testid={`chat-rewind-${index}`}
                data-tip="Discard this message and everything after it"
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
      {chips.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {chips.map((r) => (
            <RefChip key={refKey(r)} refValue={r} label={labelFor(r)} tip={titleFor(r)} />
          ))}
        </div>
      ) : null}
      {message.role === "user" ? (
        <p className={`whitespace-pre-wrap ${CHAT_TEXT}`} style={{ color: "var(--fg)" }}>
          <MentionText text={message.text} spans={spans} onOpen={onOpenMention} />
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
  const linkUnit = useMemo(() => codeLinker(detail, { onOpenUnit, onOpenFile }), [detail, onOpenUnit, onOpenFile]);
  const { data: agents } = useAgents();
  const agentName = useChatAgentName();
  // Handoff continues the session in its own harness; before there is one,
  // in the harness the next message would start it on.
  const handoffHarness = manifestOf(agents, chat.sessionHarness ?? chat.agent?.harness ?? agents?.default ?? "");
  const [draft, setDraft] = useState("");
  // prKey is `host/owner/repo/number`; the repo settings route takes the first three.
  const [repoHost, repoOwner, repoName] = prKey.split("/");
  // Opens over the PR the user is reviewing rather than navigating away.
  const background = useModalBackground();
  const navigate = useNavigate();
  const [confirmClear, setConfirmClear] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [preEditDraft, setPreEditDraft] = useState<string | null>(null);
  const [rewindConfirmIndex, setRewindConfirmIndex] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const ctx = useMemo(() => refContext(detail, comments), [detail, comments]);

  // The @ list: open while the caret sits in an @word, unless Esc closed it
  // for that word (remembered by where its @ is).
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const allMentions = useMemo(() => mentionOptions(detail), [detail]);
  const draftMentions = useMemo(() => findMentions(draft, allMentions), [draft, allMentions]);
  const mentionList = useMemo(
    () =>
      // A written token, the caret at its end, is done: no list over it.
      mention &&
      mention.start !== mentionDismissed &&
      !allMentions.some((o) => o.token.toLowerCase() === `@${mention.query}`.toLowerCase())
        ? rankMentions(allMentions, mention.query)
        : [],
    [allMentions, mention, mentionDismissed],
  );
  const trackMention = (el: HTMLTextAreaElement) => {
    const at = el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    setMention((prev) => (prev?.start === at?.start && prev?.query === at?.query ? prev : at));
    if (!at) setMentionDismissed(null);
  };
  useEffect(() => setMentionActive(0), [mention?.query, mention?.start]);
  const openMention = useCallback(
    (o: MentionOption) => {
      if (o.ref.kind === "unit" && o.ref.id) onOpenUnit?.(o.ref.id);
      else if (o.ref.kind === "file" && o.ref.path) onOpenFile?.(o.ref.path);
    },
    [onOpenUnit, onOpenFile],
  );
  const pickMention = (o: MentionOption) => {
    if (!mention) return;
    // The token stays in the sentence and is the reference: no chip.
    const next = insertMention(draft, mention, o.token);
    setDraft(next.text);
    setMention(null);
    // The written token would read as a new @query; this one is settled.
    setMentionDismissed(mention.start);
    pendingCaret.current = next.caret;
  };
  // The caret goes after the token in the same commit that writes it: a frame
  // later, a key typed in between would land where the caret used to be.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const caret = pendingCaret.current;
    if (!el || caret === null) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [draft]);
  const labelFor = useCallback((r: ChatRef) => refLabel(r, ctx), [ctx]);
  const titleFor = useCallback((r: ChatRef) => refTitle(r, ctx), [ctx]);

  /* ---------------------------------------------------------- scrolling */

  // Following new text is only right while the reader sits at the very
  // bottom. The ref is the truth the layout effect reads: state lags a
  // render behind, and deltas arrive many times a second.
  const pinnedRef = useRef(true);
  /** scrollHeight after the last update, to measure where the reader was before this one */
  const lastHeight = useRef(0);
  const pin = useCallback((on: boolean) => {
    pinnedRef.current = on;
    setPinned(on);
  }, []);

  // "jump to latest" scrolls smoothly; the frames on the way down are not
  // the reader scrolling up.
  const jumping = useRef(false);

  /** Within a few pixels of the bottom: subpixel rounding, not a reader's scroll. */
  const PIN_SLACK = 4;
  const distanceFromBottom = (el: HTMLElement, height = el.scrollHeight) => height - el.scrollTop - el.clientHeight;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      // Measured against the height before this update: scrollTop is already
      // wherever the reader moved it, even when their scroll event has not
      // fired yet, so a delta can never yank them back down mid-scroll.
      const before = lastHeight.current || el.scrollHeight;
      if (jumping.current || distanceFromBottom(el, before) <= PIN_SLACK) el.scrollTop = el.scrollHeight;
      else pin(false);
    }
    lastHeight.current = el.scrollHeight;
  }, [chat.messages, chat.streaming, pinned, pin]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    lastHeight.current = el.scrollHeight;
    const atBottom = distanceFromBottom(el) <= PIN_SLACK;
    if (jumping.current) {
      if (atBottom) jumping.current = false;
      return;
    }
    pin(atBottom);
  };

  // The pane shrinks when the composer grows or the window resizes; that
  // hides the last lines without the reader moving, so stay at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      el.scrollTop = el.scrollHeight;
      lastHeight.current = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scrolling up is intent enough: let go at once, before the scroll lands.
  const scrollable = () => {
    const el = scrollRef.current;
    return !!el && el.scrollHeight > el.clientHeight;
  };
  const letGo = () => {
    jumping.current = false;
    pin(false);
  };
  const onWheel = (e: { deltaY: number }) => {
    if (e.deltaY < 0 && scrollable()) letGo();
  };
  const onTranscriptKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") && scrollable()) letGo();
  };

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
      chat.sendEdit(body, mentionRefs(body, allMentions));
    } else {
      chat.send(body, mentionRefs(body, allMentions));
    }
    setDraft("");
    setPreEditDraft(null);
    pin(true);
    requestAnimationFrame(() => scrollToBottom());
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionList.length && mention) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionActive((i) => (i + step + mentionList.length) % mentionList.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionList[Math.min(mentionActive, mentionList.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMentionDismissed(mention.start);
        return;
      }
    }
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
    // The text carries its mentions back; only the other refs return as chips.
    chat.startEdit(index, mentionRefs(text, allMentions));
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
    await chat.rewindTo(index);
    setRewindConfirmIndex(null);
  };

  // A rewind or an edit's resend changes what "later" means; a stale confirm
  // pointed at a row that may no longer exist is worse than none at all.
  useEffect(() => {
    setRewindConfirmIndex(null);
  }, [chat.messages.length]);

  const empty = !chat.messages.length && !chat.streaming && !chat.loading;

  return (
    <CodeLinkContext.Provider value={linkUnit}>
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-panel">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onKeyDown={onTranscriptKey}
        className="quiet-scroll min-h-0 flex-1 overflow-y-auto"
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
              Ask about this pull request. Cite a unit, a hunk, a file, a range of lines or one of
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
            mentions={allMentions}
            onOpenMention={openMention}
            busy={chat.busy}
            isEditing={chat.editingIndex === i}
            rewindConfirming={rewindConfirmIndex === i}
            rewinding={rewindConfirmIndex === i && chat.pending === "rewind"}
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
              // Until the first words arrive: the step it is on, the word
              // swept by a light, which reads as alive where a static
              // ellipsis read as stuck.
              <span className="chat-working text-xs" data-testid="chat-working">
                {chat.streaming.tools.length ? "Working" : "Thinking"}
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
              {chat.failure.retry ? (
                <button type="button" className="btn" onClick={chat.retry} disabled={chat.busy}>
                  retry
                </button>
              ) : (
                <button type="button" className="btn" data-testid="chat-dismiss-failure" onClick={chat.dismissFailure}>
                  dismiss
                </button>
              )}
              {chat.queue.length ? (
                <button
                  type="button"
                  className="btn"
                  data-testid="chat-skip-failure"
                  onClick={chat.dismissFailure}
                  data-tip="Leave this one unanswered and send the queued messages"
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
            jumping.current = true;
            pin(true);
            scrollToBottom("smooth");
          }}
          className="absolute bottom-24 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1 rounded-full px-2 py-1 text-2xs elev-2"
          style={{ background: "var(--bg-hover)", border: "1px solid var(--border-strong)", color: "var(--fg)" }}
        >
          <IconArrowDown width={10} height={10} />
          jump to latest
        </button>
      ) : null}

      {confirmClear ? (
        <div
          className="flex flex-none items-center gap-2 border-t px-3 py-2 text-2xs"
          style={{ borderColor: "var(--border)", background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          Clear this conversation? It cannot be recovered.
          <button
            type="button"
            className="btn ml-auto"
            disabled={chat.pending === "clear"}
            onClick={() => setConfirmClear(false)}
          >
            cancel
          </button>
          <button
            type="button"
            className="btn"
            data-testid="chat-clear-confirm"
            disabled={chat.pending === "clear"}
            onClick={() => {
              void chat.clearConversation().then(() => setConfirmClear(false));
            }}
          >
            {chat.pending === "clear" ? "clearing…" : "clear"}
          </button>
        </div>
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
                    data-tip="Stop the current reply and send this one next"
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
                  data-tip="Edit it in the composer"
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
                  data-tip="Remove from the queue"
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
                  tip={auto ? `${titleFor(r)}; attached from the selected unit` : titleFor(r)}
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
        <div className="relative">
        {mentionList.length ? (
          <MentionList
            options={mentionList}
            active={Math.min(mentionActive, mentionList.length - 1)}
            onHover={setMentionActive}
            onPick={pickMention}
          />
        ) : null}
        {/* A textarea cannot style a word, so the mentions are tinted on a
            copy of the text drawn behind it (same box, same wrapping, ink
            transparent), kept on the textarea's scroll. */}
        <div className="relative rounded" style={{ background: "var(--bg-inset)" }}>
        <div
          ref={mirrorRef}
          aria-hidden
          data-testid="chat-input-mirror"
          className="input pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-[20px]"
          style={{ color: "transparent", background: "transparent", borderColor: "transparent", boxShadow: "none" }}
        >
          {draftMentions.length ? <MentionText text={draft} spans={draftMentions} ink /> : null}
        </div>
        <textarea
          ref={textareaRef}
          data-testid="chat-input"
          className="input relative resize-none text-[13px] leading-[20px]"
          style={{ background: "transparent" }}
          onScroll={(e) => {
            if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          rows={2}
          placeholder={
            chat.busy
              ? `${capitalized(agentName)} is replying — queue a message…  (↵ queue · ⇧↵ newline · esc stop)`
              : chat.editingIndex !== null
                ? "Edit your message…  (↵ send · ⇧↵ newline)"
                : "Ask about this PR…  (↵ send · ⇧↵ newline)"
          }
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            trackMention(e.target);
          }}
          onSelect={(e) => trackMention(e.currentTarget)}
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-expanded={mentionList.length > 0}
        />
        </div>
        </div>
        {/* One row under the box: what is happening, the model for the next
            message, then the panel's tools and send. */}
        <div className="mt-1.5 flex items-center gap-2">
          {chat.busy ? (
            <span className="flex items-center gap-1.5 text-2xs" style={{ color: "var(--accent)" }}>
              <IconSpinner width={10} height={10} />
              {chat.stopping ? null : "thinking…"}
              <button
                type="button"
                data-testid="chat-stop"
                className="inline-flex items-center gap-1 rounded border px-1.5 py-px disabled:opacity-60"
                style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)", background: "var(--bg-inset)" }}
                data-tip="Stop the reply"
                data-tip-key="esc"
                aria-label="Stop the reply"
                disabled={chat.stopping}
                onClick={() => void chat.stop()}
              >
                <IconStop width={8} height={8} />
                {chat.stopping ? "stopping…" : "stop"}
              </button>
            </span>
          ) : null}
          {chat.agent && chat.configuredAgent ? (
            <ModelSelect
              manifest={manifestOf(agents, chat.agent.harness)}
              value={chat.agent.model}
              configured={modelLabel(manifestOf(agents, chat.configuredAgent.harness), chat.configuredAgent.model)}
              pinned={chat.sessionAgent?.model !== undefined}
              disabled={chat.pending === "agent"}
              onChange={(m) =>
                void chat.setAgent(
                  editSelection(chat.sessionAgent, "model", m, chat.agent!.harness, chat.configuredAgent!.harness),
                )
              }
            />
          ) : null}
          <span className="ml-auto" />
          {handoffHarness?.capabilities.handoff ? (
            <HandoffButton
              prKey={prKey}
              busy={chat.busy}
            />
          ) : null}
          {/* The rarely-used: one menu instead of a settings panel. */}
          <OverflowMenu
            fixed
            testId="chat-menu"
            label="More chat actions"
            buttonClassName="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--bg-hover)]"
            buttonStyle={{ color: "var(--fg-faint)" }}
            items={[
              {
                label: "clear conversation…",
                icon: <IconTrash width={12} height={12} />,
                testId: "chat-clear",
                disabled: chat.messages.length === 0,
                hint: "Asks first; it cannot be recovered.",
                onClick: () => setConfirmClear(true),
              },
              {
                label: "repo checkout…",
                icon: <IconFile width={12} height={12} />,
                testId: "chat-repo-settings-link",
                hint: `Where the chat reads the code from; shared by every PR in ${repoOwner}/${repoName}.`,
                onClick: () => navigate(`/repo/${repoHost}/${repoOwner}/${repoName}/settings`, { state: { background } }),
              },
            ]}
          />
          <button
            type="button"
            data-testid="chat-send"
            className="btn btn-primary"
            disabled={!draft.trim() || (chat.busy && chat.editingIndex !== null)}
            onClick={() => submit()}
          >
            {chat.editingIndex !== null ? "resend" : chat.busy || chat.queue.length ? "queue" : "send"}
          </button>
        </div>
      </div>
    </div>
    </CodeLinkContext.Provider>
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
  disabled,
  onChange,
  className,
}: {
  manifest: HarnessManifest | undefined;
  value: string;
  /** what "inherit" resolves to, as shown */
  configured: string;
  pinned: boolean;
  /** the switch is in flight */
  disabled?: boolean;
  onChange: (model: string | null) => void;
  className?: string;
}) {
  return (
    <label className={`flex items-center ${className ?? ""}`}>
      <span className="sr-only">Model for the next message</span>
      <select
        data-testid="chat-model-select"
        className="select pl-1 py-px text-2xs font-medium"
        data-tip={`Model for the next message${pinned ? "; pinned for this conversation" : ""}`}
        value={pinned ? value : "inherit"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "inherit" ? null : e.target.value)}
        style={{ color: pinned ? "var(--fg)" : "var(--fg-muted)" }}
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
 * Opens ordinary Claude Code in a separate writable worktree, with the
 * review conversation as context. Shows the workspace before the reader
 * runs the copied command. The server
 * refuses it over the LAN, so the button says so up front instead.
 */
function HandoffButton({ prKey, busy }: { prKey: string; busy: boolean }) {
  const label = "Open in Claude Code";
  const [state, setState] = useState<HandoffState | null>(null);
  const [recopied, setRecopied] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  /** Bumped on every open/close, so a reply that lands after a close is dropped. */
  const request = useRef(0);
  const reason = handoffDisabledReason({
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
    <span ref={wrapRef} className="relative inline-flex" data-tip={reason ?? label}>
      <button
        type="button"
        data-testid="chat-handoff"
        aria-label={label}
        aria-expanded={open}
        disabled={reason !== null}
        onClick={() => void start()}
        className="inline-flex items-center gap-1 rounded px-1 text-2xs hover:!text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-40"
        style={{ color: open ? "var(--fg)" : "var(--fg-muted)" }}
      >
        <IconTerminal width={12} height={12} />
        terminal
      </button>
      {state ? (
        <div
          role="dialog"
          aria-label={label}
          data-testid="chat-handoff-popover"
          className="surface absolute bottom-full right-0 z-30 mb-2 max-h-[calc(100vh-12rem)] w-72 overflow-y-auto rounded-md p-2 elev-2"
          onClick={(e) => e.stopPropagation()}
        >
          {state.phase === "loading" ? (
            <p className="flex items-center gap-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
              <IconSpinner width={10} height={10} />
              Preparing the worktree…
            </p>
          ) : state.phase === "error" ? (
            <p className="text-2xs leading-4" data-testid="chat-handoff-error" style={{ color: "var(--risk)" }}>
              {state.message}
            </p>
          ) : (
            <>
              <p className="text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
                {state.copied ? "Copied. Paste it" : "Paste this"} into a terminal to open Claude Code on this
                PR, free to edit code and run tests.
              </p>
              <dl className="mt-1.5 text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
                <dt style={{ color: "var(--fg-faint)" }}>{state.handoff.owned ? "Worktree" : "Your checkout"}</dt>
                <dd className="break-all font-mono" data-testid="chat-handoff-cwd">{state.handoff.cwd}</dd>
                <dt className="mt-1" style={{ color: "var(--fg-faint)" }}>Branch</dt>
                <dd className="break-all font-mono">{state.handoff.branch}</dd>
                <dt className="mt-1" style={{ color: "var(--fg-faint)" }}>Reviewed commit</dt>
                <dd className="font-mono">{state.handoff.startSha.slice(0, 12)}</dd>
                {state.handoff.headSha !== state.handoff.startSha ? <>
                  <dt className="mt-1" style={{ color: "var(--fg-faint)" }}>HEAD now</dt>
                  <dd className="font-mono">{state.handoff.headSha.slice(0, 12)}</dd>
                </> : null}
              </dl>
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
                {state.handoff.owned
                  ? "Purview keeps this worktree as you leave it, even when the PR changes, and never deletes it."
                  : "Your own checkout of the PR's branch, used as it stands."}{" "}
                Claude starts fresh, with this chat as context. What you do there won&apos;t appear here.
              </p>
            </>
          )}
        </div>
      ) : null}
    </span>
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
      data-tip={`Ask ${agentName} about this PR`}
      data-tip-key="c"
      style={open ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
    >
      <IconChat width={12} height={12} />
    </button>
  );
}

/** Small cite affordance reused by hunk headers, file rows and comments. */
export function QuoteButton({
  onClick,
  about,
  className,
  labeled = false,
}: {
  onClick: () => void;
  /** what gets cited, e.g. "this hunk" */
  about: string;
  className?: string;
  /** the icon with words, where the header has room on hover */
  labeled?: boolean;
}) {
  // It adds a reference to the chat's message; nothing is sent yet.
  const tip = `Cite ${about} in the chat`;
  if (labeled) {
    return (
      <button
        type="button"
        data-tip={tip}
        aria-label={tip}
        data-testid="quote-button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={`inline-flex flex-none items-center gap-1 whitespace-nowrap rounded px-1 font-sans text-2xs hover:!text-[var(--fg)] ${className ?? ""}`}
        style={{ color: "var(--fg-muted)" }}
      >
        <IconQuote width={12} height={12} />
        cite in chat
      </button>
    );
  }
  return (
    <button
      type="button"
      data-tip={tip}
      aria-label={tip}
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
