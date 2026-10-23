/**
 * One comment, drawn the same way wherever it appears: the inline thread under
 * a diff line, the comments drawer, and the finish-review list.
 *
 * Who it is for is carried by a bar on the card's left edge: accent for a
 * comment headed to GitHub, violet for a note to a coding agent, quiet once
 * submitted and public. The status word next to the anchor says where it is
 * in the review's lifecycle. The gutter pill uses the same colours, so a
 * line's marker and its thread read as one thing.
 */

import { useMemo, useEffect, useState, type ReactNode } from "react";
import type { ChatRef, CommentAudience, CommentStatus, DraftComment } from "../api/types";
import { formatComment, type DiffContext } from "../lib/agentExport";
import { isForAgent, isRange, lineLabel, outdatedCommentTip } from "../lib/comments";
import { pendingAttachmentCount } from "../lib/attachments";
import { formatCompactAge } from "../lib/reviewRequest";
import { formatFullTimestamp } from "../lib/prList";
import { suggestionSource } from "../lib/suggestion";
import type { MarkerLook, MarkerSummary } from "../lib/threads";
import { QuoteButton } from "./ChatPanel";
import { CopyForAgentButton } from "./CopyForAgent";
import { AgentEditNote, ByAgentChip, CommentBody, commentRef, type EditComment } from "./Drafts";
import { IconComment, IconCommentFilled, IconEdit, IconSend, IconSwap, IconTrash } from "./icons";
import { SuggestionContext } from "./Markdown";

export const COMMENT_STATUS: Record<
  CommentStatus,
  { label: string; hint: string; edge: string; ink: string; tint: string }
> = {
  draft: {
    label: "draft",
    hint: "Only on this machine until you sync or finish the review",
    edge: "var(--accent)",
    ink: "var(--accent)",
    tint: "var(--accent-soft)",
  },
  pushed: {
    label: "pushed",
    hint: "In your pending review on GitHub — not public until you submit it",
    edge: "var(--accent)",
    ink: "var(--accent)",
    tint: "var(--accent-soft)",
  },
  submitted: {
    label: "submitted",
    hint: "Submitted with a review: public on GitHub",
    edge: "var(--border-strong)",
    ink: "var(--fg-muted)",
    tint: "var(--bg-inset)",
  },
};

/** The look of a note for a coding agent: violet, never on its way anywhere. */
export const AGENT_LOOK = {
  label: "for agent",
  hint: "A note for a coding agent: copy it or send it to the chat. It never goes to GitHub.",
  edge: "var(--agent)",
  ink: "var(--agent)",
  tint: "var(--agent-soft)",
};

/** The actions a comment offers; each one is optional and hidden when absent. */
export interface CommentActions {
  onEdit?: EditComment;
  onDelete?: (comment: DraftComment) => void;
  /** the id of the comment whose delete is in flight */
  deleting?: string | null;
  onQuote?: (ref: ChatRef) => void;
  /** the diff to slice a snippet out of, for copy-for-agent */
  exportCtx?: DiffContext;
  /** take back the review chat's latest edit to a draft */
  onUndoEdit?: (id: string) => void;
  undoing?: boolean;
  /** re-file a draft for the other audience (GitHub ↔ agent) */
  onMove?: (comment: DraftComment, audience: CommentAudience) => void;
  moving?: boolean;
  /** post a GitHub draft publicly right now, outside any review */
  onPublish?: (comment: DraftComment) => void;
  /** the id of the draft whose "publish now" is in flight */
  publishing?: string | null;
  /** the last action on one comment the server refused, shown under that card */
  error?: CommentActionError | null;
}

export interface CommentActionError {
  id: string;
  message: string;
}

