import { changedUnits } from "./changes.js";
import { MIN_PREFIX_LEN } from "./hunk-select.js";
import { GENERATED_UNIT_ID, isGeneratedUnit } from "./generated.js";
import { hunkListIssues, isRemovedUnit } from "./schemas.js";
import type { FileDiff, HunkEntry, NewEvent, ReviewUnit, ReviewUnitPatch, ReviewerEvent, State } from "./schemas.js";
import { NewReviewUnitSchema, ReviewUnitPatchSchema } from "./schemas.js";
import { derivedRiskFlags, heartOf, hunkIdsOf, skipOf, upsertHunks } from "./units.js";
import { upcastUnitPatch } from "./upcast.js";

/**
 * Unit patching without state reconstruction.
 *
 * A patch may replace a unit's hunk list (`hunks`) or edit it in place
 * (`addHunks`, an upsert by id, and `removeHunkIds`), so an incremental run
 * never has to rebuild a unit's full list just to attach one new hunk or mark
 * one as the heart. Several patches can go in one batch (`set-units`); the
 * batch is validated as a whole against the state it would produce and written
 * as one append, so it lands entirely or not at all. The event written always
 * carries the full `hunks` list the unit ends up with.
 *
 * Pure: takes the current state, returns the events to append (or throws with
 * every problem found, so one retry can fix them all).
 */

export interface UnitPatchRequest {
  unitId: string;
  /** the raw JSON payload: a full unit (create) or a partial patch */
  payload: unknown;
  /** recorded on any classification-corrected event the patch causes */
  note?: string;
}

export interface PlannedUnitPatches {
  events: NewEvent[];
  warnings: string[];
  /** the unit ids patched, in request order */
  unitIds: string[];
}

/**
 * Resolve a hunk reference — a full id, or a unique prefix of at least
 * MIN_PREFIX_LEN chars (the short ids `units`/`changes` print) — against
 * `pool`. Returns undefined when it matches nothing or more than one id.
 */
export function resolveHunkRef(ref: string, pool: Iterable<string>): string | undefined {
  const ids = [...pool];
  if (ids.includes(ref)) return ref;
  if (ref.length < MIN_PREFIX_LEN) return undefined;
  const hits = ids.filter((id) => id.startsWith(ref));
  return hits.length === 1 ? hits[0] : undefined;
}

function asStringArray(v: unknown, field: string, unitId: string, errors: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    errors.push(`unit "${unitId}": \`${field}\` must be an array of hunk ids`);
    return undefined;
  }
  return v as string[];
}

/** A raw entry list (ids or `{id, ...}` objects) as entries; shape errors are reported per item. */
function asEntryList(v: unknown, field: string, unitId: string, errors: string[]): HunkEntry[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    errors.push(`unit "${unitId}": \`${field}\` must be an array of hunk ids or {"id": ..., "label": ..., "skip": true, "heart": [...]} entries`);
    return undefined;
  }
  const out: HunkEntry[] = [];
  for (const [i, item] of v.entries()) {
    if (typeof item === "string") out.push({ id: item });
    else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      out.push(item as HunkEntry);
    } else {
      errors.push(`unit "${unitId}": ${field}[${i}] must be a hunk id or {"id": "<hunk id>", ...}`);
    }
  }
  return out;
}

