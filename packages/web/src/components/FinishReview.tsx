import { useEffect, useState } from "react";
import type { ReviewEvent, ReviewStatus, SubmitReviewResult } from "../api/types";
import { CommentBody, type EditComment } from "./Drafts";

const EVENTS: { event: ReviewEvent; label: string; tone: string; blurb: string }[] = [
  {
    event: "APPROVE",
    label: "Approve",
    tone: "var(--ok)",
    blurb: "Sign off on the change.",
  },
  {
    event: "REQUEST_CHANGES",
    label: "Request changes",
    tone: "var(--risk)",
    blurb: "Block the merge until the comments are addressed.",
  },
  {
    event: "COMMENT",
    label: "Comment",
    tone: "var(--accent)",
    blurb: "Leave feedback without a verdict.",
  },
];

/**
 * The finish-review flow. Two deliberate frictions, because submitting posts
 * publicly and cannot be undone:
 *   1. picking a verdict never fires the request — it only arms the confirm
 *      step, which restates what is about to happen;
 *   2. the readiness summary is shown next to the buttons, so "2 must-read
 *      units still unviewed" is in view at the moment of decision rather than
 *      buried in a sidebar.
 */
export function FinishReviewPanel({
  review,
  loading,
  error,
  submitting,
  discarding,
  result,
  submitError,
  onClose,
  onSaveBody,
  onSubmit,
  onDiscardPending,
  onJumpToComment,
  onEditComment,
}: {
  review?: ReviewStatus;
  loading: boolean;
  error?: Error | null;
  submitting: boolean;
  discarding: boolean;
  result?: SubmitReviewResult | null;
  submitError?: Error | null;
  onClose: () => void;
  onSaveBody: (body: string) => void;
  onSubmit: (event: ReviewEvent, body: string) => void;
  onDiscardPending: () => void;
  onJumpToComment: (file: string, line: number) => void;
  onEditComment?: EditComment;
}) {
  const [body, setBody] = useState("");
  const [arming, setArming] = useState<ReviewEvent | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Seed from the server draft once it arrives; never clobber in-flight typing.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && review) {
      setBody(review.body ?? "");
      setSeeded(true);
    }
  }, [review, seeded]);

  const readiness = review?.readiness;
  const unviewed = readiness?.mustRead.unviewed ?? 0;

  return (
    <aside
      className="flex w-[26rem] flex-none flex-col border-l"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div
        className="flex flex-none items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="text-xs font-semibold">Finish review</span>
        <button
          type="button"
          className="ml-auto text-xs"
          onClick={onClose}
          style={{ color: "var(--fg-faint)" }}
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="p-3 text-xs" style={{ color: "var(--fg-faint)" }}>
            Loading review state…
          </p>
        ) : error ? (
          <Notice tone="error">Could not load the review: {error.message}</Notice>
        ) : !review ? null : (
          <>
            {result ? (
              <Notice tone="ok">
                <div className="font-semibold">
                  Review submitted ({labelFor(result.event)}) with {result.commentCount}{" "}
                  {result.commentCount === 1 ? "comment" : "comments"}.
                </div>
                {result.url ? (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                    style={{ color: "var(--accent)" }}
                  >
                    View it on GitHub →
                  </a>
                ) : null}
              </Notice>
            ) : null}

            {submitError ? <Notice tone="error">{submitError.message}</Notice> : null}

            <PendingBanner
              review={review}
              discarding={discarding}
              confirming={confirmingDiscard}
              onAsk={() => setConfirmingDiscard(true)}
              onCancel={() => setConfirmingDiscard(false)}
              onConfirm={() => {
                setConfirmingDiscard(false);
                onDiscardPending();
              }}
            />

            {readiness ? (
              <div className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
                <div className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
                  readiness
                </div>
                <p
                  className="mt-1 text-xs leading-5"
                  style={{ color: unviewed > 0 ? "var(--warn)" : "var(--fg-muted)" }}
                >
                  {unviewed > 0
                    ? `${unviewed} must-read ${unviewed === 1 ? "unit is" : "units are"} still unviewed.`
                    : "Every must-read unit has been read."}
                </p>
                <p className="mt-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {readiness.hunks.viewed}/{readiness.hunks.total} hunks ·{" "}
                  {readiness.units.complete}/{readiness.units.total} units
                  {readiness.changedSinceViewed > 0
                    ? ` · ${readiness.changedSinceViewed} changed since viewed`
                    : ""}
                </p>
              </div>
            ) : null}

            <div className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
              <label
                className="text-2xs uppercase tracking-wider"
                style={{ color: "var(--fg-faint)" }}
              >
                review body
              </label>
              <textarea
                className="input mt-1 h-28 resize-none text-xs"
                placeholder="Summary of your review (optional)…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onBlur={() => onSaveBody(body)}
              />
              <p className="mt-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
                Saved locally when you click away.
              </p>
            </div>

            <IncludedComments review={review} onJump={onJumpToComment} onEdit={onEditComment} />

            <div className="px-3 py-3">
              {arming ? (
                <ConfirmStep
                  event={arming}
                  commentCount={review.included.length}
                  unviewed={unviewed}
                  submitting={submitting}
                  onCancel={() => setArming(null)}
                  onConfirm={() => {
                    const chosen = arming;
                    setArming(null);
                    onSubmit(chosen, body);
                  }}
                />
              ) : (
                <>
                  <div
                    className="mb-2 text-2xs uppercase tracking-wider"
                    style={{ color: "var(--fg-faint)" }}
                  >
                    submit as
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {EVENTS.map((e) => (
                      <button
                        key={e.event}
                        type="button"
                        className="btn w-full justify-start text-left"
                        style={{ color: e.tone }}
                        disabled={submitting}
                        title={`${e.label} — ${e.blurb}`}
                        onClick={() => setArming(e.event)}
                      >
                        {/* fixed label column + single-line blurb: without them
                            "Request changes" wraps, and the three rows go ragged */}
                        <span className="w-[7rem] flex-none whitespace-nowrap">{e.label}</span>
                        <span
                          className="min-w-0 flex-1 truncate text-2xs"
                          style={{ color: "var(--fg-faint)" }}
                        >
                          {e.blurb}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function labelFor(event: ReviewEvent): string {
  return EVENTS.find((e) => e.event === event)?.label ?? event;
}

function ConfirmStep({
  event,
  commentCount,
  unviewed,
  submitting,
  onCancel,
  onConfirm,
}: {
  event: ReviewEvent;
  commentCount: number;
  unviewed: number;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="rounded-md border p-2.5"
      style={{ borderColor: "var(--warn)", background: "var(--warn-soft)" }}
    >
      <div className="text-xs font-semibold" style={{ color: "var(--warn)" }}>
        Submit “{labelFor(event)}” to GitHub?
      </div>
      <p className="mt-1 text-xs leading-5" style={{ color: "var(--fg-muted)" }}>
        This posts publicly and cannot be undone. {commentCount}{" "}
        {commentCount === 1 ? "comment goes" : "comments go"} out with it.
        {unviewed > 0
          ? ` ${unviewed} must-read ${unviewed === 1 ? "unit is" : "units are"} still unviewed.`
          : ""}
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
          cancel
        </button>
        <button
          type="button"
          className="btn btn-primary ml-auto"
          onClick={onConfirm}
          disabled={submitting}
        >
          {submitting ? "submitting…" : `yes, ${labelFor(event).toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}

function PendingBanner({
  review,
  discarding,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  review: ReviewStatus;
  discarding: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!review.pending.known) {
    return (
      <Notice tone="warn">
        Could not reach GitHub to check for a pending review
        {review.pending.error ? `: ${review.pending.error}` : "."}
      </Notice>
    );
  }
  if (!review.pending.exists) return null;
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
      <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
        You have a <strong>pending review</strong> on GitHub holding{" "}
        {review.counts.pushed} pushed {review.counts.pushed === 1 ? "comment" : "comments"}. It is
        private until you submit.
      </div>
      {confirming ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-2xs" style={{ color: "var(--warn)" }}>
            Discard it? Comments return to local drafts.
          </span>
          <button type="button" className="btn ml-auto" onClick={onCancel}>
            cancel
          </button>
          <button type="button" className="btn" onClick={onConfirm} disabled={discarding}>
            {discarding ? "discarding…" : "discard"}
          </button>
        </div>
      ) : (
        <button type="button" className="btn mt-1.5" onClick={onAsk} disabled={discarding}>
          discard pending review
        </button>
      )}
    </div>
  );
}

function IncludedComments({
  review,
  onJump,
  onEdit,
}: {
  review: ReviewStatus;
  onJump: (file: string, line: number) => void;
  onEdit?: EditComment;
}) {
  return (
    <div className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="px-3 pt-2 text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
        comments in this review ({review.included.length})
        {review.counts.submitted > 0 ? (
          <span className="ml-1 normal-case tracking-normal">
            · {review.counts.submitted} already submitted
          </span>
        ) : null}
      </div>
      {review.included.length === 0 ? (
        <p className="px-3 py-2 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
          No comments — the review will carry only the body above.
        </p>
      ) : (
        <ul className="py-1">
          {review.included.map((c) => (
            <li key={c.id} className="px-3 py-1.5">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 text-left font-mono text-2xs"
                style={{ color: "var(--fg-muted)" }}
                onClick={() => onJump(c.file, c.line)}
                title="Jump to this file"
              >
                <span className="truncate">{c.file}</span>
                <span style={{ color: "var(--fg-faint)" }}>:{c.line}</span>
                <StatusChip status={c.status} />
              </button>
              <CommentBody comment={c} edit={onEdit} clamp />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StatusChip({ status }: { status: "draft" | "pushed" | "submitted" }) {
  const meta = {
    draft: { label: "draft", fg: "var(--fg-faint)", bg: "var(--bg-inset)" },
    pushed: { label: "pushed", fg: "var(--accent)", bg: "var(--accent-soft)" },
    submitted: { label: "submitted", fg: "var(--fg-muted)", bg: "var(--bg-inset)" },
  }[status];
  return (
    <span className="chip ml-auto" style={{ background: meta.bg, color: meta.fg }}>
      {meta.label}
    </span>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "error";
  children: React.ReactNode;
}) {
  const fg =
    tone === "error" ? "var(--risk)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  const bg =
    tone === "error"
      ? "var(--risk-soft)"
      : tone === "warn"
        ? "var(--warn-soft)"
        : "var(--accent-soft)";
  return (
    <div
      className="border-b px-3 py-2 text-xs leading-5"
      style={{ background: bg, color: fg, borderColor: "var(--border)" }}
    >
      {children}
    </div>
  );
}
