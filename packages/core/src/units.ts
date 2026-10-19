import type { HeartSegment, HunkEntry, HunkLines, ReviewUnit } from "./schemas.js";

/**
 * Reading a unit's `hunks` list (see HunkEntrySchema): membership, labels,
 * skips and hearts all live there, and these are the one place the rest of
 * the code reads them from.
 */

type WithHunks = Pick<ReviewUnit, "hunks">;

/** The unit's hunk ids, in list order. */
export function hunkIdsOf(unit: WithHunks): string[] {
  return unit.hunks.map((h) => h.id);
}

/** The unit's heart hunks with their segments, in list order. */
export function heartOf(unit: WithHunks): { id: string; segments: HeartSegment[] }[] {
  return unit.hunks.flatMap((h) => (h.heart ? [{ id: h.id, segments: h.heart }] : []));
}

/** Every heart segment of the unit, flattened, in list order. */
export function heartSegments(unit: WithHunks): { id: string; why: string; lines?: HunkLines }[] {
  return unit.hunks.flatMap((h) => (h.heart ?? []).map((seg) => ({ id: h.id, ...seg })));
}

/** The unit's skippable hunks (`skip: true`), in list order. */
export function skipOf(unit: WithHunks): HunkEntry[] {
  return unit.hunks.filter((h) => h.skip === true);
}

/** The unit's entry for `hunkId`, if it holds that hunk. */
export function entryOf(unit: WithHunks, hunkId: string): HunkEntry | undefined {
  return unit.hunks.find((h) => h.id === hunkId);
}

/** The label the unit gives `hunkId`; undefined when none. */
export function labelOf(unit: WithHunks, hunkId: string): string | undefined {
  return entryOf(unit, hunkId)?.label;
}

/**
 * `list` with `entries` upserted by id: an id the list holds has its entry
 * replaced by the given one (so a bare `{id}` clears label, skip and heart),
 * a new id is appended. Order of the list is kept.
 */
export function upsertHunks(list: readonly HunkEntry[], entries: readonly HunkEntry[]): HunkEntry[] {
  const out = [...list];
  for (const e of entries) {
    const at = out.findIndex((h) => h.id === e.id);
    if (at === -1) out.push(e);
    else out[at] = e;
  }
  return out;
}

/** A bare id is an ordinary hunk; accepted wherever a list of entries is. */
export function toHunkEntry(entry: string | HunkEntry): HunkEntry {
  return typeof entry === "string" ? { id: entry } : entry;
}

/**
 * The reducer's validity pass over a unit's `hunks`: duplicates are dropped
 * (first wins), and a bare id (an event built by hand, never parsed) becomes
 * an entry. Returns the same object when nothing changes, so untouched units
 * keep their identity.
 */
export function normalizeHunks<T extends WithHunks>(unit: T): T {
  const seen = new Set<string>();
  const kept = (unit.hunks as (string | HunkEntry)[])
    .map(toHunkEntry)
    .filter((h) => !seen.has(h.id) && seen.add(h.id));
  const same = kept.length === unit.hunks.length && kept.every((h, i) => h === unit.hunks[i]);
  return same ? unit : { ...unit, hunks: kept };
}
