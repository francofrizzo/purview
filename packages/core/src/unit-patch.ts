import { changedUnits } from "./changes.js";
import { MIN_PREFIX_LEN } from "./hunk-select.js";
import { isRemovedUnit } from "./schemas.js";
import type { FileDiff, NewEvent, ReviewUnit, ReviewUnitPatch, ReviewerEvent, State } from "./schemas.js";
import { NewReviewUnitSchema, ReviewUnitPatchSchema } from "./schemas.js";

/**
 * Unit patching without state reconstruction.
 *
 * A patch may replace a unit's hunk list (`hunkIds`) or edit it in place
 * (`addHunkIds` / `removeHunkIds`), so an incremental run never has to rebuild
 * a unit's full list just to attach one new hunk. Several patches can go in one
 * batch (`set-units`); the batch is validated as a whole against the state it
 * would produce and written as one append, so it lands entirely or not at all.
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

export function planUnitPatches(state: State, requests: UnitPatchRequest[]): PlannedUnitPatches {
  const errors: string[] = [];
  const warnings: string[] = [];
  const revisionIds = new Set(Object.keys(state.hunks));
  const seen = new Set<string>();
  // unitId -> the hunk list it will hold after the batch (patched units only)
  const finalHunks = new Map<string, string[]>();
  const planned: { unitId: string; patch: ReviewUnitPatch; existing?: ReviewUnit; note?: string }[] = [];

  for (const req of requests) {
    const unitId = req.unitId;
    if (seen.has(unitId)) {
      errors.push(`unit "${unitId}" is patched twice in one batch; merge the two patches into one`);
      continue;
    }
    seen.add(unitId);
    if (!req.payload || typeof req.payload !== "object" || Array.isArray(req.payload)) {
      errors.push(`unit "${unitId}": the patch must be a JSON object`);
      continue;
    }
    const { addHunkIds: addRaw, removeHunkIds: removeRaw, note: _note, ...rest } = req.payload as Record<
      string,
      unknown
    >;
    void _note;
    const add = asStringArray(addRaw, "addHunkIds", unitId, errors);
    const remove = asStringArray(removeRaw, "removeHunkIds", unitId, errors);
    if (rest.hunkIds !== undefined && (add !== undefined || remove !== undefined)) {
      errors.push(
        `unit "${unitId}": send either \`hunkIds\` (replaces the list) or \`addHunkIds\`/\`removeHunkIds\` (edit it), not both`,
      );
      continue;
    }
    const existing = state.units.find((u) => u.id === unitId);
    const base = existing?.hunkIds ?? [];

    // Every reference is resolved to a full id before anything is stored:
    // the short ids `units`/`changes` print are accepted everywhere.
    const resolveList = (refs: string[], field: string, pool: Iterable<string>): string[] => {
      const out: string[] = [];
      for (const ref of refs) {
        const id = resolveHunkRef(ref, pool);
        if (id === undefined) {
          errors.push(
            `unit "${unitId}": ${field} "${ref}" is not a hunk of revision ${state.currentRevision}` +
              (ref.length < MIN_PREFIX_LEN ? ` (a short id needs at least ${MIN_PREFIX_LEN} chars)` : " (or the prefix is ambiguous)"),
          );
        } else out.push(id);
      }
      return out;
    };

    let hunkIds: string[] | undefined;
    if (Array.isArray(rest.hunkIds) && rest.hunkIds.every((x) => typeof x === "string")) {
      hunkIds = resolveList(rest.hunkIds as string[], "hunkIds entry", new Set([...revisionIds, ...base]));
    }
    if (add !== undefined || remove !== undefined) {
      let next = [...base];
      if (remove) {
        for (const id of resolveList(remove, "removeHunkIds entry", new Set([...base, ...revisionIds]))) {
          if (!next.includes(id)) warnings.push(`warning: unit ${unitId} did not hold ${id}; nothing to remove`);
          next = next.filter((h) => h !== id);
        }
      }
      if (add) {
        for (const id of resolveList(add, "addHunkIds entry", revisionIds)) {
          if (next.includes(id)) warnings.push(`warning: unit ${unitId} already holds ${id}`);
          else next.push(id);
        }
      }
      hunkIds = next;
    }
    const payload = hunkIds !== undefined ? { ...rest, hunkIds } : rest;

    // A hunk the unit did not hold before must belong to this revision.
    if (hunkIds) {
      const unknown = hunkIds.filter((id) => !base.includes(id) && !revisionIds.has(id));
      if (unknown.length > 0) {
        errors.push(
          `unit "${unitId}": ${unknown.length} hunk id(s) not in revision ${state.currentRevision}: ${unknown.join(", ")}`,
        );
      }
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
    if (patch.hunkIds) finalHunks.set(unitId, patch.hunkIds);
    planned.push({ unitId, patch, existing, note: req.note });
  }

  // Ownership is checked on the state the whole batch produces, so moving a
  // hunk between two units is fine in either order as long as the batch also
  // takes it out of its old unit.
  if (errors.length === 0 && finalHunks.size > 0) {
    const owners = new Map<string, string[]>();
    const units = [
      ...state.units.map((u) => ({ id: u.id, hunkIds: finalHunks.get(u.id) ?? u.hunkIds })),
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
      for (const hunkId of existing.hunkIds) {
        events.push({ type: "classification-corrected", hunkId, from: existing.kind, to: patch.kind, note: note ?? "" });
      }
    }
    if (existing && patch.attention && patch.attention !== existing.attention) {
      for (const hunkId of existing.hunkIds) {
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
    const husk = isRemovedUnit(u) && u.hunkIds.length === 0;
    const findings = u.findings?.length ?? 0;
    out.push(
      `${husk ? "~ " : ""}${u.id}  [${u.attention}/${u.kind}]  ${u.title}` +
        `  (${u.hunkIds.length} hunk${u.hunkIds.length === 1 ? "" : "s"}` +
        (findings ? `, ${findings} finding${findings === 1 ? "" : "s"}` : "") +
        (husk ? `; husk: every hunk left the PR in r${u.removedAtRevision}` : "") +
        ")",
    );
    for (const g of hunkIdsByFile(u.hunkIds, state.files, short)) {
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
  const assigned = new Set([...state.units.flatMap((u) => u.hunkIds), ...state.unassignedHunkIds]);
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
