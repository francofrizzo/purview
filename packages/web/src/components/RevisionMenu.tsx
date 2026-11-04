import { useCallback, useEffect, useRef, useState } from "react";
import { FloatingPanel } from "./FloatingPanel";
import type { PrState } from "../api/types";
import { formatAddedAt, formatFullTimestamp } from "../lib/prList";
import { discardAvailability, discardConfirmText } from "../lib/revisionDiscard";
import { formatRevisionSummary, revisionSummaryLines } from "../lib/revisionSummary";
import { UiText } from "./UiText";

/**
 * The header's "rev N": opens a small popover saying which head the revision
 * is and when it was fetched, with the one thing to do about a bad one —
 * discard it (a refresh that caught the author mid-rebase). Two clicks: the
 * first spells out what goes, the second does it. On success the PR falls
 * back a revision, which closes the popover.
 */
export function RevisionMenu({
  state,
  analysisLive,
  discarding,
  error,
  onDiscard,
  onResetError,
  highlightRevisions = [],
  onToggleHighlight,
  highlightAvailable = true,
}: {
  state: Pick<PrState, "revision" | "revisions" | "baseOnly">;
  /** revisions whose changed lines are lit up in the diff (the changelog highlight) */
  highlightRevisions?: readonly number[];
  /** light up (or clear) one revision's changes; absent hides the rows */
  onToggleHighlight?: (revision: number) => void;
  /** the highlight shows on the review-units tab only */
  highlightAvailable?: boolean;
  analysisLive: boolean;
  discarding: boolean;
  /** the server's refusal, shown inline */
  error: string | null;
  onDiscard: (revision: number) => void;
  onResetError: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const info = state.revisions?.find((r) => r.revision === state.revision);
  const { previous, blockedWhy } = discardAvailability(state, analysisLive);
  // Every revision past the first, newest first: a highlight button each
  // (when the caller offers it) and, under it, what the revision changed.
  const later = [...(state.revisions ?? [])].filter((r) => r.revision > 1).sort((a, b) => b.revision - a.revision);
  const summaryOf = (revision: number) =>
    revisionSummaryLines(state.revisions).find((l) => l.revision === revision)?.summary;

  // Opening (or closing) starts over; so does landing on another revision,
  // which is also how a successful discard closes the popover.
  useEffect(() => {
    setConfirming(false);
  }, [open]);
  useEffect(() => {
    setOpen(false);
  }, [state.revision]);

  const close = useCallback(() => setOpen(false), []);
  const toggle = () => {
    if (!open) onResetError();
    setOpen((v) => !v);
  };

  return (
    <span ref={wrapRef} className="relative inline-flex flex-none">
      <button
        type="button"
        data-testid="revision-menu"
        aria-expanded={open}
        data-tip="Revision details"
        onClick={toggle}
        className="-mx-1 rounded px-1 text-2xs transition-colors hover:bg-[var(--bg-hover)]"
        style={{ color: open ? "var(--fg)" : "var(--fg-faint)" }}
      >
        <UiText>{`rev ${state.revision}${state.baseOnly ? " (base only)" : ""}`}</UiText>
      </button>
      {open ? (
        <FloatingPanel
          anchorRef={wrapRef}
          onClose={close}
          label={`Revision ${state.revision}`}
          className="w-[26rem] p-2.5 text-xs"
        >
          <div style={{ color: "var(--fg)" }}>
            <UiText>{`Revision ${state.revision}`}</UiText>
            {state.baseOnly ? <span style={{ color: "var(--fg-faint)" }}><UiText>{" · base moved only"}</UiText></span> : null}
          </div>
          {info?.headSha || info?.addedAt ? (
            <div className="mt-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
              {info.headSha ? (
                <>
                  <UiText>head</UiText> <span className="font-mono">{info.headSha.slice(0, 10)}</span>
                </>
              ) : null}
              {info.headSha && info.addedAt ? <UiText>{" · "}</UiText> : null}
              {info.addedAt ? (
                <span data-tip={formatFullTimestamp(info.addedAt)}><UiText>{`fetched ${formatAddedAt(info.addedAt)}`}</UiText></span>
              ) : null}
            </div>
          ) : null}

          {later.length > 0 && (onToggleHighlight || later.some((r) => summaryOf(r.revision))) ? (
            <div className="mt-2.5 border-t pt-2" style={{ borderColor: "var(--border)" }}>
              <div className="mb-1.5 text-2xs" style={{ color: "var(--fg-muted)" }}>
                <UiText>{onToggleHighlight ? "Show what changed in" : "What each revision changed"}</UiText>
              </div>
              <ul className="space-y-1.5">
                {later.map((r) => {
                  const on = highlightRevisions.includes(r.revision);
                  const summary = summaryOf(r.revision);
                  return (
                    <li key={r.revision} data-testid={`revision-row-${r.revision}`}>
                      <span className="flex items-center gap-1.5">
                      {onToggleHighlight ? (
                        <button
                          type="button"
                          className="btn"
                          data-testid={`highlight-revision-${r.revision}`}
                          aria-pressed={on}
                          disabled={!highlightAvailable}
                          data-tip={
                            !highlightAvailable
                              ? "Shown on the guide tab"
                              : on
                                ? `Stop showing what revision ${r.revision} changed`
                                : `Light up the lines revision ${r.revision} changed`
                          }
                          style={on ? { color: "var(--accent)", borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
                          onClick={() => onToggleHighlight(r.revision)}
                        >
                          <UiText>{`r${r.revision}`}</UiText>
                        </button>
                      ) : (
                        <span className="text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
                          <UiText>{`r${r.revision}`}</UiText>
                        </span>
                      )}
                      {r.addedAt ? (
                        <span
                          className="text-2xs"
                          style={{ color: "var(--fg-faint)" }}
                          data-testid={`revision-when-${r.revision}`}
                          data-tip={formatFullTimestamp(r.addedAt)}
                        >
                          <UiText>{formatAddedAt(r.addedAt)}</UiText>
                        </span>
                      ) : null}
                      </span>
                      {summary ? (
                        // One muted line under the revision: what it changed across the PR.
                        <div
                          className="mt-0.5 text-2xs leading-4"
                          style={{ color: "var(--fg-muted)" }}
                          data-testid={`revision-summary-${r.revision}`}
                          aria-label={formatRevisionSummary({ revision: r.revision, summary })}
                        >
                          {summary}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {onToggleHighlight ? (
                <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                  <UiText>
                    {highlightAvailable
                      ? "Lines those revisions changed light up in each unit; esc clears."
                      : "Switch to the guide to see them."}
                  </UiText>
                </p>
              ) : null}
            </div>
          ) : null}

          {previous === null ? (
            <p className="mt-2 text-2xs" style={{ color: "var(--fg-faint)" }}>
              <UiText>The only revision so far: nothing to fall back to.</UiText>
            </p>
          ) : (
            <div className="mt-2.5 border-t pt-2" style={{ borderColor: "var(--border)" }}>
              {confirming ? (
                <p className="mb-2 text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
                  <UiText>{discardConfirmText(state.revision, previous)}</UiText>
                </p>
              ) : null}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="btn"
                  data-testid="discard-revision"
                  disabled={discarding || blockedWhy !== null}
                  data-tip={blockedWhy ?? undefined}
                  style={confirming ? { color: "var(--risk)", borderColor: "var(--risk)" } : undefined}
                  onClick={() => {
                    if (!confirming) {
                      setConfirming(true);
                      return;
                    }
                    onDiscard(state.revision);
                  }}
                >
                  <UiText>
                    {discarding
                      ? "discarding…"
                      : confirming
                        ? `discard r${state.revision}`
                        : `discard revision ${state.revision}`}
                  </UiText>
                </button>
                {confirming && !discarding ? (
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>
                    <UiText>cancel</UiText>
                  </button>
                ) : null}
              </div>
              {blockedWhy ? (
                <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                  <UiText>{blockedWhy}</UiText>
                </p>
              ) : null}
              {error ? (
                <p className="mt-1.5 text-2xs leading-4" role="alert" style={{ color: "var(--risk)" }}>
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </FloatingPanel>
      ) : null}
    </span>
  );
}
