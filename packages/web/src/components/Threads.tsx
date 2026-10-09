/**
 * GitHub review threads, drawn next to Purview's own comments.
 *
 * A thread is its root card with the replies hanging off a rail to its left,
 * and a footer of thread actions (reply, resolve, open on GitHub) at the end
 * of the rail. Purview's own comments inside a thread are the usual
 * {@link CommentCard} (status edge and all); everyone else's are a
 * {@link RemoteCommentCard}: a quiet solid edge, the author, and no edit or
 * delete (they aren't the reader's to change).
 */

import { useRef, useState, type ReactNode } from "react";
import type { RemoteAuthor, RemoteComment, RemoteThread } from "../api/types";
import { formatCompactAge } from "../lib/reviewRequest";
import { formatFullTimestamp } from "../lib/prList";
import {
  authorOf,
  cleanRemoteBody,
  knownBots,
  placementLabel,
  splitReviewTags,
  threadRange,
  threadSummary,
  type DisplayThread,
  type ThreadFilters,
} from "../lib/threads";
import { AuthorAvatar } from "./AuthorAvatar";
import { CommentCard, type CommentActions } from "./CommentCard";
import { CopyForAgentButton } from "./CopyForAgent";
import { FloatingPanel } from "./FloatingPanel";
import { IconBot, IconCheck, IconChevron, IconFilter, IconReply } from "./icons";
import { Markdown } from "./Markdown";

/** What a thread can do, on top of what each of its comments can. */
export interface ThreadActions {
  /** open the composer as a reply to this thread */
  onReply?: (thread: DisplayThread) => void;
  onResolve?: (thread: RemoteThread, resolved: boolean) => void;
  /** the id of the thread whose resolve/unresolve is in flight */
  resolving?: string | null;
  /** the thread being replied to: its composer renders at the end of it */
  replyingTo?: string | null;
  renderReplyComposer?: () => ReactNode;
}

export type ThreadListActions = CommentActions & ThreadActions;

/** "3d ago", "just now"; null for a missing or unparseable stamp. */
export function age(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const a = formatCompactAge(ms);
  return a === "just now" ? a : `${a} ago`;
}

/** "AI" chip for an AI reviewer: distinct from the "by Claude" chip of the review chat. */
export function BotChip({ title }: { title?: string }) {
  return (
    <span
      className="chip flex-none"
      data-testid="bot-chip"
      style={{ background: "var(--bot-soft)", color: "var(--bot)" }}
      title={title ?? "An AI reviewer on GitHub"}
    >
      <IconBot width={10} height={10} />
      AI
    </span>
  );
}

