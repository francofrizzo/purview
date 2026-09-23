import { diffOfDiffs, type DiffOfDiffsLine } from "./diff-of-diffs.js";
import { renderShowHunk } from "./hunk-select.js";
import { containment } from "./migration.js";
import { liveUnits } from "./reducer.js";
import { hunkIdsByFile, shortIds } from "./unit-patch.js";
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

/* ------------------------------------------------------- prior-code share */

/** Below this share, "N% of its lines were already in rK" is noise and is not printed. */
export const PRIOR_SHARE_MIN = 0.2;

/**
 * How much of `hunk` another set of hunks (typically every hunk of the same
 * file in the other revision) already holds: `containment` against their
 * pooled lines, so a hunk stitched together from several old hunks counts
 * fully. 0 when the hunk has no significant lines.
 */
export function sharedShare(hunk: Hunk, pool: readonly Hunk[]): number {
  return containment(hunk, {
    addedLines: pool.flatMap((h) => h.addedLines),
    removedLines: pool.flatMap((h) => h.removedLines),
  }).score;
}

/** The previous revision's hunks of the file `current` (rename-aware) was. */
function previousFileHunks(current: FileDiff, previousFiles: FileDiff[] | undefined): Hunk[] {
  const path = current.oldPath ?? current.path;
  return (previousFiles ?? []).filter((f) => f.path === path).flatMap((f) => f.hunks);
}

