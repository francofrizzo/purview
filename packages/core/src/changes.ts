import { diffOfDiffs, type DiffOfDiffsLine } from "./diff-of-diffs.js";
import { renderShowHunk } from "./hunk-select.js";
import { liveUnits } from "./reducer.js";
import type {
  FileDiff,
  Hunk,
  MigrationEntry,
  MigrationReport,
  ReviewUnit,
  State,
} from "./schemas.js";

/**
 * "Changed units": live units whose code a revision reworked, so their
 * description (`summary`/`attentionWhy`, written against the old code) may no
 * longer be true. Drives the incremental analysis's description refresh and
 * the refresh route's auto-trigger.
 */
export interface ChangedUnit {
  unit: ReviewUnit;
  /** its current hunks that migrated `fuzzy`, or `renamed` with different content */
  reworked: MigrationEntry[];
  /** `archived` entries for hunks this unit held before the revision */
  archived: MigrationEntry[];
  /** `new` hunks of this revision the unit now holds (only after an analysis attached them) */
  gained: MigrationEntry[];
  /** the revision only moved the base (see MigrationReport.baseOnly) */
  baseOnly: boolean;
}

export interface ChangedUnitsOptions {
  /** previous / current revision hunks; with both, a `renamed` hunk counts only when its content differs */
  previousFiles?: FileDiff[];
  currentFiles?: FileDiff[];
}

function hunkIndex(files: FileDiff[] | undefined): Map<string, { file: FileDiff; hunk: Hunk }> {
  const out = new Map<string, { file: FileDiff; hunk: Hunk }>();
  for (const file of files ?? []) for (const hunk of file.hunks) out.set(hunk.id, { file, hunk });
  return out;
}

function sameContent(a: Hunk, b: Hunk): boolean {
  return (
    a.addedLines.join("\n") === b.addedLines.join("\n") &&
    a.removedLines.join("\n") === b.removedLines.join("\n")
  );
}

/**
 * Live units (husks excluded) that `report` — the migration into the state's
 * current revision — changed. A unit is changed when one of its current hunks
 * migrated `fuzzy` (or `renamed` with different content), when a hunk it held
 * was archived this revision, or when it now holds a hunk that is `new` this
 * revision. Before the analysis attaches new hunks only the first two can
 * apply; units the revision did not touch never appear. Ordered by `order`.
 *
 * `renamed` is emitted by `migrate` only for identical content today, so
 * without `opts` files a renamed hunk is taken as unchanged.
 */
export function changedUnits(
  state: Pick<State, "units" | "archived">,
  report: MigrationReport | undefined,
  opts: ChangedUnitsOptions = {},
): ChangedUnit[] {
  if (!report) return [];
  const prev = hunkIndex(opts.previousFiles);
  const cur = hunkIndex(opts.currentFiles);
  const byNewId = new Map<string, MigrationEntry>();
  const archivedEntries = new Map<string, MigrationEntry>();
  for (const e of report.entries) {
    if (e.status === "archived") archivedEntries.set(e.hunkId, e);
    else byNewId.set(e.hunkId, e);
  }
  const archivedUnitOf = new Map<string, string[]>();
  for (const a of state.archived) {
    if (a.archivedAtRevision !== report.revision || !a.unitId) continue;
    if (!archivedEntries.has(a.hunkId)) continue;
    const list = archivedUnitOf.get(a.unitId) ?? [];
    list.push(a.hunkId);
    archivedUnitOf.set(a.unitId, list);
  }

  const reworkedEntry = (e: MigrationEntry | undefined): boolean => {
    if (!e) return false;
    if (e.status === "fuzzy") return true;
    if (e.status !== "renamed" || !e.previousHunkId) return false;
    const before = prev.get(e.previousHunkId)?.hunk;
    const after = cur.get(e.hunkId)?.hunk;
    return !!before && !!after && !sameContent(before, after);
  };

  const out: ChangedUnit[] = [];
  for (const unit of liveUnits(state).sort((a, b) => a.order - b.order)) {
    const reworked: MigrationEntry[] = [];
    const gained: MigrationEntry[] = [];
    for (const id of unit.hunkIds) {
      const e = byNewId.get(id);
      if (reworkedEntry(e)) reworked.push(e!);
      else if (e?.status === "new") gained.push(e);
    }
    const archived = (archivedUnitOf.get(unit.id) ?? []).map((id) => archivedEntries.get(id)!);
    if (reworked.length + archived.length + gained.length === 0) continue;
    out.push({ unit, reworked, archived, gained, baseOnly: report.baseOnly });
  }
  return out;
}

