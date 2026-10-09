/**
 * Comments, read where they were written.
 *
 * The pill in the gutter answers "is there anything here?" (always visible,
 * never hover-only, edged like its most advanced comment) and opens the
 * thread under the line: the same cards the drawer and the finish list use,
 * set in from the left so they start where the code starts and read as
 * hanging off that line.
 */

import { threadMarker, threadsTitle, type DisplayThread } from "../lib/threads";
import { CommentPill } from "./CommentCard";
import { IconClose } from "./icons";
import { ThreadView, type ThreadListActions } from "./Threads";

export type InlineCommentActions = ThreadListActions;

/** The gutter / header marker. Kept under its old name for its callers. */
export function CommentBubble({
  threads,
  expanded,
  onToggle,
  compact,
  onHoverChange,
}: {
  /** what hangs off this line / file / folded hunk */
  threads: DisplayThread[];
  expanded: boolean;
  onToggle: () => void;
  /** the diff gutter variant */
  compact?: boolean;
  /** see CommentPill */
  onHoverChange?: (hovering: boolean) => void;
}) {
  return (
    <CommentPill
      marker={threadMarker(threads)}
      expanded={expanded}
      onToggle={onToggle}
      compact={compact}
      title={threadsTitle(threads)}
      onHoverChange={onHoverChange}
    />
  );
}

/**
 * The open thread. Rendered as its own row inside the virtualized list, so
 * its (very variable) height is measured like any other row.
 */
export function InlineCommentList({
  threads,
  label,
  onCollapse,
  onAdd,
  actions,
  indent = 0,
  composing = false,
  showPlacement = false,
}: {
  threads: DisplayThread[];
  /** what these comments hang off, for the add/collapse controls */
  label: string;
  onCollapse: () => void;
  onAdd?: () => void;
  actions: InlineCommentActions;
  /** css length from the row's left edge to where the code starts */
  indent?: number | string;
  /** a new comment is already being written here, right below */
  composing?: boolean;
  /** label threads with where they came from (the file block) */
  showPlacement?: boolean;
}) {
  return (
    <div
      data-testid="inline-comments"
      data-count={threads.length}
      className="py-2 pr-4"
      style={{ paddingLeft: indent, background: "var(--bg)" }}
      // The thread owns clicks inside it: a stray one must not re-focus the
      // hunk underneath or, worse, start a line selection.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex max-w-[46rem] justify-end">
        <button
          type="button"
          data-testid="inline-comments-close"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
          style={{ color: "var(--fg-faint)" }}
          title="Hide these comments (the marker in the gutter brings them back)"
          onClick={onCollapse}
        >
          hide <IconClose width={9} height={9} />
        </button>
      </div>
      {/* Standalone comments sit close together, as before; a GitHub thread
          gets air around it so two threads on one line read as two. */}
      <ul className="flex max-w-[46rem] flex-col gap-1.5">
        {threads.map((t, i) => (
          <li
            key={t.key}
            data-testid={t.remote ? `inline-thread-${t.key}` : `inline-comment-${t.key.slice("local:".length)}`}
            className={t.remote && i > 0 ? "mt-1.5" : undefined}
          >
            <ThreadView thread={t} actions={actions} showPlacement={showPlacement} />
          </li>
        ))}
      </ul>
      {onAdd && !composing ? (
        <button
          type="button"
          data-testid="inline-add-comment"
          className="mt-1.5 block w-full max-w-[46rem] rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]"
          style={{ border: "1px dashed var(--border-strong)", color: "var(--fg-faint)" }}
          title={`Add a comment on ${label}`}
          onClick={onAdd}
        >
          Add a comment…
        </button>
      ) : null}
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
