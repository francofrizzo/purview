import { useCallback, useEffect, useRef, useState } from "react";
import { FloatingPanel } from "./FloatingPanel";
import type { PrState } from "../api/types";
import { formatAddedAt, formatFullTimestamp } from "../lib/prList";
import { discardAvailability, discardConfirmText } from "../lib/revisionDiscard";

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
}: {
  state: Pick<PrState, "revision" | "revisions" | "baseOnly">;
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
        title="Revision details"
        onClick={toggle}
        className="-mx-1 rounded px-1 text-2xs transition-colors hover:bg-[var(--bg-hover)]"
        style={{ color: open ? "var(--fg)" : "var(--fg-faint)" }}
      >
        rev {state.revision}
        {state.baseOnly ? " (base only)" : ""}
      </button>
      {open ? (
        <FloatingPanel
          anchorRef={wrapRef}
          onClose={close}
          label={`Revision ${state.revision}`}
          className="w-72 p-2.5 text-xs"
        >
          <div style={{ color: "var(--fg)" }}>
            Revision {state.revision}
            {state.baseOnly ? <span style={{ color: "var(--fg-faint)" }}> · base moved only</span> : null}
          </div>
          {info?.headSha || info?.addedAt ? (
            <div className="mt-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
              {info.headSha ? (
                <>
                  head <span className="font-mono">{info.headSha.slice(0, 10)}</span>
                </>
              ) : null}
              {info.headSha && info.addedAt ? " · " : null}
              {info.addedAt ? (
                <span title={formatFullTimestamp(info.addedAt)}>fetched {formatAddedAt(info.addedAt)}</span>
              ) : null}
            </div>
          ) : null}

          {previous === null ? (
            <p className="mt-2 text-2xs" style={{ color: "var(--fg-faint)" }}>
              The only revision so far: nothing to fall back to.
            </p>
          ) : (
            <div className="mt-2.5 border-t pt-2" style={{ borderColor: "var(--border)" }}>
              {confirming ? (
                <p className="mb-2 text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
                  {discardConfirmText(state.revision, previous)}
                </p>
              ) : null}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="btn"
                  data-testid="discard-revision"
                  disabled={discarding || blockedWhy !== null}
                  title={blockedWhy ?? undefined}
                  style={confirming ? { color: "var(--risk)", borderColor: "var(--risk)" } : undefined}
                  onClick={() => {
                    if (!confirming) {
                      setConfirming(true);
                      return;
                    }
                    onDiscard(state.revision);
                  }}
                >
                  {discarding
                    ? "discarding…"
                    : confirming
                      ? `discard r${state.revision}`
                      : `discard revision ${state.revision}`}
                </button>
                {confirming && !discarding ? (
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>
                    cancel
                  </button>
                ) : null}
              </div>
              {blockedWhy ? (
                <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {blockedWhy}
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
