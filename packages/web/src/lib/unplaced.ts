/**
 * Hunks of the current revision that no live unit claims — the "Not in any
 * unit" group. Two ways to end up here: the analysis explicitly left a hunk
 * unassigned, or (far more common) a refresh landed new hunks and no analysis
 * has placed them yet, e.g. because the PR is archived and auto-analysis
 * skipped it. Either way the hunk exists in `files` and in no unit's
 * `hunkIds`, so one set difference covers both.
 *
 * Husks (`state.removedUnits`) never cover anything: their hunks left the PR.
 */

import { isRemovedUnit, type PrDetail } from "../api/types";

/**
 * Reserved selection id for the pseudo-unit. Real unit ids are the skill's
 * kebab-case slugs, so the underscores can never collide with one.
 */
export const UNPLACED_ID = "__unplaced__";

/** Unplaced hunk ids, in file order (the order the files view shows them). */
export function unplacedHunkIds(detail: Pick<PrDetail, "files" | "state">): string[] {
  const covered = new Set<string>();
  // `state.units` is live-only already (the client adapter splits husks off);
  // the filter is the backstop, same as unitDisplayOrder's.
  for (const u of detail.state.units) {
    if (isRemovedUnit(u)) continue;
    for (const id of u.hunkIds) covered.add(id);
  }
  const out: string[] = [];
  for (const f of detail.files.files) {
    for (const h of f.hunks) if (!covered.has(h.id)) out.push(h.id);
  }
  return out;
}
