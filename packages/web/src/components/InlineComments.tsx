/**
 * Comments, read where they were written.
 *
 * The pill in the gutter answers "is there anything here?" (always visible,
 * never hover-only, edged like its most advanced comment) and opens the
 * thread under the line: the same cards the drawer and the finish list use,
 * set in from the left so they start where the code starts and read as
 * hanging off that line.
 */

import type { DraftComment } from "../api/types";
import { bubbleTitle } from "../lib/comments";
import { CommentCard, CommentPill, type CommentActions } from "./CommentCard";

export type InlineCommentActions = CommentActions;

/** The gutter / header marker. Kept under its old name for its callers. */
export function CommentBubble({
  comments,
  expanded,
  onToggle,
  compact,
}: {
  comments: DraftComment[];
  expanded: boolean;
  onToggle: () => void;
  /** the diff gutter variant */
  compact?: boolean;
}) {
  return (
    <CommentPill
      comments={comments}
      expanded={expanded}
      onToggle={onToggle}
      compact={compact}
      title={bubbleTitle(comments)}
    />
  );
}

/**
 * The open thread. Rendered as its own row inside the virtualized list, so
 * its (very variable) height is measured like any other row.
 */
export function InlineCommentList({
  comments,
  label,
  onCollapse,
  onAdd,
  actions,
  indent = 0,
}: {
  comments: DraftComment[];
  /** what these comments hang off, for the add/collapse controls */
  label: string;
  onCollapse: () => void;
  onAdd?: () => void;
  actions: InlineCommentActions;
  /** css length from the row's left edge to where the code starts */
  indent?: number | string;
}) {
  return (
    <div
      data-testid="inline-comments"
      data-count={comments.length}
      className="py-2 pr-4"
      style={{ paddingLeft: indent, background: "var(--bg)" }}
      // The thread owns clicks inside it: a stray one must not re-focus the
      // hunk underneath or, worse, start a line selection.
      onClick={(e) => e.stopPropagation()}
    >
      <ul className="flex max-w-[46rem] flex-col gap-1.5">
        {comments.map((c) => (
          <li key={c.id} data-testid={`inline-comment-${c.id}`}>
            <CommentCard comment={c} actions={actions} />
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex max-w-[46rem] items-center gap-2">
        {onAdd ? (
          <button
            type="button"
            data-testid="inline-add-comment"
            className="flex-1 rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]"
            style={{ border: "1px dashed var(--border-strong)", color: "var(--fg-faint)" }}
            title={`Add a comment on ${label}`}
            onClick={onAdd}
          >
            Add a comment…
          </button>
        ) : null}
        <button
          type="button"
          data-testid="inline-comments-close"
          className="flex-none rounded px-2 py-1.5 text-2xs transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--fg-faint)" }}
          title="Hide these comments (the marker in the gutter brings them back)"
          onClick={onCollapse}
        >
          hide
        </button>
      </div>
    </div>
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
