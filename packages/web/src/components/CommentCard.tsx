/**
 * One comment, drawn the same way wherever it appears: the inline thread under
 * a diff line, the comments drawer, and the finish-review list.
 *
 * Status is carried by the card's own outline rather than a chip: a dashed
 * accent edge for a draft (it has gone nowhere yet), a solid accent edge once
 * pushed into the pending review on GitHub, and a quiet solid edge once
 * submitted and public. The same three edges mark the gutter pill, so a line's
 * marker and its thread read as one thing.
 */

import { useState, type ReactNode } from "react";
import type { ChatRef, CommentStatus, DraftComment } from "../api/types";
import { formatComment, type DiffContext } from "../lib/agentExport";
import { pendingAttachmentCount } from "../lib/attachments";
import { formatCompactAge } from "../lib/reviewRequest";
import { formatFullTimestamp } from "../lib/prList";
import type { MarkerLook, MarkerSummary } from "../lib/threads";
import { QuoteButton } from "./ChatPanel";
import { CopyForAgentButton } from "./CopyForAgent";
import { AgentEditNote, ByAgentChip, CommentBody, commentRef, type EditComment } from "./Drafts";
import { IconComment, IconCommentFilled, IconEdit, IconTrash } from "./icons";

export const COMMENT_STATUS: Record<
  CommentStatus,
  { label: string; hint: string; edge: string; ink: string; tint: string }
> = {
  draft: {
    label: "draft",
    hint: "Only on this machine until you sync or finish the review",
    edge: "1px dashed var(--accent)",
    ink: "var(--accent)",
    tint: "var(--accent-soft)",
  },
  pushed: {
    label: "pushed",
    hint: "In your pending review on GitHub — not public until you submit it",
    edge: "1px solid var(--accent)",
    ink: "var(--accent)",
    tint: "var(--accent-soft)",
  },
  submitted: {
    label: "submitted",
    hint: "Submitted with a review: public on GitHub",
    edge: "1px solid var(--border-strong)",
    ink: "var(--fg-muted)",
    tint: "var(--bg-inset)",
  },
};

/** The actions a comment offers; each one is optional and hidden when absent. */
export interface CommentActions {
  onEdit?: EditComment;
  onDelete?: (comment: DraftComment) => void;
  deleting?: boolean;
  onQuote?: (ref: ChatRef) => void;
  /** the diff to slice a snippet out of, for copy-for-agent */
  exportCtx?: DiffContext;
  /** take back the review chat's latest edit to a draft */
  onUndoEdit?: (id: string) => void;
  undoing?: boolean;
}

