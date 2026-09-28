import { useEffect, useState } from "react";
import type {
  FilesJson,
  ReanchorProposal,
  ReviewEvent,
  ReviewStatus,
  SubmitReviewResult,
} from "../api/types";
import { errorText } from "../api/errors";
import { isCommentAnchored } from "../lib/comments";
import type { BundleSource } from "./CopyForAgent";
import { CopyBundleControls } from "./CopyForAgent";
import { CommentBody, type EditComment } from "./Drafts";
import { IconCheck, IconClose, IconExternal, IconWarning } from "./icons";

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
  bundle,
  files,
  onProposeReanchor,
  onApplyReanchor,
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
  onJumpToComment: (file: string, line: number | null) => void;
  onEditComment?: EditComment;
  /** diff + PR identity for the agent-facing copy; omit to hide the action */
  bundle?: Omit<BundleSource, "comments" | "reviewBody">;
  /** the current diff, used to flag drafts that fell outside it — omit to skip the check */
  files?: FilesJson;
  /** "Suggest new anchor" — resolves to the model's proposal, never applies it */
  onProposeReanchor?: (id: string) => Promise<ReanchorProposal>;
  /** accept a proposal (or a manual reposition) */
  onApplyReanchor?: (id: string, target: { file: string; line: number }) => Promise<void>;
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
        className="flex flex-none items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="text-[13px] font-semibold">Finish review</span>
        <button
          type="button"
          className="ml-auto rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
          aria-label="Close"
          onClick={onClose}
          style={{ color: "var(--fg-faint)" }}
        >
          <IconClose width={11} height={11} />
        </button>
      </div>

      {loading ? (
        <p className="p-4 text-xs" style={{ color: "var(--fg-faint)" }}>
          Loading review state…
        </p>
      ) : error ? (
        <Notice tone="error">Could not load the review: {error.message}</Notice>
      ) : !review ? null : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            {result ? <SubmittedNotice result={result} /> : null}
            {submitError ? <Notice tone="error">{errorText(submitError)}</Notice> : null}

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

            <div className="flex flex-col gap-5 px-4 py-4">
              {readiness ? <Readiness readiness={readiness} /> : null}

              <section>
                <SectionTitle>Summary</SectionTitle>
                <textarea
                  className="input mt-1.5 h-28 resize-none text-xs leading-5"
                  placeholder="What should the author take away? (optional)"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onBlur={() => onSaveBody(body)}
                />
                <p className="mt-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
                  Saved locally when you click away.
                </p>
              </section>

              <IncludedComments
                review={review}
                onJump={onJumpToComment}
                onEdit={onEditComment}
                bundle={bundle}
                reviewBody={body}
                files={files}
                onProposeReanchor={onProposeReanchor}
                onApplyReanchor={onApplyReanchor}
              />
            </div>
          </div>

          {/* The decision stays in view however long the comment list gets. */}
          <div
            className="flex-none border-t px-4 py-3"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
          >
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
                <SectionTitle>Submit as</SectionTitle>
                <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                  {EVENTS.map((e) => (
                    <button
                      key={e.event}
                      type="button"
                      className="btn justify-center whitespace-nowrap px-2"
                      style={{ color: e.tone }}
                      disabled={submitting}
                      title={e.blurb}
                      onClick={() => setArming(e.event)}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-medium" style={{ color: "var(--fg-muted)" }}>
      {children}
    </div>
  );
}

/** Where the review stands, stated first: the thing to weigh before a verdict. */
function Readiness({ readiness }: { readiness: NonNullable<ReviewStatus["readiness"]> }) {
  const unviewed = readiness.mustRead.unviewed;
  const { viewed, total } = readiness.hunks;
  const pct = total ? Math.round((viewed / total) * 100) : 0;
  const tone = unviewed > 0 ? "var(--warn)" : "var(--ok)";
  return (
    <section data-testid="review-readiness">
      <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: tone }}>
        {unviewed > 0 ? (
          <IconWarning width={12} height={12} />
        ) : (
          <IconCheck width={12} height={12} />
        )}
        {unviewed > 0
          ? `${unviewed} must-read ${unviewed === 1 ? "unit is" : "units are"} still unviewed`
          : "Every must-read unit has been read"}
      </div>
      <div
        className="mt-2 h-1 overflow-hidden rounded-full"
        style={{ background: "var(--bg-inset)" }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: viewed === total ? "var(--ok)" : "var(--accent)" }}
        />
      </div>
      <p className="mt-1.5 text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
        {viewed}/{total} hunks · {readiness.units.complete}/{readiness.units.total} units
        {readiness.changedSinceViewed > 0
          ? ` · ${readiness.changedSinceViewed} changed since viewed`
          : ""}
      </p>
    </section>
  );
}

const SUBMITTED_AS: Record<ReviewEvent, string> = {
  APPROVE: "Approved",
  REQUEST_CHANGES: "Changes requested",
  COMMENT: "Commented",
};

