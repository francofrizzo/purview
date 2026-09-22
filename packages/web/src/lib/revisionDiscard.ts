/**
 * What the header's "rev N" popover offers for discarding the latest
 * revision. Pure, so the gating and the copy are testable apart from the
 * component; the server has the last word on every guard.
 */

import type { PrState } from "../api/types";

export interface DiscardAvailability {
  /** the revision a discard falls back to; null when there is none */
  previous: number | null;
  /** why the action is held back right now, when it is */
  blockedWhy: string | null;
}

export function discardAvailability(
  state: Pick<PrState, "revision" | "revisions">,
  analysisLive: boolean,
): DiscardAvailability {
  const prior = (state.revisions ?? [])
    .map((r) => r.revision)
    .filter((n) => n < state.revision)
    .sort((a, b) => b - a);
  const previous = prior[0] ?? null;
  if (previous === null) return { previous, blockedWhy: null };
  return {
    previous,
    blockedWhy: analysisLive ? "An analysis is running; cancel it or let it finish first." : null,
  };
}

/** The second step of the two-step confirm. */
export function discardConfirmText(revision: number, previous: number): string {
  return (
    `Discard r${revision}? Its analysis changes and viewed marks since then are dropped; ` +
    `the next refresh compares against r${previous}. If GitHub still has the half-pushed ` +
    `head, that refresh records it again, so discard once the author has finished pushing.`
  );
}
