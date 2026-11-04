import type { PrState, ReviewUnit, RevisionInfo } from "../api/types";
import { withoutRevisionLabel } from "./changelog";
import { skippedIds } from "./diffModel";
import { workUnits } from "./generated";

/**
 * The overview's revision strip (experiment `revisionStrip`): a column per
 * revision, a row per work unit, a mark where a revision touched the unit,
 * and how far the reader had read each one. Built from what the state
 * already carries:
 *
 * - a unit's `changelog` (one line per later revision that changed it);
 * - a unit that arrived in the revision in force: every hunk of it is
 *   `migration: "new"` (the refresh found no predecessor for any of them).
 *   Nothing records the revision an older unit first appeared in, so every
 *   other unit's line starts at the first revision;
 * - husks (`removedUnits`): the revision every hunk of them left the PR;
 * - hunk state: the newest revision any of the unit's hunks was viewed at,
 *   and how many viewed hunks changed after that.
 */

export type StripMarkKind = "added" | "changed" | "removed";

export interface StripMark {
  revision: number;
  kind: StripMarkKind;
  /** the changelog line for that revision, when the analysis wrote one */
  text?: string;
  /** landed after the revision the reader last read the unit at */
  unread: boolean;
}

export interface StripColumn {
  revision: number;
  addedAt?: string;
  /** what the revision changed across the PR, label stripped */
  summary?: string;
  baseOnly: boolean;
  current: boolean;
  /** the reader's last submitted review was on this revision */
  reviewed: boolean;
}

export interface StripRow {
  id: string;
  title: string;
  /** the overview's display number; absent on a husk */
  number?: number;
  removed: boolean;
  /** the revisions the unit existed in, inclusive: its line on the strip */
  from: number;
  to: number;
  marks: StripMark[];
  /** the newest revision any of its hunks was viewed at; absent until one was */
  readAt?: number;
  /** viewed hunks that changed after they were viewed */
  changed: number;
  viewed: number;
  total: number;
  /** read before, and something moved since: the row to look at */
  stale: boolean;
  /** a husk the reader had read whole before it left */
  readBeforeRemoval?: boolean;
}

export interface RevisionStripModel {
  columns: StripColumn[];
  rows: StripRow[];
  /** rows read before and moved since */
  stale: number;
}

type StripState = Pick<PrState, "units" | "removedUnits" | "hunks" | "revisions" | "revision" | "currentRevision">;

/**
 * The strip for a PR, or null when it has fewer than two revisions (nothing
 * to lay side by side). `units` is the overview's display order (husks and
 * the generated unit are dropped here); `numbers` its display numbers.
 */
export function revisionStrip(
  state: StripState,
  units: readonly ReviewUnit[],
  numbers: ReadonlyMap<string, number>,
  opts: { reviewedAt?: number } = {},
): RevisionStripModel | null {
  const current = state.currentRevision ?? state.revision;
  const columns = stripColumns(state.revisions, current, opts.reviewedAt);
  if (columns.length < 2) return null;
  const first = columns[0].revision;
  const known = new Set(columns.map((c) => c.revision));

  const rows: StripRow[] = workUnits(units.filter((u) => u.removedAtRevision === undefined)).map((u) => {
    const read = readProgress(state, u);
    const entries = changelogByRevision(u, known);
    const arrived = current > first && arrivedNow(state, u);
    const marks: StripMark[] = [];
    for (const [revision, text] of entries) {
      if (arrived && revision < current) continue;
      marks.push({ revision, kind: arrived && revision === current ? "added" : "changed", text, unread: false });
    }
    if (arrived && !entries.has(current)) marks.push({ revision: current, kind: "added", unread: false });
    return finish({
      id: u.id,
      title: u.title,
      number: numbers.get(u.id),
      removed: false,
      from: arrived ? current : first,
      to: current,
      marks,
      ...read,
    });
  });

  for (const u of workUnits([...(state.removedUnits ?? [])].sort((a, b) => a.order - b.order))) {
    const at = u.removedAtRevision ?? current;
    const marks: StripMark[] = [...changelogByRevision(u, known)]
      .filter(([revision]) => revision < at)
      .map(([revision, text]) => ({ revision, kind: "changed" as const, text, unread: false }));
    marks.push({ revision: at, kind: "removed", unread: false });
    rows.push({
      id: u.id,
      title: u.title,
      removed: true,
      from: first,
      to: at,
      marks,
      changed: 0,
      viewed: 0,
      total: 0,
      stale: false,
      readBeforeRemoval: u.readBeforeRemoval,
    });
  }

  return { columns, rows, stale: rows.filter((r) => r.stale).length };
}