/** Someone else's comment on GitHub (or the reader's own, written there directly). */
export function RemoteCommentCard({ comment }: { comment: RemoteComment }) {
  const author = authorOf({ kind: "remote", comment });
  const { tags, body } = splitReviewTags(cleanRemoteBody(comment.body));
  const created = age(comment.createdAt);
  const edited = comment.updatedAt && comment.updatedAt !== comment.createdAt;
  return (
    <article
      data-testid={`remote-comment-${comment.databaseId}`}
      data-author-kind={author.kind}
      className="group/comment rounded-md px-3 pb-2 pt-1.5"
      style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
    >
      <header className="flex min-h-[22px] items-center gap-1.5 text-2xs">
        <AuthorAvatar author={author.kind === "bot" ? author.name : comment.author.login} url={comment.author.avatarUrl} size={16} />
        <span className="min-w-0 truncate font-medium" style={{ color: "var(--fg)" }} title={comment.author.login}>
          {author.kind === "bot" ? author.name : author.kind === "you" ? `${comment.author.login} (you)` : comment.author.login}
        </span>
        {author.kind === "bot" ? <BotChip title={`${comment.author.login} — an AI reviewer`} /> : null}
        {comment.reviewState === "PENDING" ? (
          <span
            className="flex-none font-medium"
            style={{ color: "var(--accent)" }}
            title="In your pending review on GitHub — not public until you submit it"
          >
            pending
          </span>
        ) : null}
        {created ? (
          <span className="flex-none" style={{ color: "var(--fg-faint)" }} title={formatFullTimestamp(comment.createdAt)}>
            {created}
          </span>
        ) : null}
        {edited ? (
          <span className="flex-none" style={{ color: "var(--fg-faint)" }} title={`edited ${formatFullTimestamp(comment.updatedAt!)}`}>
            · edited
          </span>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-1">
          <CopyForAgentButton
            iconOnly
            testId={`copy-remote-${comment.databaseId}`}
            title="Copy this comment's markdown"
            text={() => cleanRemoteBody(comment.body)}
          />
          <a
            href={comment.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex-none rounded px-1 opacity-60 transition-opacity hover:underline hover:opacity-100"
            style={{ color: "var(--fg-muted)" }}
            title="Open this comment on GitHub"
            onClick={(e) => e.stopPropagation()}
          >
            ↗
          </a>
        </span>
      </header>
      {tags.length ? (
        <div className="mb-1 mt-0.5 flex flex-wrap gap-1" data-testid="review-tags">
          {tags.map((t) => (
            <span key={t} className="chip" style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}>
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-0.5 max-w-[72ch]" style={{ color: "var(--fg)" }}>
        <Markdown text={body} textClass="text-[13px] leading-[20px]" ink="var(--fg)" />
      </div>
    </article>
  );
}

function ThreadFooterButton({
  onClick,
  title,
  testId,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  testId?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-50"
      style={{ color: "var(--fg-muted)" }}
    >
      {children}
    </button>
  );
}

/**
 * One thread. A standalone Purview comment is just its card; a GitHub thread
 * is root + rail of replies + footer, collapsed to one line while resolved.
 */
export function ThreadView({
  thread,
  actions,
  showPlacement,
}: {
  thread: DisplayThread;
  actions: ThreadListActions;
  /** say where it came from (the file block: outdated, whole file…) */
  showPlacement?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const t = thread.remote;
  const replying = Boolean(t && actions.replyingTo === t.id);
  if (!t) {
    const only = thread.items[0];
    return only.kind === "local" ? <CommentCard comment={only.comment} actions={actions} /> : null;
  }
  // On its line, a multi-line thread still says which lines (the diff lights
  // them up too); in the file block the placement label covers that.
  const range = showPlacement ? null : threadRange(thread);
  const label = showPlacement ? placementLabel(thread) : range ? `lines ${range.start}–${range.end}` : null;
  const replies = thread.items.length - 1;

  if (thread.resolved && !open && !replying) {
    return (
      <button
        type="button"
        data-testid={`thread-${t.id}`}
        data-resolved="true"
        data-collapsed="true"
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]"
        style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg-muted)" }}
        title="Resolved — click to read the thread"
        onClick={() => setOpen(true)}
      >
        <IconCheck width={11} height={11} style={{ color: "var(--ok)", flex: "none" }} />
        <span className="flex-none font-medium">Resolved</span>
        {label ? (
          <span className="flex-none font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
            · {label}
          </span>
        ) : null}
        <span className="min-w-0 truncate" style={{ color: "var(--fg-faint)" }}>
          · {threadSummary(thread)}
        </span>
        {replies ? (
          <span className="flex-none text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
        ) : null}
        <IconChevron width={10} height={10} style={{ color: "var(--fg-faint)", flex: "none", marginLeft: "auto" }} />
      </button>
    );
  }

  const [root, ...rest] = thread.items;
  const renderItem = (item: (typeof thread.items)[number]) =>
    item.kind === "local" ? (
      <CommentCard comment={item.comment} actions={actions} />
    ) : (
      <RemoteCommentCard comment={item.comment} />
    );
  const busy = actions.resolving === t.id;
  const canResolve = t.isResolved ? t.viewerCanUnresolve : t.viewerCanResolve;

  return (
    <div data-testid={`thread-${t.id}`} data-resolved={t.isResolved ? "true" : "false"} data-outdated={t.isOutdated ? "true" : undefined}>
      {label ? (
        <div
          className="mb-1 flex items-center gap-1.5 px-0.5 font-mono text-2xs"
          style={{ color: thread.placement === "outdated" ? "var(--warn)" : "var(--fg-faint)" }}
          data-testid="thread-placement"
        >
          {label}
        </div>
      ) : null}
      <div data-testid={`thread-item-${t.id}`}>{renderItem(root)}</div>
      <div
        className="ml-3 flex flex-col gap-1.5 pl-3 pt-1.5"
        style={{ borderLeft: "2px solid var(--border)" }}
        data-testid="thread-replies"
      >
        {rest.map((item) => (
          <div key={item.kind === "local" ? item.comment.id : item.comment.id}>{renderItem(item)}</div>
        ))}
        {replying ? actions.renderReplyComposer?.() : null}
        <div className="-ml-1.5 flex flex-wrap items-center gap-0.5 text-2xs">
          {actions.onReply && t.viewerCanReply && !replying ? (
            <ThreadFooterButton
              testId={`thread-reply-${t.id}`}
              title="Reply in this thread (saved as a draft, sent with your review)"
              onClick={() => actions.onReply!(thread)}
            >
              <IconReply width={11} height={11} /> Reply
            </ThreadFooterButton>
          ) : null}
          {actions.onResolve && canResolve ? (
            <ThreadFooterButton
              testId={`thread-resolve-${t.id}`}
              title={t.isResolved ? "Mark this thread as unresolved on GitHub" : "Resolve this thread on GitHub (right away)"}
              disabled={busy}
              onClick={() => actions.onResolve!(t, !t.isResolved)}
            >
              <IconCheck width={11} height={11} />
              {busy ? (t.isResolved ? "unresolving…" : "resolving…") : t.isResolved ? "Unresolve" : "Resolve"}
            </ThreadFooterButton>
          ) : null}
          {t.comments[0] ? (
            <a
              href={t.comments[0].url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
              style={{ color: "var(--fg-muted)" }}
              title="Open this thread on GitHub"
            >
              GitHub ↗
            </a>
          ) : null}
          {t.isResolved ? (
            <>
              <span className="ml-auto" style={{ color: "var(--ok)" }}>
                resolved{t.resolvedBy ? ` by @${t.resolvedBy}` : ""}
              </span>
              <ThreadFooterButton title="Collapse this resolved thread" onClick={() => setOpen(false)}>
                collapse
              </ThreadFooterButton>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The filters as a compact popover: resolved threads, AI reviewers as a
 * whole, and each AI reviewer present on the PR.
 */
export function ThreadFilterMenu({
  filters,
  threads,
  hidden,
  onShowResolved,
  onShowAiReviewers,
  onBotHidden,
  compact,
  posts = [],
}: {
  filters: ThreadFilters;
  /** the PR's threads, for the per-bot list */
  threads: RemoteThread[];
  /** who wrote each review and conversation comment, so post-only bots are listed too */
  posts?: readonly RemoteAuthor[];
  /** how many threads the filters hide right now */
  hidden: number;
  onShowResolved: (v: boolean) => void;
  onShowAiReviewers: (v: boolean) => void;
  onBotHidden: (key: string, hidden: boolean) => void;
  /** icon only (the diff toolbars) */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bots = knownBots(threads, posts);
  const resolvedCount = threads.filter((t) => t.isResolved).length;
  if (threads.length === 0 && bots.length === 0) return null;
  const active = !filters.showResolved || !filters.showAiReviewers || filters.hiddenBots.length > 0;
  return (
    <span ref={wrapRef} className="relative inline-flex flex-none">
      <button
        type="button"
        data-testid="thread-filters"
        aria-expanded={open}
        title={hidden ? `GitHub threads: ${hidden} hidden by your filters` : "Which GitHub threads to show"}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-[22px] items-center gap-1 rounded px-1.5 text-2xs transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          color: active ? "var(--accent)" : "var(--fg-faint)",
          border: "1px solid var(--border)",
          background: open ? "var(--bg-hover)" : "var(--bg-inset)",
        }}
      >
        <IconFilter width={11} height={11} />
        {compact ? (hidden ? <span className="tabular-nums">{hidden}</span> : null) : <span>threads{hidden ? ` · ${hidden} hidden` : ""}</span>}
      </button>
      {open ? (
        <FloatingPanel anchorRef={wrapRef} onClose={() => setOpen(false)} label="GitHub thread filters" className="w-64 p-2.5 text-xs">
          <div className="mb-1.5 text-2xs font-semibold" style={{ color: "var(--fg-muted)" }}>
            GitHub threads
          </div>
          <FilterCheck
            testId="filter-resolved"
            checked={filters.showResolved}
            onChange={onShowResolved}
            label="Show resolved"
            count={resolvedCount}
            hint="They show collapsed to one line"
          />
          {bots.length ? (
            <>
              <FilterCheck
                testId="filter-ai"
                checked={filters.showAiReviewers}
                onChange={onShowAiReviewers}
                label="Show AI reviewers"
                count={bots.reduce((n, b) => n + b.count, 0)}
              />
              <div className="ml-5 mt-0.5 flex flex-col">
                {bots.map((b) => (
                  <FilterCheck
                    key={b.key}
                    testId={`filter-bot-${b.key}`}
                    checked={!filters.hiddenBots.includes(b.key)}
                    disabled={!filters.showAiReviewers}
                    onChange={(v) => onBotHidden(b.key, !v)}
                    label={b.name}
                    count={b.count}
                  />
                ))}
              </div>
            </>
          ) : null}
          <p className="mt-2 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
            Threads holding a reply you haven't sent always show.
          </p>
        </FloatingPanel>
      ) : null}
    </span>
  );
}

function FilterCheck({
  checked,
  onChange,
  label,
  count,
  hint,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  count?: number;
  hint?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label
      className={`flex items-center gap-2 rounded px-1 py-0.5 ${disabled ? "opacity-50" : "cursor-pointer hover:bg-[var(--bg-hover)]"}`}
      title={hint}
      style={{ color: "var(--fg)" }}
    >
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--accent)" }}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
          {count}
        </span>
      ) : null}
    </label>
  );
}