/**
 * The changed units worth a paid re-analysis. On a `baseOnly` revision the
 * PR head did not move: a fuzzy/renamed rework there came from the base
 * branch, not the author, so a unit changed only that way does not count.
 */
export function changesWorthRefreshing(changes: ChangedUnit[]): ChangedUnit[] {
  return changes.filter((c) => !c.baseOnly || c.archived.length > 0 || c.gained.length > 0);
}

/* ---------------------------------------------------------------- rendering */

/** Above this many changed lines, a reworked hunk is printed whole instead. */
const MAX_DELTA_LINES = 40;

function hdr(h: Hunk): string {
  return h.header ? `  @@${h.header}@@` : "";
}

function sizes(h: Hunk): string {
  return `+${h.addedLines.length} -${h.removedLines.length}`;
}

/**
 * The before→after of one hunk body, only its changed lines plus one line of
 * context either side: `was│` is a line only the old body had, `now│` one only
 * the new body has. The body lines keep their own diff marks.
 */
function renderDelta(lines: DiffOfDiffsLine[]): { text: string; changed: number } {
  const flat: { tag: "   " | "was" | "now"; line: string }[] = [];
  for (const l of lines) {
    if (l.type === "unchanged") flat.push({ tag: "   ", line: l.oldLine ?? "" });
    if (l.type === "removed" || l.type === "modified") flat.push({ tag: "was", line: l.oldLine ?? "" });
    if (l.type === "added" || l.type === "modified") flat.push({ tag: "now", line: l.newLine ?? "" });
  }
  const keep = new Set<number>();
  flat.forEach((f, i) => {
    if (f.tag === "   ") return;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < flat.length) keep.add(j);
  });
  const out: string[] = [];
  let last = -1;
  for (let i = 0; i < flat.length; i++) {
    if (!keep.has(i)) continue;
    if (last !== -1 && i > last + 1) out.push("      …");
    out.push(`    ${flat[i].tag}│${flat[i].line}`);
    last = i;
  }
  return { text: out.join("\n"), changed: flat.filter((f) => f.tag !== "   ").length };
}

export interface RenderChangesInput {
  state: Pick<State, "units" | "archived" | "unassignedHunkIds">;
  report: MigrationReport | undefined;
  revision: number;
  previousFiles?: FileDiff[];
  currentFiles?: FileDiff[];
}

export interface RenderedChanges {
  body: string;
  /** one-line tally, also printed when the body spills to a file */
  summary: string;
  count: number;
}