export function planUnitPatches(state: State, requests: UnitPatchRequest[]): PlannedUnitPatches {
  const errors: string[] = [];
  const warnings: string[] = [];
  const revisionIds = new Set(Object.keys(state.hunks));
  const generatedIds = new Set(state.units.filter(isGeneratedUnit).flatMap(hunkIdsOf));
  const seen = new Set<string>();
  // unitId -> the hunk ids it will hold after the batch (patched units only)
  const finalHunks = new Map<string, string[]>();
  const planned: { unitId: string; patch: ReviewUnitPatch; existing?: ReviewUnit; note?: string }[] = [];

  for (const req of requests) {
    const unitId = req.unitId;
    if (seen.has(unitId)) {
      errors.push(`unit "${unitId}" is patched twice in one batch; merge the two patches into one`);
      continue;
    }
    seen.add(unitId);
    if (unitId === GENERATED_UNIT_ID) {
      errors.push(
        `unit "${unitId}" is Purview's own unit for generated files and lockfiles; it is rebuilt ` +
          `automatically and cannot be patched`,
      );
      continue;
    }
    if (!req.payload || typeof req.payload !== "object" || Array.isArray(req.payload)) {
      errors.push(`unit "${unitId}": the patch must be a JSON object`);
      continue;
    }
    const existing = state.units.find((u) => u.id === unitId);
    // A patch in an older shape is brought to the current one first (see upcast.ts).
    const { addHunks: addRaw, removeHunkIds: removeRaw, note: _note, ...rest } = upcastUnitPatch(
      req.payload,
      existing,
    ) as Record<string, unknown>;
    void _note;
    delete rest.riskFlags;
    const add = asEntryList(addRaw, "addHunks", unitId, errors);
    const remove = asStringArray(removeRaw, "removeHunkIds", unitId, errors);
    if (rest.hunks !== undefined && (add !== undefined || remove !== undefined)) {
      errors.push(
        `unit "${unitId}": send either \`hunks\` (replaces the list) or \`addHunks\`/\`removeHunkIds\` (edit it), not both`,
      );
      continue;
    }
    const base = existing?.hunks ?? [];
    const baseIds = hunkIdsOf({ hunks: base });

    // Every reference is resolved to a full id before anything is stored:
    // the short ids `units`/`changes` print are accepted everywhere.
    const resolveList = <T extends { id: string }>(refs: T[], field: string, pool: Iterable<string>): T[] => {
      const out: T[] = [];
      for (const ref of refs) {
        const id = resolveHunkRef(ref.id, pool);
        if (id === undefined) {
          errors.push(
            `unit "${unitId}": ${field} "${ref.id}" is not a hunk of revision ${state.currentRevision}` +
              (ref.id.length < MIN_PREFIX_LEN ? ` (a short id needs at least ${MIN_PREFIX_LEN} chars)` : " (or the prefix is ambiguous)"),
          );
        } else out.push({ ...ref, id });
      }
      return out;
    };

    let hunks: HunkEntry[] | undefined;
    const sent = asEntryList(rest.hunks, "hunks", unitId, errors);
    if (sent !== undefined) {
      hunks = resolveList(sent, "hunks entry", new Set([...revisionIds, ...baseIds]));
    }
    if (add !== undefined || remove !== undefined) {
      let next = [...base];
      if (remove) {
        const refs = remove.map((id) => ({ id }));
        for (const { id } of resolveList(refs, "removeHunkIds entry", new Set([...baseIds, ...revisionIds]))) {
          if (!next.some((h) => h.id === id)) warnings.push(`warning: unit ${unitId} did not hold ${id}; nothing to remove`);
          next = next.filter((h) => h.id !== id);
        }
      }
      if (add) {
        const entries = resolveList(add, "addHunks entry", revisionIds);
        for (const e of entries) {
          const had = next.find((h) => h.id === e.id);
          const bare = !e.label && !e.skip && !e.heart && !e.signals;
          if (had && bare && (had.label || had.skip || had.heart || had.signals)) {
            warnings.push(`warning: unit ${unitId} already held ${e.id}; its label, skip, heart and signals were cleared`);
          } else if (had && bare) warnings.push(`warning: unit ${unitId} already holds ${e.id}`);
        }
        next = upsertHunks(next, entries);
      }
      hunks = next;
    }
    const payload: Record<string, unknown> = hunks !== undefined ? { ...rest, hunks } : rest;

    if (hunks) {
      const ids = hunkIdsOf({ hunks });
      // A hunk the unit did not hold before must belong to this revision.
      const gen = ids.filter((id) => generatedIds.has(id));
      if (gen.length > 0) {
        errors.push(
          `unit "${unitId}": ${gen.length} hunk id(s) belong to generated files, which Purview keeps in ` +
            `its "${GENERATED_UNIT_ID}" unit (leave them out): ${gen.join(", ")}`,
        );
      }
      const unknown = ids.filter((id) => !baseIds.includes(id) && !revisionIds.has(id));
      if (unknown.length > 0) {
        errors.push(
          `unit "${unitId}": ${unknown.length} hunk id(s) not in revision ${state.currentRevision}: ${unknown.join(", ")}`,
        );
      }
      // The list's own rules (see `hunkListIssues`) are judged on the list
      // the unit will hold.
      for (const issue of hunkListIssues(hunks)) errors.push(`unit "${unitId}": ${issue}`);
    }

    let patch: ReviewUnitPatch;
    if (!existing) {
      const result = NewReviewUnitSchema.safeParse({ ...payload, id: unitId });
      if (!result.success) {
        const fields = [
          ...new Set(result.error.issues.map((i) => i.path.join(".") || "(root)").filter((p) => p !== "id")),
        ];
        errors.push(
          `Unit "${unitId}" does not exist yet; creating a new unit requires ` +
            `the full ReviewUnit schema. Missing/invalid field(s): ${fields.join(", ")}`,
        );
        continue;
      }
      patch = result.data;
    } else {
      const result = ReviewUnitPatchSchema.safeParse(payload);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        errors.push(`unit "${unitId}": invalid patch — ${issues.join("; ")}`);
        continue;
      }
      patch = result.data;
    }
    patch.riskFlags = derivedRiskFlags({ hunks: patch.hunks ?? existing?.hunks ?? [], riskFlags: existing?.riskFlags ?? [] });
    if (patch.hunks) finalHunks.set(unitId, hunkIdsOf({ hunks: patch.hunks }));
    planned.push({ unitId, patch, existing, note: req.note });
  }

  // Ownership is checked on the state the whole batch produces, so moving a
  // hunk between two units is fine in either order as long as the batch also
  // takes it out of its old unit.
  if (errors.length === 0 && finalHunks.size > 0) {
    const owners = new Map<string, string[]>();
    const units = [
      ...state.units.map((u) => ({ id: u.id, hunkIds: finalHunks.get(u.id) ?? hunkIdsOf(u) })),
      ...[...finalHunks].filter(([id]) => !state.units.some((u) => u.id === id)).map(([id, hunkIds]) => ({ id, hunkIds })),
    ];
    for (const u of units) {
      for (const h of u.hunkIds) owners.set(h, [...(owners.get(h) ?? []), u.id]);
    }
    const clashes = [...owners].filter(
      ([h, list]) => list.length > 1 && list.some((id) => finalHunks.get(id)?.includes(h)),
    );
    if (clashes.length > 0) {
      errors.push(
        `${clashes.length} hunk id(s) would belong to more than one unit; each hunk belongs to exactly ` +
          `one (to move one, remove it from its current unit in the same batch, e.g. ` +
          `{"id": "<old unit>", "removeHunkIds": [...]}):\n  ` +
          clashes.map(([h, list]) => `${h}: ${list.join(", ")}`).join("\n  "),
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      (requests.length > 1 ? "Nothing was written. " : "") + errors.join("\n"),
    );
  }

  const events: NewEvent[] = [];
  for (const { unitId, patch, existing, note } of planned) {
    events.push({ type: "unit-updated", unitId, patch });
    if (existing && patch.kind && patch.kind !== existing.kind) {
      for (const hunkId of hunkIdsOf(existing)) {
        events.push({ type: "classification-corrected", hunkId, from: existing.kind, to: patch.kind, note: note ?? "" });
      }
    }
    if (existing && patch.attention && patch.attention !== existing.attention) {
      for (const hunkId of hunkIdsOf(existing)) {
        events.push({
          type: "classification-corrected",
          hunkId,
          from: existing.attention,
          to: patch.attention,
          note: note ?? "",
        });
      }
    }
  }
  return { events, warnings, unitIds: planned.map((p) => p.unitId) };
}

