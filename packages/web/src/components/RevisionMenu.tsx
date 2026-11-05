import { useCallback, useEffect, useRef, useState } from "react";
import { FloatingPanel } from "./FloatingPanel";
import type { PrState, RevisionInfo } from "../api/types";
import { formatAddedAt, formatFullTimestamp } from "../lib/prList";
import { discardAvailability, discardConfirmText } from "../lib/revisionDiscard";
import { formatRevisionSummary, revisionSummaryLines } from "../lib/revisionSummary";
import { UiText } from "./UiText";

/**
 * The header's "rev N": opens the PR's revisions as a timeline, newest first:
 * each one's head, when it was fetched and what it changed, the one in force
 * marked current. A revision past the first lights up the lines it changed
 * on a click. Under it, the one thing to do about a bad revision: discard it
 * (a refresh that caught the author mid-rebase). Two clicks: the first spells
 * out what goes, the second does it. On success the PR falls back a
 * revision, which closes the popover.
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
  const { previous, blockedWhy } = discardAvailability(state, analysisLive);
  // Every revision, newest first, on one rail. Past the first, each is a
  // toggle (when the caller offers it) that lights up what it changed.
  const all = [...(state.revisions ?? [])].sort((a, b) => b.revision - a.revision);
  if (!all.some((r) => r.revision === state.revision)) all.unshift({ revision: state.revision, baseOnly: state.baseOnly });
  const later = all.filter((r) => r.revision > 1);
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
          className="w-[26rem] p-1.5 text-xs"
        >
          <ol className="relative" data-testid="revision-timeline">
            {all.map((r, i) => (
              <TimelineRow
                key={r.revision}
                info={r}
                current={r.revision === state.revision}
                last={i === all.length - 1}
                summary={summaryOf(r.revision)}
                highlight={
                  onToggleHighlight && r.revision > 1
                    ? { on: highlightRevisions.includes(r.revision), available: highlightAvailable, toggle: () => onToggleHighlight(r.revision) }
                    : undefined
                }
              />
            ))}
          </ol>
          {onToggleHighlight && later.length > 0 ? (
            <p className="px-2 pb-1 pt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
              <UiText>
                {highlightAvailable
                  ? "Click a revision to light up the lines it changed in each unit; esc clears."
                  : "Switch to the guide to light up what a revision changed."}
              </UiText>
            </p>
          ) : null}

          {previous === null ? null : (
            <div className="mt-1 border-t px-2 pb-1 pt-2" style={{ borderColor: "var(--border)" }}>
              {confirming ? (
                <p className="mb-2 text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
                  <UiText>{discardConfirmText(state.revision, previous)}</UiText>
                </p>
              ) : null}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className={confirming ? "btn" : "rounded px-1 py-0.5 text-2xs transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--risk)] disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--fg-faint)]"}
                  data-testid="discard-revision"
                  disabled={discarding || blockedWhy !== null}
                  data-tip={blockedWhy ?? (confirming ? undefined : "For a refresh that caught the author mid-rebase")}
                  style={confirming ? { color: "var(--risk)", borderColor: "var(--risk)" } : { color: "var(--fg-faint)" }}
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
                        : `discard revision ${state.revision}…`}
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

/**
 * One revision on the rail: its node, number, head and age, the summary under
 * them. The node is hollow, filled for the revision in force, and the accent
 * while its changes are lit up; the line runs down to the next one.
 */
function TimelineRow({
  info,
  current,
  last,
  summary,
  highlight,
}: {
  info: RevisionInfo;
  current: boolean;
  last: boolean;
  summary?: string;
  highlight?: { on: boolean; available: boolean; toggle: () => void };
}) {
  const on = highlight?.on ?? false;
  const node = on ? "var(--accent)" : current ? "var(--fg-muted)" : "var(--border-strong)";
  const body = (
    <>
      {/* The rail: from under this node down to the next one. */}
      {last ? null : (
        <span aria-hidden className="absolute bottom-[-6px] left-[13px] top-[19px] w-px" style={{ background: "var(--border)" }} />
      )}
      <span
        aria-hidden
        className="absolute left-[9px] top-[9px] h-[9px] w-[9px] rounded-full"
        style={{
          border: `1.5px solid ${node}`,
          background: on || current ? node : "var(--bg-raised)",
          boxShadow: on ? "0 0 0 3px var(--accent-soft)" : undefined,
        }}
      />
      <span className="flex items-baseline gap-2">
        <span className="font-medium tabular-nums" style={{ color: on ? "var(--accent)" : "var(--fg)" }}>
          <UiText>{`r${info.revision}`}</UiText>
        </span>
        {info.headSha ? (
          <span className="font-mono text-2xs" style={{ color: "var(--fg-faint)" }} data-tip={`head ${info.headSha}`}>
            {info.headSha.slice(0, 7)}
          </span>
        ) : null}
        {current ? (
          <span className="chip" style={{ color: "var(--fg-muted)", background: "var(--bg-hover)" }}>
            <UiText>current</UiText>
          </span>
        ) : null}
        {info.baseOnly ? (
          <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            <UiText>base moved only</UiText>
          </span>
        ) : null}
        {info.addedAt ? (
          <span
            className="ml-auto flex-none text-2xs"
            style={{ color: "var(--fg-faint)" }}
            data-testid={`revision-when-${info.revision}`}
            data-tip={`fetched ${formatFullTimestamp(info.addedAt)}`}
          >
            <UiText>{formatAddedAt(info.addedAt)}</UiText>
          </span>
        ) : null}
      </span>
      {summary ? (
        <span
          className="mt-0.5 block text-2xs leading-4"
          style={{ color: "var(--fg-muted)" }}
          data-testid={`revision-summary-${info.revision}`}
          aria-label={formatRevisionSummary({ revision: info.revision, summary })}
        >
          {summary}
        </span>
      ) : info.revision === 1 ? (
        <span className="mt-0.5 block text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
          <UiText>The PR as first fetched.</UiText>
        </span>
      ) : null}
    </>
  );
  const box = "relative block w-full rounded-md py-1.5 pl-7 pr-2 text-left";
  return (
    <li data-testid={info.revision > 1 ? `revision-row-${info.revision}` : "revision-first"} className="relative">
      {highlight ? (
        <button
          type="button"
          className={`${box} transition-colors enabled:hover:bg-[var(--bg-hover)]`}
          data-testid={`highlight-revision-${info.revision}`}
          aria-pressed={on}
          disabled={!highlight.available}
          data-tip={
            !highlight.available
              ? "Shown on the guide tab"
              : on
                ? `Stop showing what revision ${info.revision} changed`
                : `Light up the lines revision ${info.revision} changed`
          }
          style={on ? { background: "var(--accent-soft)" } : undefined}
          onClick={highlight.toggle}
        >
          {body}
        </button>
      ) : (
        <div className={box}>{body}</div>
      )}
    </li>
  );
}