export function CommentCard({
  comment,
  actions,
  anchor,
  clamp,
  notice,
  highlight,
}: {
  comment: DraftComment;
  actions: CommentActions;
  /** a header link to where the comment lives (drawer and finish list) */
  anchor?: { label: string; onJump: () => void };
  /** crop the body to three lines (the finish list is short on room) */
  clamp?: boolean;
  /** extra content between header and body (e.g. "outside the diff") */
  notice?: ReactNode;
  /** pulse once: the list just scrolled here to show where the card went */
  highlight?: boolean;
}) {
  const status: CommentStatus = comment.status ?? "draft";
  const forAgent = isForAgent(comment);
  const meta = forAgent ? AGENT_LOOK : COMMENT_STATUS[status];
  const { onEdit, onDelete, onQuote, exportCtx, onUndoEdit, undoing, onMove, moving, onPublish } = actions;
  const deleting = actions.deleting === comment.id;
  const publishing = actions.publishing === comment.id;
  const actionError = actions.error?.id === comment.id ? actions.error.message : null;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  // The confirmation stays up while the post is in flight and says so; it
  // closed itself on the click before, so for the seconds GitHub took the
  // card looked like an untouched draft.
  useEffect(() => {
    if (!publishing) setConfirmPublish(false);
  }, [publishing]);
  const canDelete = Boolean(onDelete) && status !== "submitted";
  // Only a draft changes hands; a reply stays with its thread on GitHub.
  const canMove = Boolean(onMove) && status === "draft" && !comment.inReplyTo;
  const canPublish = Boolean(onPublish) && status === "draft" && !forAgent && !comment.inReplyTo;
  const age = comment.createdAt ? Date.now() - new Date(comment.createdAt).getTime() : NaN;
  // The lines this comment covers, for its ```suggestion blocks (drawn
  // against them) and for writing one while editing. Without the diff
  // (no exportCtx) a block shows only what it suggests.
  const suggestion = useMemo(
    () => suggestionSource(exportCtx?.files, comment, exportCtx?.diff),
    [exportCtx, comment],
  );

  return (
    <SuggestionContext.Provider value={suggestion.lines}>
    <article
      data-testid={`comment-card-${comment.id}`}
      data-status={status}
      data-audience={forAgent ? "agent" : "github"}
      data-publishing={publishing || undefined}
      data-flash={highlight || undefined}
      className="group/comment rounded-md px-3 pb-2 pt-1.5"
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border-strong)",
        boxShadow: `inset 3px 0 0 ${meta.edge}`,
      }}
    >
      <header className="flex min-h-[22px] items-center gap-2 text-2xs">
        {comment.outdated && <span data-testid="comment-outdated" className="rounded px-1 font-medium" style={{ color: "var(--warn)", background: "var(--warn-soft)" }} data-tip={outdatedCommentTip(comment)}>outdated</span>}
        {anchor ? (
          <button
            type="button"
            className="min-w-0 truncate font-mono hover:underline"
            style={{ color: "var(--fg-muted)" }}
            onClick={anchor.onJump}
            // The file's name and the line are what tell comments apart in a
            // narrow list; the directory is on hover.
            data-tip={`${anchor.label}; show it in the diff`}
          >
            {anchor.label.slice(anchor.label.lastIndexOf("/") + 1)}
          </button>
        ) : null}
        <span
          className={`flex-none font-medium${publishing ? " animate-pulse" : ""}`}
          style={{ color: meta.ink }}
          data-tip={publishing ? "Posting on GitHub" : meta.hint}
        >
          {publishing ? "publishing…" : meta.label}
        </span>
        {/* Inline, the covered lines light up; the words still say so (and
            are all there is when the card sits in a file block or a list
            that names no anchor). */}
        {!anchor && isRange(comment) ? (
          <span className="flex-none font-mono" style={{ color: "var(--fg-faint)" }} data-testid="comment-lines">
            lines {lineLabel(comment)}
          </span>
        ) : null}
        <ByAgentChip comment={comment} />
        <PendingImagesChip comment={comment} />
        {Number.isFinite(age) ? (
          <span className="flex-none" style={{ color: "var(--fg-faint)" }} data-tip={formatFullTimestamp(comment.createdAt!)}>
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
              tip="Copy with its code, for an agent"
              text={() => formatComment(comment, exportCtx)}
            />
          ) : null}
          {canMove ? (
            <IconAction
              tip={forAgent ? "Move to GitHub: part of your review" : "Move to agent: a note for a coding agent"}
              testId={`move-${comment.id}`}
              disabled={moving}
              onClick={() => onMove!(comment, forAgent ? "github" : "agent")}
            >
              <IconSwap width={11} height={11} />
            </IconAction>
          ) : null}
          {canPublish ? (
            <IconAction
              tip="Publish now: a public comment on GitHub, outside any review"
              testId={`publish-${comment.id}`}
              disabled={publishing}
              onClick={() => setConfirmPublish(true)}
            >
              <IconSend width={11} height={11} />
            </IconAction>
          ) : null}
          {onEdit && !editing ? (
            <IconAction
              tip={status === "submitted" ? "Edit; this comment is public" : "Edit"}
              testId={`edit-${comment.id}`}
              onClick={() => setEditing(true)}
            >
              <IconEdit width={11} height={11} />
            </IconAction>
          ) : null}
          {canDelete ? (
            <IconAction
              tip={status === "pushed" ? "Delete; also from your pending review on GitHub" : "Delete"}
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
      {forAgent && comment.pickedUp ? (
        <div className="text-[11px]" style={{ color: "var(--fg-muted)" }} title={formatFullTimestamp(comment.pickedUp.at)}>
          Picked up by {comment.pickedUp.by} · {(() => {
            const age = formatCompactAge(Math.max(0, Date.now() - Date.parse(comment.pickedUp.at)));
            return age === "just now" ? age : `${age} ago`;
          })()}
        </div>
      ) : null}
      <CommentBody
        comment={comment}
        edit={onEdit}
        markdown
        clamp={clamp}
        bodyClass="text-[13px] leading-[20px]"
        editing={editing}
        onEditingChange={setEditing}
        suggestion={suggestion}
      />
      <AgentEditNote comment={comment} onUndo={onUndoEdit} busy={undoing} />
      {confirmPublish || publishing ? (
        <div
          className="mt-1.5 flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-2xs"
          style={{ background: "var(--accent-soft)", color: "var(--fg)" }}
          data-testid={`confirm-publish-${comment.id}`}
        >
          {publishing ? (
            <span className="min-w-0 flex-1 animate-pulse">Posting on GitHub…</span>
          ) : (
            <>
              <span className="min-w-0 flex-1">Post it on GitHub now? It is public at once, outside any review.</span>
              <button type="button" className="btn" onClick={() => setConfirmPublish(false)}>
                keep
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid={`publish-inline-${comment.id}`}
                onClick={() => onPublish?.(comment)}
              >
                publish
              </button>
            </>
          )}
        </div>
      ) : null}
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
      {actionError ? (
        <p
          className="mt-1.5 text-2xs leading-4"
          role="alert"
          data-testid={`comment-error-${comment.id}`}
          style={{ color: "var(--risk)" }}
        >
          {actionError}
        </p>
      ) : null}
    </article>
    </SuggestionContext.Provider>
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
      data-tip={`${n === 1 ? "This image is" : "These images are"} only on this machine; uploaded to GitHub when the comment is pushed`}
    >
      {n} {n === 1 ? "image" : "images"}
    </span>
  );
}

function IconAction({
  tip,
  testId,
  onClick,
  disabled,
  danger,
  children,
}: {
  tip: string;
  testId?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-tip={tip}
      aria-label={tip}
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
  if (look === "agent") return AGENT_LOOK;
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
  onHoverChange,
}: {
  marker: MarkerSummary;
  expanded: boolean;
  onToggle: () => void;
  /** the diff gutter variant (hover follows the line, not the icon) */
  compact?: boolean;
  title: string;
  /** the pointer is over the marker (the diff lights up a multi-line comment's lines) */
  onHoverChange?: (hovering: boolean) => void;
}) {
  const { look, count, resolved } = marker;
  const meta = markerLook(look);
  // Outlined while it has gone nowhere (a draft, a note for an agent).
  const Icon = look === "draft" || look === "agent" ? IconComment : IconCommentFilled;
  return (
    <button
      type="button"
      data-testid="comment-bubble"
      data-status={look}
      data-count={count}
      data-resolved={resolved ? "true" : undefined}
      data-expanded={expanded ? "true" : "false"}
      aria-expanded={expanded}
      data-tip={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
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