export function CommentCard({
  comment,
  actions,
  anchor,
  clamp,
  notice,
}: {
  comment: DraftComment;
  actions: CommentActions;
  /** a header link to where the comment lives (drawer and finish list) */
  anchor?: { label: string; onJump: () => void };
  /** crop the body to three lines (the finish list is short on room) */
  clamp?: boolean;
  /** extra content between header and body (e.g. "outside the diff") */
  notice?: ReactNode;
}) {
  const status: CommentStatus = comment.status ?? "draft";
  const meta = COMMENT_STATUS[status];
  const { onEdit, onDelete, deleting, onQuote, exportCtx, onUndoEdit, undoing } = actions;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canDelete = Boolean(onDelete) && status !== "submitted";
  const age = comment.createdAt ? Date.now() - new Date(comment.createdAt).getTime() : NaN;

  return (
    <article
      data-testid={`comment-card-${comment.id}`}
      data-status={status}
      className="group/comment rounded-md px-3 pb-2 pt-1.5"
      style={{ background: "var(--bg-raised)", border: meta.edge }}
    >
      <header className="flex min-h-[22px] items-center gap-2 text-2xs">
        {anchor ? (
          <button
            type="button"
            className="min-w-0 truncate font-mono hover:underline"
            style={{ color: "var(--fg-muted)" }}
            onClick={anchor.onJump}
            // The file's name and the line are what tell comments apart in a
            // narrow list; the directory is on hover.
            title={`${anchor.label} — show it in the diff`}
          >
            {anchor.label.slice(anchor.label.lastIndexOf("/") + 1)}
          </button>
        ) : null}
        <span className="flex-none font-medium" style={{ color: meta.ink }} title={meta.hint}>
          {meta.label}
        </span>
        <ByAgentChip comment={comment} />
        <PendingImagesChip comment={comment} />
        {Number.isFinite(age) ? (
          <span className="flex-none" style={{ color: "var(--fg-faint)" }} title={formatFullTimestamp(comment.createdAt!)}>
            {formatCompactAge(age) === "just now" ? "just now" : `${formatCompactAge(age)} ago`}
          </span>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-0.5">
          {onQuote ? (
            <QuoteButton about="this comment" onClick={() => onQuote(commentRef(comment))} />
          ) : null}
          {exportCtx ? (
            <CopyForAgentButton
              iconOnly
              testId={`copy-comment-${comment.id}`}
              title="Copy this comment, with its code, for an agent"
              text={() => formatComment(comment, exportCtx)}
            />
          ) : null}
          {onEdit && !editing ? (
            <IconAction
              title={status === "submitted" ? "Edit (this comment is public)" : "Edit"}
              testId={`edit-${comment.id}`}
              onClick={() => setEditing(true)}
            >
              <IconEdit width={11} height={11} />
            </IconAction>
          ) : null}
          {canDelete ? (
            <IconAction
              title={status === "pushed" ? "Delete (also from your pending review on GitHub)" : "Delete"}
              testId={`delete-${comment.id}`}
              danger
              disabled={deleting}
              onClick={() => setConfirmDelete(true)}
            >
              <IconTrash width={11} height={11} />
            </IconAction>
          ) : null}
        </span>
      </header>
      {notice}
      <CommentBody
        comment={comment}
        edit={onEdit}
        markdown
        clamp={clamp}
        bodyClass="text-[13px] leading-[20px]"
        editing={editing}
        onEditingChange={setEditing}
      />
      <AgentEditNote comment={comment} onUndo={onUndoEdit} busy={undoing} />
      {confirmDelete ? (
        <div
          className="mt-1.5 flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-2xs"
          style={{ background: "var(--risk-soft)", color: "var(--risk)" }}
          data-testid={`confirm-delete-${comment.id}`}
        >
          <span className="min-w-0 flex-1">
            {status === "pushed"
              ? "Delete it? It also leaves your pending review on GitHub."
              : "Delete this draft?"}
          </span>
          <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
            keep
          </button>
          <button
            type="button"
            className="btn"
            data-testid={`delete-inline-${comment.id}`}
            style={{ color: "var(--bg)", background: "var(--risk)", borderColor: "var(--risk)" }}
            disabled={deleting}
            onClick={() => {
              setConfirmDelete(false);
              onDelete?.(comment);
            }}
          >
            {deleting ? "deleting…" : "delete"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** "2 images" — a draft's pictures are still only on this machine; they go up with the push. */
function PendingImagesChip({ comment }: { comment: Pick<DraftComment, "body" | "status"> }) {
  const n = pendingAttachmentCount(comment);
  if (n === 0) return null;
  return (
    <span
      className="chip"
      data-testid="pending-images"
      style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
      title={`${n === 1 ? "This image is" : "These images are"} only on this machine; uploaded to GitHub when the comment is pushed`}
    >
      {n} {n === 1 ? "image" : "images"}
    </span>
  );
}

function IconAction({
  title,
  testId,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  testId?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testId}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex-none rounded p-1 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30 ${
        danger ? "hover:!text-[var(--risk)]" : "hover:!text-[var(--fg)]"
      }`}
      style={{ color: "var(--fg-muted)" }}
    >
      {children}
    </button>
  );
}

/**
 * How a marker looks when the reader has nothing of their own there: other
 * people's GitHub threads read as a quiet, filled neutral; a line only AI
 * reviewers commented on gets the bot tint, so it's easy to tell apart (and
 * to skip) at a glance.
 */
export const REMOTE_LOOK: Record<"remote" | "bot", { ink: string; tint: string; hint: string }> = {
  remote: { ink: "var(--fg-muted)", tint: "var(--bg-inset)", hint: "On GitHub" },
  bot: { ink: "var(--bot)", tint: "var(--bot-soft)", hint: "From an AI reviewer on GitHub" },
};

function markerLook(look: MarkerLook): { ink: string; tint: string } {
  return look === "remote" || look === "bot" ? REMOTE_LOOK[look] : COMMENT_STATUS[look];
}

/**
 * The marker for a line (or file, or folded hunk) that has comments: a speech
 * bubble in the color of the comment that still needs the reader — outlined
 * while a draft (it has gone nowhere), filled once pushed, filled and quiet
 * once submitted — with a small floating count when there is more than one.
 * Lines with only other people's GitHub threads get a neutral (or, for AI
 * reviewers only, bot-tinted) filled bubble; a line whose threads are all
 * resolved steps back. It sits on a rounded square that shows on hover (it is
 * a button: it opens the thread) and stays tinted while the thread is open.
 */
export function CommentPill({
  marker,
  expanded,
  onToggle,
  compact,
  title,
}: {
  marker: MarkerSummary;
  expanded: boolean;
  onToggle: () => void;
  /** the diff gutter variant (hover follows the line, not the icon) */
  compact?: boolean;
  title: string;
}) {
  const { look, count, resolved } = marker;
  const meta = markerLook(look);
  const Icon = look === "draft" ? IconComment : IconCommentFilled;
  return (
    <button
      type="button"
      data-testid="comment-bubble"
      data-status={look}
      data-count={count}
      data-resolved={resolved ? "true" : undefined}
      data-expanded={expanded ? "true" : "false"}
      aria-expanded={expanded}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`comment-marker relative inline-flex h-[18px] w-[18px] flex-none select-none items-center justify-center rounded-[4px] transition-colors ${
        compact
          ? "group-hover:bg-[var(--bg-raised)] group-hover:shadow-[inset_0_0_0_1px_var(--border-strong)] group-hover/half:bg-[var(--bg-raised)] group-hover/half:shadow-[inset_0_0_0_1px_var(--border-strong)]"
          : ""
      } hover:!bg-[var(--bg-raised)] hover:shadow-[inset_0_0_0_1px_var(--border-strong)]`}
      style={{ color: meta.ink, background: expanded ? meta.tint : undefined }}
    >
      <Icon width={13} height={13} style={{ opacity: resolved && !expanded ? 0.45 : undefined }} />
      {count > 1 ? (
        <span
          className="absolute -right-[5px] -top-[4px] flex h-[11px] min-w-[11px] items-center justify-center rounded-full px-[2px] text-[8px] font-bold tabular-nums leading-none"
          style={{
            background: meta.ink,
            color: "var(--bg)",
            boxShadow: "0 0 0 1.5px var(--bg)",
            opacity: resolved && !expanded ? 0.6 : undefined,
          }}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
