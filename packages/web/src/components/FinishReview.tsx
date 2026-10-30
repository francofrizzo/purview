import { useEffect, useRef, useState } from "react";
import type {
  FilesJson,
  ReanchorProposal,
  ReviewEvent,
  ReviewStatus,
  SubmitReviewResult,
  RemoteThread,
} from "../api/types";
import { errorText } from "../api/errors";
import { isCommentAnchored } from "../lib/comments";
import type { BundleSource } from "./CopyForAgent";
import { CopyBundleControls } from "./CopyForAgent";
import { commentAnchorLabel, type EditComment } from "./Drafts";
import { CommentCard } from "./CommentCard";
import { ReviewerVerdictList } from "./Reviews";
import { SavedFlash, useFlash } from "./SavedFlash";
import type { ReviewerVerdict } from "../lib/reviews";
import { IconCheck, IconExternal, IconSpinner, IconWarning } from "./icons";

const EVENTS: { event: ReviewEvent; label: string; tone: string; blurb: string }[] = [
  {
    event: "COMMENT",
    label: "Comment",
    tone: "var(--accent)",
    blurb: "Feedback without a verdict.",
  },
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
];

/**
 * The finish-review flow: where the review stands, what goes out, then one
 * decision. Picking a verdict only selects it; the one submit button says what
 * it will post. A confirm step stands in the way only when there is something
 * to weigh (must-read units still unread), since submitting is public and
 * cannot be undone.
 */
