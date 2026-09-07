/**
 * Comments, read where they were written.
 *
 * Before this, a comment vanished the moment it was saved: the drafts drawer
 * was the only place it existed, so the diff — the thing the comment is
 * *about* — showed no trace of it. The bubble fixes the "is there anything
 * here?" question (always visible, never hover-only, painted by the most
 * advanced status on the line), and expanding it answers "what does it say?"
 * in place, with the same actions the drawer offers.
 */

import type { ChatRef, CommentStatus, DraftComment } from "../api/types";
import { formatComment, type DiffContext } from "../lib/agentExport";
import { bubbleTitle, mostAdvancedStatus, statusColors } from "../lib/comments";
import { QuoteButton } from "./ChatPanel";
import { CopyForAgentButton } from "./CopyForAgent";
import { CommentBody, commentRef, type EditComment } from "./Drafts";
import { StatusChip } from "./FinishReview";
import { IconClose, IconComment } from "./icons";

/** The actions an inline comment offers; all optional, all reused from elsewhere. */
export interface InlineCommentActions {
  onEdit?: EditComment;
  onDelete?: (comment: DraftComment) => void;
  deleting?: boolean;
  onQuote?: (ref: ChatRef) => void;
  /** the diff to slice a snippet out of, for copy-for-agent */
  exportCtx?: DiffContext;
}

/**
 * The persistent gutter indicator. Deliberately small and quiet — it sits in
 * the same 15px column the `+` uses, so a commented line is not visually
 * louder than its neighbours, only *marked*.
 */
export function CommentBubble({
  comments,
  expanded,
  onToggle,
  compact,
}: {
  comments: DraftComment[];
  expanded: boolean;
  onToggle: () => void;
  /** the diff gutter variant: no padding to spare, count rides alongside */
  compact?: boolean;
}) {
  const status = mostAdvancedStatus(comments);
  const { fg, bg } = statusColors(status);
  const count = comments.length;
  return (
    <button
      type="button"
      data-testid="comment-bubble"
      data-status={status}
      data-count={count}
      data-expanded={expanded ? "true" : "false"}
      aria-expanded={expanded}
      title={bubbleTitle(comments)}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`inline-flex flex-none select-none items-center gap-[1px] rounded ${
        compact ? "mx-0 my-[2px] px-[1px]" : "px-1 py-0.5"
      }`}
      style={{
        background: expanded ? fg : bg,
        color: expanded ? "var(--bg)" : fg,
        boxShadow: expanded ? undefined : `inset 0 0 0 1px ${fg}`,
        lineHeight: 1,
      }}
    >
      <IconComment width={compact ? 9 : 11} height={compact ? 9 : 11} />
      {count > 1 ? (
        <span className="tabular-nums" style={{ fontSize: compact ? 8 : 9 }}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The expanded block. Rendered as its own row inside the virtualized list, so
 * its (very variable) height is measured like any other row rather than
 * smuggled inside a fixed-height line.
 */
export function InlineCommentList({
  comments,
  label,
  onCollapse,
  onAdd,
  actions,
}: {
  comments: DraftComment[];
  /** what these comments hang off, shown as the block's caption */
  label: string;
  onCollapse: () => void;
  onAdd?: () => void;
  actions: InlineCommentActions;
}) {
  const status = mostAdvancedStatus(comments);
  const { fg } = statusColors(status);
  return (
    <div
      data-testid="inline-comments"
      data-count={comments.length}
      className="px-3 py-2"
      style={{
        background: "var(--bg-raised)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        borderLeft: `2px solid ${fg}`,
      }}
      // The list owns clicks inside it: a stray one must not re-focus the hunk
      // underneath or, worse, start a line selection.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="truncate font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
          {label}
        </span>
        <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
          {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </span>
        {onAdd ? (
          <button
            type="button"
            data-testid="inline-add-comment"
            className="btn"
            title="Add another comment here"
            onClick={onAdd}
          >
            add another
          </button>
        ) : null}
        <button
          type="button"
          data-testid="inline-comments-close"
          className="ml-auto flex-none px-1 text-xs leading-none"
          style={{ color: "var(--fg-faint)" }}
          title="Collapse these comments"
          onClick={onCollapse}
        >
          <IconClose width={10} height={10} />
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {comments.map((c) => (
          <InlineComment key={c.id} comment={c} actions={actions} />
        ))}
      </ul>
    </div>
  );
}

function InlineComment({
  comment,
  actions,
}: {
  comment: DraftComment;
  actions: InlineCommentActions;
}) {
  const { onEdit, onDelete, deleting, onQuote, exportCtx } = actions;
  const status: CommentStatus = comment.status ?? "draft";
  return (
    <li
      data-testid={`inline-comment-${comment.id}`}
      className="rounded p-2"
      style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
          {formatTimestamp(comment.createdAt)}
        </span>
        <StatusChip status={status} />
      </div>
      {/* The edit flow — including the "this is already public" confirmation —
          is the drawer's, unchanged; only the rendering differs. */}
      <CommentBody comment={comment} edit={onEdit} markdown />
      <div className="mt-1 flex items-center gap-1.5">
        {onQuote ? (
          <QuoteButton
            title="Ask Claude about this comment"
            onClick={() => onQuote(commentRef(comment))}
          />
        ) : null}
        {exportCtx ? (
          <CopyForAgentButton
            iconOnly
            testId={`copy-inline-${comment.id}`}
            title="Copy this comment, with its code, for an agent"
            text={() => formatComment(comment, exportCtx)}
          />
        ) : null}
        {onDelete && status !== "submitted" ? (
          <button
            type="button"
            data-testid={`delete-inline-${comment.id}`}
            className="btn ml-auto"
            disabled={deleting}
            onClick={() => onDelete(comment)}
            title={
              status === "pushed"
                ? "Also removes it from your pending review on GitHub"
                : "Delete this local draft"
            }
          >
            delete
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** Short and local; the exact instant matters less than "when, roughly". */
export function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