/** What `reviewer-state changes` prints: one block per changed unit. */
export function renderChanges(input: RenderChangesInput): RenderedChanges {
  const { state, report, revision } = input;
  const changes = changedUnits(state, report, input);
  if (changes.length === 0) {
    const line = `No units changed in revision ${revision}.`;
    return { body: line + "\n", summary: line, count: 0 };
  }
  const prev = hunkIndex(input.previousFiles);
  const cur = hunkIndex(input.currentFiles);

  // Hints: hunks nobody owns yet that are new this revision or unassigned.
  const owned = new Set(liveUnits(state).flatMap((u) => u.hunkIds));
  const loose = new Set([
    ...(report?.entries ?? []).filter((e) => e.status === "new").map((e) => e.hunkId),
    ...state.unassignedHunkIds,
  ]);
  const looseHunks = [...loose].filter((id) => !owned.has(id)).flatMap((id) => cur.get(id) ?? []);

  let reworkedCount = 0;
  let archivedCount = 0;
  let hintCount = 0;
  const blocks: string[] = [
    `Changed units in revision ${revision}` +
      (report?.previousRevision !== undefined ? ` (vs r${report.previousRevision})` : "") +
      (report?.baseOnly ? "  (base moved only: reworks came from the base branch)" : ""),
    "",
  ];

  for (const c of changes) {
    const u = c.unit;
    const lines: string[] = [
      `## ${u.id} — ${u.title}  [${u.attention}/${u.kind}]` +
        (u.riskFlags.length ? `  risk: ${u.riskFlags.join(",")}` : ""),
      `summary: ${u.summary}`,
      `attentionWhy: ${u.attentionWhy}`,
    ];
    const lastLog = u.changelog?.[u.changelog.length - 1];
    if (lastLog) lines.push(`last changelog: r${lastLog.revision} · ${lastLog.text}`);
    // What the unit holds *now*, so a unit that shrank (or grew) is obvious:
    // its title and summary must describe exactly these hunks.
    // Grouped by file (hunk count and +/- per file) so a 27-hunk unit stays one
    // readable line; a small unit lists its hunk ids too.
    const holding = u.hunkIds.map((id) => cur.get(id)).filter((h) => h !== undefined);
    const byFile = new Map<string, { n: number; add: number; del: number; ids: string[] }>();
    for (const h of holding) {
      const f = byFile.get(h!.file.path) ?? { n: 0, add: 0, del: 0, ids: [] };
      f.n++;
      f.add += h!.hunk.addedLines.length;
      f.del += h!.hunk.removedLines.length;
      f.ids.push(h!.hunk.id.slice(0, 8));
      byFile.set(h!.file.path, f);
    }
    const listIds = holding.length <= 4;
    lines.push(
      `now holds ${u.hunkIds.length} hunk${u.hunkIds.length === 1 ? "" : "s"}: ` +
        [...byFile]
          .map(
            ([path, f]) =>
              `${path}${f.n > 1 ? ` ×${f.n}` : ""} +${f.add} -${f.del}` + (listIds ? ` (${f.ids.join(",")})` : ""),
          )
          .join("; "),
    );

    for (const e of c.reworked) {
      reworkedCount++;
      const before = e.previousHunkId ? prev.get(e.previousHunkId)?.hunk : undefined;
      const after = cur.get(e.hunkId);
      const score = e.score !== undefined && e.status === "fuzzy" ? ` score ${e.score.toFixed(2)}` : "";
      const head =
        `~ ${e.status}${score}: ${e.hunkId} <- ${e.previousHunkId ?? "?"}  ${e.file}` +
        (e.previousFile ? ` (was ${e.previousFile})` : "");
      if (!before || !after) {
        lines.push(`${head}  (bodies unavailable)`);
        continue;
      }
      lines.push(`${head}${hdr(after.hunk)}  ${sizes(before)} -> ${sizes(after.hunk)}`);
      const delta = renderDelta(diffOfDiffs(before.text, after.hunk.text).lines);
      if (delta.changed > MAX_DELTA_LINES) {
        lines.push(`    (reworked heavily: ${delta.changed} changed lines; current body)`);
        lines.push(renderShowHunk(after).trimEnd());
      } else if (delta.changed > 0) {
        lines.push(delta.text);
      } else {
        lines.push("    (same lines; only position/context moved)");
      }
    }

    for (const e of c.archived) {
      archivedCount++;
      const old = prev.get(e.hunkId)?.hunk;
      lines.push(
        `- archived: ${e.hunkId}  ${e.file}` + (old ? `${hdr(old)}  ${sizes(old)}` : ""),
      );
    }

    for (const e of c.gained) {
      const h = cur.get(e.hunkId)?.hunk;
      lines.push(`+ gained new: ${e.hunkId}  ${e.file}` + (h ? `${hdr(h)}  ${sizes(h)}` : ""));
    }

    const unitFiles = new Set([
      ...u.hunkIds.flatMap((id) => cur.get(id)?.file.path ?? []),
      ...c.archived.map((e) => e.file),
    ]);
    const hints = looseHunks.filter((l) => unitFiles.has(l.file.path));
    for (const l of hints) {
      hintCount++;
      lines.push(
        `? related (unassigned, hint only): ${l.hunk.id}  ${l.file.path}${hdr(l.hunk)}  ${sizes(l.hunk)}`,
      );
    }
    blocks.push(lines.join("\n"), "");
  }

  const summary =
    `-- ${changes.length} changed unit${changes.length === 1 ? "" : "s"}: ` +
    `${reworkedCount} reworked hunks, ${archivedCount} archived, ${hintCount} related hints`;
  return { body: blocks.join("\n") + summary + "\n", summary, count: changes.length };
}