/** The current revision's hunks of the file a previous-revision `path` became (rename-aware). */
function currentFileHunks(path: string, currentFiles: FileDiff[] | undefined): Hunk[] {
  return (currentFiles ?? []).filter((f) => (f.oldPath ?? f.path) === path).flatMap((f) => f.hunks);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/* ---------------------------------------------------------------- rendering */

/** Above this many changed lines, a reworked hunk is printed whole instead. */
const MAX_DELTA_LINES = 40;

/**
 * At most this many body lines are printed per reworked hunk (its
 * before->after, or its whole body when heavily reworked); the rest is one
 * `show` away. Keeps a revision that rewrote a few big hunks from spilling.
 */
export const MAX_HUNK_PRINT_LINES = 30;

/** `lines` capped at MAX_HUNK_PRINT_LINES, with a pointer to the full body. */
function capLines(lines: string[], more: (n: number) => string): string[] {
  if (lines.length <= MAX_HUNK_PRINT_LINES) return lines;
  return [...lines.slice(0, MAX_HUNK_PRINT_LINES), more(lines.length - MAX_HUNK_PRINT_LINES)];
}

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
function renderDelta(
  lines: DiffOfDiffsLine[],
  moved?: { wasStillElsewhere: Set<string>; nowWasElsewhere: Set<string> },
): { text: string; changed: number } {
  const flat: { tag: "   " | "was" | "now"; line: string }[] = [];
  for (const l of lines) {
    if (l.type === "unchanged") flat.push({ tag: "   ", line: l.oldLine ?? "" });
    // A containment match (split/merged hunk): a line that only crossed a
    // hunk boundary — the old side's line now in a sibling hunk, or the new
    // side's line that another old hunk already had — is not a change.
    if (
      (l.type === "removed" || l.type === "modified") &&
      !moved?.wasStillElsewhere.has(bodyKey(l.oldLine ?? ""))
    )
      flat.push({ tag: "was", line: l.oldLine ?? "" });
    if (
      (l.type === "added" || l.type === "modified") &&
      !moved?.nowWasElsewhere.has(bodyKey(l.newLine ?? ""))
    )
      flat.push({ tag: "now", line: l.newLine ?? "" });
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

/** A '+'/'-' body line, whitespace-insensitive; "" for context and blank lines (never matched). */
function bodyKey(line: string): string {
  if (!line.startsWith("+") && !line.startsWith("-")) return "";
  const t = line.slice(1).trim();
  return t ? line[0] + t : "";
}

function bodyKeys(hunks: readonly Hunk[]): Set<string> {
  const out = new Set<string>();
  for (const h of hunks) for (const l of h.text.split("\n")) {
    const k = bodyKey(l);
    if (k) out.add(k);
  }
  return out;
}

export interface RenderChangesInput {
  state: Pick<State, "units" | "archived" | "unassignedHunkIds">;
  report: MigrationReport | undefined;
  revision: number;
  previousFiles?: FileDiff[];
  currentFiles?: FileDiff[];
  /** how to fetch one hunk's full body, e.g. `<cli> show <key>`; printed after a capped hunk */
  showCommand?: string;
}

export interface RenderedChanges {
  body: string;
  /** one-line tally, also printed when the body spills to a file */
  summary: string;
  count: number;
  /** one entry per block with its 1-based line range in `body`, for a spill's table of contents */
  toc: { label: string; from: number; to: number }[];
}

/** What `reviewer-state changes` prints: one block per changed unit. */
export function renderChanges(input: RenderChangesInput): RenderedChanges {
  const { state, report, revision } = input;
  const changes = changedUnits(state, report, input);
  const prev = hunkIndex(input.previousFiles);
  const cur = hunkIndex(input.currentFiles);
  const prevRev = report?.previousRevision !== undefined ? `r${report.previousRevision}` : "the previous revision";

  // For every `new` hunk: how much of it the previous revision's same file
  // already had. A hunk that is mostly old code only crossed a hunk boundary
  // (a rebase re-cut the diff); it is not a change of this revision.
  const priorShare = new Map<string, number>();
  for (const e of report?.entries ?? []) {
    if (e.status !== "new") continue;
    const h = cur.get(e.hunkId);
    if (!h) continue;
    const share = sharedShare(h.hunk, previousFileHunks(h.file, input.previousFiles));
    if (share >= PRIOR_SHARE_MIN) priorShare.set(e.hunkId, share);
  }
  const priorNote = (id: string): string => {
    const share = priorShare.get(id);
    return share === undefined ? "" : `  (${pct(share)} of its lines were already in ${prevRev})`;
  };
  const printedNew = new Set<string>();

  if (changes.length === 0 && priorShare.size === 0) {
    const line = `No units changed in revision ${revision}.`;
    return { body: line + "\n", summary: line, count: 0, toc: [] };
  }

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
  const showCmd = input.showCommand ?? "show";
  const shortId = shortIds([...cur.keys()]);
  const moreLines = (id: string) => (n: number) => `      … ${n} more lines — \`${showCmd} ${id}\` for all`;
  const toc: RenderedChanges["toc"] = [];
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
    // its title and summary must describe exactly these hunks. Grouped by
    // file with short ids (accepted by `show` and the patch commands), so an
    // add/remove patch needs no other lookup.
    const holding = u.hunkIds.map((id) => cur.get(id)).filter((h) => h !== undefined);
    const byFile = new Map<string, { add: number; del: number }>();
    for (const h of holding) {
      const f = byFile.get(h!.file.path) ?? { add: 0, del: 0 };
      f.add += h!.hunk.addedLines.length;
      f.del += h!.hunk.removedLines.length;
      byFile.set(h!.file.path, f);
    }
    const files = [...(input.currentFiles ?? [])].map((f) => ({ path: f.path, hunkIds: f.hunks.map((h) => h.id) }));
    lines.push(`now holds ${u.hunkIds.length} hunk${u.hunkIds.length === 1 ? "" : "s"}:`);
    for (const g of hunkIdsByFile(u.hunkIds, files, shortId)) {
      const f = byFile.get(g.path);
      lines.push(`    ${g.path}${f ? ` +${f.add} -${f.del}` : ""}: ${g.ids.join(" ")}`);
    }

    for (const e of c.reworked) {
      reworkedCount++;
      const before = e.previousHunkId ? prev.get(e.previousHunkId) : undefined;
      const after = cur.get(e.hunkId);
      const contained = e.match === "containment";
      const score =
        e.score === undefined || e.status !== "fuzzy"
          ? ""
          : contained
            ? ` (hunk boundaries moved: ${pct(e.score)} of its lines were already in ${e.previousHunkId ?? "?"})`
            : ` score ${e.score.toFixed(2)}`;
      const siblings = contained
        ? (report?.entries ?? []).filter(
            (o) => o !== e && o.status !== "archived" && o.previousHunkId === e.previousHunkId,
          )
        : [];
      const head =
        `~ ${e.status}${score}: ${e.hunkId} <- ${e.previousHunkId ?? "?"}  ${e.file}` +
        (e.previousFile ? ` (was ${e.previousFile})` : "") +
        (siblings.length ? `  (also continued in ${siblings.map((o) => o.hunkId).join(", ")})` : "");
      if (!before || !after) {
        lines.push(`${head}  (bodies unavailable)`);
        continue;
      }
      lines.push(`${head}${hdr(after.hunk)}  ${sizes(before.hunk)} -> ${sizes(after.hunk)}`);
      const moved = contained
        ? {
            wasStillElsewhere: bodyKeys(
              currentFileHunks(before.file.path, input.currentFiles).filter((h) => h.id !== after.hunk.id),
            ),
            nowWasElsewhere: bodyKeys(
              previousFileHunks(after.file, input.previousFiles).filter((h) => h.id !== before.hunk.id),
            ),
          }
        : undefined;
      const delta = renderDelta(diffOfDiffs(before.hunk.text, after.hunk.text).lines, moved);
      if (delta.changed > MAX_DELTA_LINES) {
        lines.push(`    (reworked heavily: ${delta.changed} changed lines; current body)`);
        const [head, ...body] = renderShowHunk(after).trimEnd().split("\n");
        lines.push(head, ...capLines(body, moreLines(e.hunkId)));
      } else if (delta.changed > 0) {
        lines.push(...capLines(delta.text.split("\n"), moreLines(e.hunkId)));
      } else {
        lines.push("    (same lines; only position/context moved)");
      }
    }

    for (const e of c.archived) {
      archivedCount++;
      const old = prev.get(e.hunkId)?.hunk;
      // An archived hunk whose lines mostly live on in the current file was
      // re-cut into other hunks by a rebase, not deleted.
      const still = old ? sharedShare(old, currentFileHunks(e.file, input.currentFiles)) : 0;
      lines.push(
        `- archived: ${e.hunkId}  ${e.file}` +
          (old ? `${hdr(old)}  ${sizes(old)}` : "") +
          (still >= PRIOR_SHARE_MIN ? `  (${pct(still)} of its lines are still in r${revision})` : ""),
      );
    }

    for (const e of c.gained) {
      const h = cur.get(e.hunkId)?.hunk;
      printedNew.add(e.hunkId);
      lines.push(
        `+ gained new: ${e.hunkId}  ${e.file}` + (h ? `${hdr(h)}  ${sizes(h)}` : "") + priorNote(e.hunkId),
      );
    }

    const unitFiles = new Set([
      ...u.hunkIds.flatMap((id) => cur.get(id)?.file.path ?? []),
      ...c.archived.map((e) => e.file),
    ]);
    const hints = looseHunks.filter((l) => unitFiles.has(l.file.path));
    for (const l of hints) {
      hintCount++;
      printedNew.add(l.hunk.id);
      lines.push(
        `? related (unassigned, hint only): ${l.hunk.id}  ${l.file.path}${hdr(l.hunk)}  ${sizes(l.hunk)}` +
          priorNote(l.hunk.id),
      );
    }
    const from = blocks.length + 1;
    blocks.push(...lines, "");
    toc.push({ label: `unit ${u.id}`, from, to: blocks.length - 1 });
  }

  // `new` hunks not printed above that are largely old code: listed so the
  // analysis does not credit (or changelog) pre-existing code to this revision.
  const priorOnly = [...priorShare.keys()].filter((id) => !printedNew.has(id));
  if (changes.length === 0) blocks.push(`No units changed in revision ${revision}.`, "");
  if (priorOnly.length > 0) {
    toc.push({ label: "new hunks partly from the previous revision", from: blocks.length + 1, to: blocks.length + 1 + priorOnly.length });
    blocks.push(
      `New hunks partly made of code ${prevRev} already had (a rebase re-cut hunk boundaries; that share is not a change of r${revision}):`,
      ...priorOnly.map((id) => {
        const h = cur.get(id)!;
        return `  ${id}  ${h.file.path}${hdr(h.hunk)}  ${sizes(h.hunk)}${priorNote(id)}`;
      }),
      "",
    );
  }

  const summary =
    `-- ${changes.length} changed unit${changes.length === 1 ? "" : "s"}: ` +
    `${reworkedCount} reworked hunks, ${archivedCount} archived, ${hintCount} related hints` +
    (priorShare.size > 0 ? `, ${priorShare.size} new hunks partly from ${prevRev}` : "");
  return { body: blocks.join("\n") + summary + "\n", summary, count: changes.length, toc };
}
