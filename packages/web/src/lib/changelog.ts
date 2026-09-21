import type { UnitChangelogEntry } from "../api/types";

/** "r3 · rounding switched to banker's" */
export function formatChangelogEntry(e: UnitChangelogEntry): string {
  return `r${e.revision} · ${e.text}`;
}

/**
 * A unit's changelog as the unit header shows it: the newest entry up front,
 * the rest (newest first) behind an "earlier (N)" toggle. `null` when there is
 * nothing to show. Order-independent: the stored order is oldest first, but a
 * payload that carried its own changelog may not be.
 */
export function changelogView(
  changelog: UnitChangelogEntry[] | undefined,
): { latest: UnitChangelogEntry; earlier: UnitChangelogEntry[] } | null {
  if (!changelog?.length) return null;
  const newestFirst = [...changelog].sort((a, b) => b.revision - a.revision);
  return { latest: newestFirst[0], earlier: newestFirst.slice(1) };
}