/* ------------------------------------------------------------ short ids */

/** Printed length of a short hunk id. */
export const SHORT_ID_LEN = 8;

/**
 * `id -> printable id`: its first SHORT_ID_LEN chars when that prefix names
 * exactly one id in `pool` (so it resolves back through `show` and the patch
 * commands), the full id otherwise (e.g. `#2` duplicates and their siblings).
 */
export function shortIds(pool: Iterable<string>): (id: string) => string {
  const ids = [...new Set(pool)];
  const counts = new Map<string, number>();
  for (const id of ids) {
    const p = id.slice(0, SHORT_ID_LEN);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return (id) => {
    const p = id.slice(0, SHORT_ID_LEN);
    return !id.includes("#") && counts.get(p) === 1 ? p : id;
  };
}

/** `path: id,id; path: id` — a unit's hunks grouped by file, in file order. */
export function hunkIdsByFile(
  hunkIds: readonly string[],
  files: readonly { path: string; hunkIds: string[] }[],
  short: (id: string) => string,
): { path: string; ids: string[] }[] {
  const want = new Set(hunkIds);
  const out: { path: string; ids: string[] }[] = [];
  const placed = new Set<string>();
  for (const f of files) {
    const ids = f.hunkIds.filter((id) => want.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => placed.add(id));
    out.push({ path: f.path, ids: ids.map(short) });
  }
  const stray = hunkIds.filter((id) => !placed.has(id));
  if (stray.length > 0) out.push({ path: "(not in this revision)", ids: stray });
  return out;
}

/* --------------------------------------------------------------- `units` */

/** What `reviewer-state units` prints: one compact block per unit. */
export function renderUnits(
  state: Pick<State, "units" | "files" | "currentRevision">,
  unitIds: string[] = [],
): { text: string; unknown: string[] } {
  const short = shortIds(state.files.flatMap((f) => f.hunkIds));
  const unknown = unitIds.filter((id) => !state.units.some((u) => u.id === id));
  const units = [...state.units]
    .filter((u) => unitIds.length === 0 || unitIds.includes(u.id))
    .sort((a, b) => a.order - b.order);
  if (units.length === 0) return { text: unitIds.length ? "" : "No units yet.\n", unknown };
  const out: string[] = [];
  for (const u of units) {
    const ids = hunkIdsOf(u);
    if (isGeneratedUnit(u)) {
      // Purview's own: listed so the hunks read as owned, never to be patched.
      const files = hunkIdsByFile(ids, state.files, short).map((g) => g.path);
      out.push(
        `${u.id}  [${u.attention}]  ${u.title}  (${ids.length} hunks; Purview's, not patchable)`,
        `    ${files.join(", ")}`,
      );
      continue;
    }
    const husk = isRemovedUnit(u) && ids.length === 0;
    const findings = u.findings?.length ?? 0;
    const heart = heartOf(u);
    const skip = skipOf(u);
    const labelled = u.hunks.filter((h) => h.label && !h.skip).length;
    const heartIds = heart.map(
      (h) => short(h.id) + (h.segments.some((s) => s.lines) ? `:${h.segments.map((s) => (s.lines ? `${s.lines[0]}-${s.lines[1]}` : "all")).join(",")}` : ""),
    );
    out.push(
      `${husk ? "~ " : ""}${u.id}  [${u.attention}/${u.kind}]  ${u.title}` +
        `  (${ids.length} hunk${ids.length === 1 ? "" : "s"}` +
        (heart.length ? `, ${heart.length} heart` : "") +
        (skip.length ? `, ${skip.length} skippable` : "") +
        (labelled ? `, ${labelled} labelled` : "") +
        (findings ? `, ${findings} finding${findings === 1 ? "" : "s"}` : "") +
        (heart.length ? `, heart: ${heartIds.join(" ")}` : "") +
        (skip.length ? `, skip: ${skip.map((h) => short(h.id)).join(" ")}` : "") +
        (husk ? `; husk: every hunk left the PR in r${u.removedAtRevision}` : "") +
        ")",
    );
    for (const g of hunkIdsByFile(ids, state.files, short)) {
      out.push(`    ${g.path}: ${g.ids.join(" ")}`);
    }
  }
  return { text: out.join("\n") + "\n", unknown };
}

/* ------------------------------------------------------- what remains */

export interface RemainingWork {
  revision: number;
  /** hunks in no unit and not explicitly unassigned */
  needsClassification: { id: string; file: string }[];
  /** live units `changes` lists that no patch touched since this revision/run began; undefined when there is no migration to compare */
  unpatchedChanged?: { id: string; title: string }[];
}

/** Hunk ids of the current revision in no unit and not explicitly unassigned. */
export function needsClassification(state: Pick<State, "units" | "unassignedHunkIds" | "files">): {
  id: string;
  file: string;
}[] {
  const assigned = new Set([...state.units.flatMap(hunkIdsOf), ...state.unassignedHunkIds]);
  return state.files.flatMap((f) => f.hunkIds.filter((id) => !assigned.has(id)).map((id) => ({ id, file: f.path })));
}

/**
 * What is left after a write: hunks still needing classification, and the
 * units `changes` lists that were not patched since the current revision was
 * added (or since the latest analysis run started, whichever is later).
 */
export function remainingWork(
  state: State,
  events: ReviewerEvent[],
  files: { previous?: FileDiff[]; current?: FileDiff[] },
): RemainingWork {
  const out: RemainingWork = { revision: state.currentRevision, needsClassification: needsClassification(state) };
  const report = state.lastMigration;
  if (!report || report.revision !== state.currentRevision) return out;
  let since = -1;
  events.forEach((e, i) => {
    if (e.type === "revision-added" && e.revision === state.currentRevision) since = i;
    if (e.type === "analysis-started" && e.revision === state.currentRevision) since = Math.max(since, i);
  });
  const patched = new Set<string>();
  let fullAnalysis = false;
  events.slice(since + 1).forEach((e) => {
    if (e.type === "unit-updated") patched.add(e.unitId);
    if (e.type === "analysis-set") fullAnalysis = true;
  });
  if (fullAnalysis) {
    out.unpatchedChanged = [];
    return out;
  }
  out.unpatchedChanged = changedUnits(state, report, {
    previousFiles: files.previous,
    currentFiles: files.current,
  })
    .filter((c) => !patched.has(c.unit.id))
    .map((c) => ({ id: c.unit.id, title: c.unit.title }));
  return out;
}

export function formatRemaining(rw: RemainingWork): string {
  const lines: string[] = [];
  const n = rw.needsClassification.length;
  if (n === 0) lines.push("All hunks assigned (each is in a unit or explicitly unassigned).");
  else {
    const short = shortIds(rw.needsClassification.map((h) => h.id));
    const shown = rw.needsClassification.slice(0, 40);
    lines.push(`Still needs classification (${n}): ` + shown.map((h) => `${short(h.id)} ${h.file}`).join("; ") + (n > shown.length ? `; … ${n - shown.length} more` : ""));
  }
  if (rw.unpatchedChanged !== undefined) {
    const u = rw.unpatchedChanged;
    lines.push(
      u.length === 0
        ? "Every unit `changes` lists has been patched this revision."
        : `Changed units not patched yet this revision (${u.length}): ` + u.map((x) => x.id).join(", "),
    );
  }
  return lines.join("\n");
}