export function FinishReviewPanel({
  review,
  loading,
  error,
  submitting,
  discarding,
  result,
  submitError,
  onSaveBody,
  saveBodyError,
  onSubmit,
  onDiscardPending,
  onJumpToComment,
  onEditComment,
  onDeleteComments,
  bundle,
  files,
  onProposeReanchor,
  onApplyReanchor,
  verdicts = [],
  threads,
  onJumpToThread,
  unresolvedThreads = 0,
}: {
  review?: ReviewStatus;
  /** each reviewer's standing verdict on GitHub, yours included */
  verdicts?: ReviewerVerdict[];
  /** the PR's review threads, so a verdict can lead to its inline comments */
  threads?: RemoteThread[];
  onJumpToThread?: (thread: RemoteThread) => void;
  /** review threads on GitHub nobody has resolved yet */
  unresolvedThreads?: number;
  loading: boolean;
  error?: Error | null;
  submitting: boolean;
  discarding: boolean;
  result?: SubmitReviewResult | null;
  submitError?: Error | null;
  /** save the summary; resolves when it is on disk, rejects when refused */
  onSaveBody: (body: string) => Promise<unknown>;
  saveBodyError?: unknown;
  onSubmit: (event: ReviewEvent, body: string) => void;
  onDiscardPending: () => void;
  onJumpToComment: (file: string, line: number | null) => void;
  onEditComment?: EditComment;
  /** bulk delete, for "copy & delete"; omit to offer only the plain copy */
  onDeleteComments?: (ids: string[]) => Promise<unknown>;
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
  // What the server last took, so a blur without an edit saves (and flashes) nothing.
  const savedBody = useRef<string | null>(null);
  const [savedFlash, flashSaved] = useFlash();
  const [arming, setArming] = useState<ReviewEvent | null>(null);
  const [verdict, setVerdict] = useState<ReviewEvent>("COMMENT");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Seed from the server draft once it arrives; never clobber in-flight typing.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && review) {
      setBody(review.body ?? "");
      savedBody.current = review.body ?? "";
      setSeeded(true);
    }
  }, [review, seeded]);

  // A submitted review took its summary with it (the server clears the
  // saved copy too), so the box starts empty for the next one.
  useEffect(() => {
    if (result) {
      setBody("");
      setArming(null);
    }
  }, [result]);

  const readiness = review?.readiness;
  const unviewed = readiness?.mustRead.unviewed ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="finish-review-panel">
      {loading ? (
        <p className="p-4 text-xs" style={{ color: "var(--fg-faint)" }}>
          Loading review state…
        </p>
      ) : error ? (
        <Notice tone="error">Could not load the review: {error.message}</Notice>
      ) : !review ? null : (
        <>
          <div className="quiet-scroll min-h-0 flex-1 overflow-auto">
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
              {verdicts.length || unresolvedThreads ? (
                <section data-testid="previous-reviews">
                  <SectionTitle>On GitHub so far</SectionTitle>
                  {verdicts.length ? (
                    <ReviewerVerdictList verdicts={verdicts} threads={threads ?? []} onJumpToThread={onJumpToThread ?? (() => {})} />
                  ) : null}
                  {unresolvedThreads ? (
                    <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                      {unresolvedThreads} unresolved {unresolvedThreads === 1 ? "thread" : "threads"}
                    </p>
                  ) : null}
                </section>
              ) : null}

              <section>
                <SectionTitle>Summary</SectionTitle>
                <textarea
                  className="input mt-1.5 h-28 resize-none text-xs leading-5"
                  placeholder="What should the author take away? (optional)"
                  data-tip="Kept on this machine until you submit"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onBlur={() => {
                    if (body === savedBody.current) return;
                    onSaveBody(body).then(
                      () => {
                        savedBody.current = body;
                        flashSaved();
                      },
                      // Reported through `saveBodyError`; nothing to throw past the blur.
                      () => {},
                    );
                  }}
                />
                {/* No standing hint (it is on the field's tooltip): the line
                    is there only while "saved" flashes or a save was refused. */}
                {savedFlash || saveBodyError ? (
                  <p className="mt-1 flex items-center gap-2">
                    <SavedFlash shown={savedFlash} error={saveBodyError} />
                  </p>
                ) : null}
              </section>

              <IncludedComments
                review={review}
                onJump={onJumpToComment}
                onEdit={onEditComment}
                onDeleteCopied={onDeleteComments}
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
                // The step stays up while the request runs, so "submitting…"
                // has somewhere to show; it leaves once the result is in.
                onConfirm={() => onSubmit(arming, body)}
              />
            ) : (
              <div className="flex flex-col gap-2">
                {/* The verdict is a choice, not three buttons that each post:
                    three equal segments on one track, so none runs to the
                    edge; at the panel's narrowest a label wraps inside its
                    own segment rather than overflow. */}
                <div
                  role="radiogroup"
                  aria-label="Verdict"
                  className="grid grid-cols-3 gap-0.5 rounded-md border p-0.5"
                  style={{ background: "var(--bg-inset)", borderColor: "var(--border)" }}
                >
                  {EVENTS.map((e) => {
                    const on = e.event === verdict;
                    return (
                      <button
                        key={e.event}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        data-testid={`verdict-${e.event.toLowerCase()}`}
                        data-tip={e.blurb}
                        disabled={submitting}
                        onClick={() => setVerdict(e.event)}
                        className="flex min-w-0 items-center justify-center gap-1.5 rounded px-1.5 py-1 text-center text-xs leading-4 transition-colors hover:text-[var(--fg)]"
                        style={
                          on
                            ? { background: "var(--bg-raised)", color: "var(--fg)", boxShadow: "0 0 0 1px var(--border)" }
                            : { color: "var(--fg-muted)" }
                        }
                      >
                        <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: e.tone }} />
                        {e.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="btn w-full justify-center font-semibold hover:brightness-110"
                  style={verdictFill(verdict)}
                  data-testid="submit-review"
                  disabled={submitting}
                  onClick={() => (unviewed > 0 ? setArming(verdict) : onSubmit(verdict, body))}
                >
                  {submitting
                    ? "submitting…"
                    : `Submit review${
                        review.included.length
                          ? ` · ${review.included.length} ${review.included.length === 1 ? "comment" : "comments"}`
                          : ""
                      }`}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-medium" style={{ color: "var(--fg-muted)" }}>
      {children}
    </div>
  );
}

/** The submit button's solid fill: the picked verdict's own color, page-colored text. */
function verdictFill(event: ReviewEvent): React.CSSProperties {
  const tone = EVENTS.find((e) => e.event === event)?.tone ?? "var(--accent)";
  return { background: tone, borderColor: tone, color: "var(--bg)" };
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
        {viewed}/{total} hunks read
        {readiness.changedSinceViewed > 0
          ? ` · ${readiness.changedSinceViewed} changed since you read them`
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
          className="btn ml-auto font-semibold hover:brightness-110"
          style={verdictFill(event)}
          onClick={onConfirm}
          disabled={submitting}
        >
          {submitting ? (
            <span className="inline-flex items-center gap-1.5" data-testid="finish-review-submitting">
              <IconSpinner width={11} height={11} />
              submitting…
            </span>
          ) : (
            `yes, ${labelFor(event).toLowerCase()}`
          )}
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
  onDeleteCopied,
  bundle,
  reviewBody,
  files,
  onProposeReanchor,
  onApplyReanchor,
}: {
  review: ReviewStatus;
  onJump: (file: string, line: number | null) => void;
  onEdit?: EditComment;
  onDeleteCopied?: (ids: string[]) => Promise<unknown>;
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
          onDeleteCopied={onDeleteCopied}
        />
      ) : null}
      {review.included.length === 0 ? (
        <p className="mt-1 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
          No inline comments; only the summary goes out.
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {review.included.map((c) => {
            const outside =
              !!files && c.status === "draft" && c.subjectType !== "file" && !isCommentAnchored(files, c);
            return (
              <li key={c.id}>
                <CommentCard
                  comment={c}
                  clamp
                  anchor={{ label: commentAnchorLabel(c), onJump: () => onJump(c.file, c.line) }}
                  actions={{
                    onEdit,
                    onDelete: onDeleteCopied ? (comment) => void onDeleteCopied([comment.id]) : undefined,
                  }}
                  notice={
                    outside ? (
                      <OutsideDiffNotice
                        id={c.id}
                        onProposeReanchor={onProposeReanchor}
                        onApplyReanchor={onApplyReanchor}
                      />
                    ) : null
                  }
                />
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