function stripColumns(revisions: readonly RevisionInfo[] | undefined, current: number, reviewedAt?: number): StripColumn[] {
  const list = revisions?.length
    ? [...revisions].filter((r) => r.revision <= current).sort((a, b) => a.revision - b.revision)
    : Array.from({ length: Math.max(current, 0) }, (_, i) => ({ revision: i + 1 }) as RevisionInfo);
  return list.map((r) => ({
    revision: r.revision,
    addedAt: r.addedAt,
    summary: r.summary ? withoutRevisionLabel(r.summary) : undefined,
    baseOnly: r.baseOnly === true,
    current: r.revision === current,
    reviewed: reviewedAt === r.revision,
  }));
}

/** One line per revision, the last one written winning; revisions off the strip dropped. */
function changelogByRevision(u: ReviewUnit, known: Set<number>): Map<number, string> {
  const out = new Map<number, string>();
  for (const e of [...(u.changelog ?? [])].sort((a, b) => a.revision - b.revision)) {
    if (known.has(e.revision)) out.set(e.revision, withoutRevisionLabel(e.text));
  }
  return out;
}

/** Every hunk of the unit is new in the revision in force: the unit arrived with it. */
function arrivedNow(state: StripState, u: ReviewUnit): boolean {
  return u.hunks.length > 0 && u.hunks.every((h) => state.hunks[h.id]?.migration === "new");
}

function readProgress(state: StripState, u: ReviewUnit) {
  const skip = skippedIds(u);
  let viewed = 0;
  let changed = 0;
  let total = 0;
  let readAt: number | undefined;
  for (const { id } of u.hunks) {
    if (skip.has(id)) continue;
    total++;
    const st = state.hunks[id];
    if (!st?.viewed) continue;
    viewed++;
    if (st.changedSinceViewed) changed++;
    if (st.viewedAtRevision !== undefined) readAt = Math.max(readAt ?? 0, st.viewedAtRevision);
  }
  return { viewed, total, changed, readAt };
}

function finish(row: Omit<StripRow, "stale">): StripRow {
  const marks = row.marks
    .map((m) => ({ ...m, unread: row.readAt !== undefined && m.revision > row.readAt }))
    .sort((a, b) => a.revision - b.revision);
  return { ...row, marks, stale: row.readAt !== undefined && (row.changed > 0 || marks.some((m) => m.unread)) };
}

/** The status a row ends on: "since r2" when it moved after you read it, "read r3", or nothing. */
export function stripStatus(row: StripRow): { label: string; tip: string; stale: boolean } | null {
  if (row.removed) {
    return row.readBeforeRemoval
      ? { label: "read", tip: "You had read all of it before it left the PR", stale: false }
      : null;
  }
  if (row.readAt === undefined) return null;
  if (!row.stale) {
    const whole = row.viewed === row.total;
    return {
      label: `read r${row.readAt}`,
      tip: whole ? `Read at r${row.readAt}; nothing changed since` : `Partly read (${row.viewed}/${row.total}), last at r${row.readAt}; nothing changed since`,
      stale: false,
    };
  }
  const later = row.marks.filter((m) => m.unread).map((m) => `r${m.revision}`);
  const parts = [
    later.length ? `${later.join(", ")} changed it` : "",
    row.changed ? `${row.changed} hunk${row.changed === 1 ? "" : "s"} you viewed changed` : "",
  ].filter(Boolean);
  return { label: `since r${row.readAt}`, tip: `You last read it at r${row.readAt}; since then ${parts.join(", ")}`, stale: true };
}