function SubmittedNotice({ result }: { result: SubmitReviewResult }) {
  const n = result.commentCount;
  return (
    <div
      className="flex items-center gap-2 border-b px-4 py-2.5 text-xs"
      style={{ background: "var(--ok-soft)", borderColor: "var(--border)", color: "var(--ok)" }}
    >
      <IconCheck width={12} height={12} className="flex-none" />
      <span className="font-medium">
        {SUBMITTED_AS[result.event] ?? labelFor(result.event)} on GitHub
      </span>
      <span style={{ color: "var(--fg-muted)" }}>
        {n === 0 ? "no comments" : `${n} ${n === 1 ? "comment" : "comments"}`}
      </span>
      {result.url ? (
        <a
          href={result.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex flex-none items-center gap-1 hover:underline"
          style={{ color: "var(--accent)" }}
        >
          view <IconExternal width={10} height={10} />
        </a>
      ) : null}
    </div>
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
    <div className="border-b px-4 py-2.5" style={{ borderColor: "var(--border)" }}>
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
  bundle,
  reviewBody,
  files,
  onProposeReanchor,
  onApplyReanchor,
}: {
  review: ReviewStatus;
  onJump: (file: string, line: number | null) => void;
  onEdit?: EditComment;
  bundle?: Omit<BundleSource, "comments" | "reviewBody">;
  /** the live textarea contents, so the copy matches what is on screen */
  reviewBody?: string;
  files?: FilesJson;
  onProposeReanchor?: (id: string) => Promise<ReanchorProposal>;
  onApplyReanchor?: (id: string, target: { file: string; line: number }) => Promise<void>;
}) {
  const n = review.included.length;
  return (
    <section>
      <div className="flex items-center gap-2">
        <SectionTitle>Comments</SectionTitle>
        <span className="text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
          {n}
          {review.counts.submitted > 0 ? ` · ${review.counts.submitted} already submitted` : ""}
        </span>
      </div>
      {bundle && n > 0 ? (
        <CopyBundleControls
          testId="copy-bundle-review"
          className="mt-1.5"
          source={{ ...bundle, comments: review.included, reviewBody }}
        />
      ) : null}
      {review.included.length === 0 ? (
        <p className="mt-1 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
          No inline comments; only the summary goes out.
        </p>
      ) : (
        <ul className="-mx-4 mt-1">
          {review.included.map((c) => {
            const outside =
              !!files && c.status === "draft" && c.subjectType !== "file" && !isCommentAnchored(files, c);
            return (
              <li key={c.id} className="px-4 py-1.5">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 text-left font-mono text-2xs"
                  style={{ color: "var(--fg-muted)" }}
                  onClick={() => onJump(c.file, c.line)}
                  title="Jump to this file"
                >
                  <span className="truncate">{c.file}</span>
                  <span className="flex-none" style={{ color: "var(--fg-faint)" }}>
                    {c.line === null || c.subjectType === "file" ? "(file)" : `:${c.line}`}
                  </span>
                  <StatusChip status={c.status} />
                </button>
                {outside ? (
                  <OutsideDiffNotice
                    id={c.id}
                    onProposeReanchor={onProposeReanchor}
                    onApplyReanchor={onApplyReanchor}
                  />
                ) : null}
                <CommentBody comment={c} edit={onEdit} clamp />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * A draft that no longer anchors into the current diff — the exact "PR
 * revision moved, hunk slid outside every hunk we can see" scenario this
 * whole feature exists for. The warning chip is always shown; the propose
 * flow only lights up when the caller wired it in (PrView does, tests may
 * not need to).
 */
function OutsideDiffNotice({
  id,
  onProposeReanchor,
  onApplyReanchor,
}: {
  id: string;
  onProposeReanchor?: (id: string) => Promise<ReanchorProposal>;
  onApplyReanchor?: (id: string, target: { file: string; line: number }) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ReanchorProposal | null>(null);
  const [applying, setApplying] = useState(false);

  const suggest = async () => {
    if (!onProposeReanchor) return;
    setLoading(true);
    setError(null);
    try {
      setProposal(await onProposeReanchor(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!onApplyReanchor || !proposal?.applicable || proposal.file === undefined || proposal.line === undefined) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await onApplyReanchor(id, { file: proposal.file, line: proposal.line });
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="chip" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
          outside current diff
        </span>
        {onProposeReanchor && !proposal ? (
          <button type="button" className="btn text-2xs" disabled={loading} onClick={() => void suggest()}>
            {loading ? "thinking…" : "Suggest new anchor"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="text-2xs" style={{ color: "var(--risk)" }}>
          {error}
        </p>
      ) : null}
      {proposal ? (
        <div
          className="rounded-md border px-2 py-1.5 text-2xs leading-5"
          style={{ borderColor: "var(--border)", background: "var(--bg-inset)" }}
        >
          {proposal.applicable ? (
            <>
              <div style={{ color: "var(--fg-muted)" }}>
                Move to <span className="font-mono">{proposal.file}:{proposal.line}</span>
              </div>
              {proposal.reason ? (
                <div style={{ color: "var(--fg-faint)" }}>{proposal.reason}</div>
              ) : null}
              <div className="mt-1 flex items-center gap-1.5">
                <button
                  type="button"
                  className="btn text-2xs"
                  onClick={() => setProposal(null)}
                  disabled={applying}
                >
                  dismiss
                </button>
                {onApplyReanchor ? (
                  <button
                    type="button"
                    className="btn btn-primary text-2xs"
                    onClick={() => void apply()}
                    disabled={applying}
                  >
                    {applying ? "applying…" : "apply"}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div style={{ color: "var(--fg-faint)" }}>
                {proposal.reason || "Not applicable — no safe anchor found."}
              </div>
              <button
                type="button"
                className="btn mt-1 text-2xs"
                onClick={() => setProposal(null)}
              >
                dismiss
              </button>
            </>
          )}
        </div>
      ) : null}
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
      className="border-b px-4 py-2.5 text-xs leading-5"
      style={{ background: bg, color: fg, borderColor: "var(--border)" }}
    >
      {children}
    </div>
  );
}
