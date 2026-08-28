import type { PrGithubState, Staleness, StalenessReason } from "../api/types";

/**
 * How often the PR view re-checks staleness while it is visible. React Query
 * pauses intervals for hidden documents, so this only ever fires on screen.
 */
export const STALENESS_POLL_MS = 5 * 60_000;

/**
 * Merged and closed PRs still get checked (you want to know the one you were
 * reading just merged), but they will not grow new commits under you, so they
 * are not worth a standing interval — mount and focus are enough.
 */
export function stalenessPollInterval(state: PrGithubState | null | undefined): number | false {
  return state === "merged" || state === "closed" ? false : STALENESS_POLL_MS;
}

/**
 * One REST call tells us *that* the head sha moved, never by how many commits,
 * so every phrase here is deliberately count-free.
 */
export function stalenessReasonLabel(reason: StalenessReason): string {
  switch (reason) {
    case "new-commits":
      return "new commits upstream";
    case "base-moved":
      return "base branch moved";
    case "state-changed":
      return "PR state changed";
  }
}

export function stalenessReasonText(reasons: StalenessReason[]): string {
  return reasons.map(stalenessReasonLabel).join(" · ");
}

/** Tooltip for the refresh button; `null` when there is nothing to say. */
export function stalenessTooltip(result: Staleness | undefined | null): string | null {
  if (!result?.stale || result.reasons.length === 0) return null;
  return `${stalenessReasonText(result.reasons)} — refresh to fetch the latest`;
}

/**
 * What a dismissal is remembered against. Keyed on the upstream head sha, so
 * dismissing the bar keeps it away for *this* upstream revision and the bar
 * comes back the next time the PR actually moves again.
 */
export function stalenessDismissKey(result: Staleness | undefined | null): string | null {
  if (!result?.stale) return null;
  return result.upstreamHeadSha ?? "";
}

/**
 * The hint bar is the dismissible half of the signal; the dot on the refresh
 * button is not, so this only ever gates the bar.
 */
export function shouldShowStalenessHint(
  result: Staleness | undefined | null,
  dismissedKey: string | null,
): boolean {
  const current = stalenessDismissKey(result);
  return current !== null && current !== dismissedKey;
}
