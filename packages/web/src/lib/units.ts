import type { HeartSegment, HunkEntry, ReviewUnit } from "../api/types";

/** The ids of a unit's hunks, in list order. */
export function hunkIdsOf(unit: Pick<ReviewUnit, "hunks">): string[] {
  return unit.hunks.map((h) => h.id);
}

/** The hunks the unit's logic lives in, in list order (one to three, or none), with their segments. */
export function heartOf(unit: Pick<ReviewUnit, "hunks">): (HunkEntry & { heart: HeartSegment[] })[] {
  return unit.hunks.filter((h): h is HunkEntry & { heart: HeartSegment[] } => Boolean(h.heart?.length));
}

/** Every heart segment of the unit, flattened in list order, each with its hunk id. */
export function heartSegments(unit: Pick<ReviewUnit, "hunks">): (HeartSegment & { id: string })[] {
  return heartOf(unit).flatMap((h) => h.heart.map((s) => ({ ...s, id: h.id })));
}

/** The hunks the analysis says a reader can skip. */
export function skipOf(unit: Pick<ReviewUnit, "hunks">): HunkEntry[] {
  return unit.hunks.filter((h) => h.skip === true);
}

/** The analysis's label on a hunk, or undefined. */
export function labelOf(unit: Pick<ReviewUnit, "hunks">, hunkId: string): string | undefined {
  return unit.hunks.find((h) => h.id === hunkId)?.label;
}

/** Bare entries for a list of ids: membership and nothing else. */
export function hunkEntries(ids: Iterable<string>): HunkEntry[] {
  return [...ids].map((id) => ({ id }));
}
