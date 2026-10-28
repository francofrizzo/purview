import { MIN_PREFIX_LEN } from "./hunk-select.js";
import type { ReviewUnit } from "./schemas.js";

/**
 * The event upcaster: every persisted event (events.jsonl) and every incoming
 * analysis or unit-patch payload passes through here before schema
 * validation, so the schema only ever describes the current shape and nothing
 * downstream (reducer, service, web) handles a legacy field.
 *
 * Rules:
 *  1. A schema change is one new step here plus a STATE_SHAPE_VERSION bump —
 *     never an alias or a fallback in the schema, the reducer or the service.
 *  2. Each step rewrites one old shape to the next, carries a test with a
 *     literal event from its era (test/upcast.test.ts), and is frozen once
 *     shipped: a later change is a later step, not an edit to this one.
 *  3. The event log is append-only and never rewritten. state.json is a
 *     derived snapshot: when the version goes up it is rebuilt from the log
 *     through the steps below.
 *
 * Steps touch only the events and fields they know; an already-current
 * object passes through as the same object.
 */

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

/** A full id, or a unique prefix of at least MIN_PREFIX_LEN chars, among `ids`. */
function matchId(ref: string, ids: readonly string[]): string | undefined {
  if (ids.includes(ref)) return ref;
  if (ref.length < MIN_PREFIX_LEN) return undefined;
  const hits = ids.filter((id) => id.startsWith(ref));
  return hits.length === 1 ? hits[0] : undefined;
}

interface Step {
  /** the shape it reads and the version that stopped writing it */
  bridges: string;
  unit(raw: Raw): Raw;
  patch(raw: Raw, existing?: ReviewUnit): Raw;
}

/* ------------------------------------------------------------- step 1 */

/**
 * `fold` on a unit or patch becomes `skip` when `skip` is absent, then goes
 * (the first name of the skip list; one day of logs, 2026.10.19, carries it).
 */
function foldToSkip(raw: Raw): Raw {
  if (!("fold" in raw)) return raw;
  const out = { ...raw };
  if (out.skip === undefined && out.fold !== undefined) out.skip = out.fold;
  delete out.fold;
  return out;
}

const foldStep: Step = {
  bridges: "fold -> skip (units written up to 2026.10.19)",
  unit: foldToSkip,
  patch: foldToSkip,
};

/* ------------------------------------------------------------- step 2 */

type LegacyPointer = { hunkId: string; why?: unknown; lines?: unknown };
type Entry = Raw & { id: string };

/**
 * What a legacy `heart`/`skip` pointer `{hunkId, why, lines}` says about its
 * hunk, in the current entry shape: a heart is one segment `{why, lines?}`,
 * a skip is `skip: true` with the why as label.
 */
function legacyEntries(list: unknown, role: "heart" | "skip"): Entry[] {
  if (!Array.isArray(list)) return [];
  const out: Entry[] = [];
  for (const item of list) {
    if (!isObject(item) || !isString(item.hunkId)) continue;
    const p = item as LegacyPointer;
    const why = isString(p.why) && p.why.length > 0 ? p.why : undefined;
    if (role === "heart") {
      const segment: Raw = { why: why ?? "(no why recorded)" };
      if (p.lines !== undefined) segment.lines = p.lines;
      out.push({ id: p.hunkId, heart: [segment] });
    } else {
      const entry: Entry = { id: p.hunkId, skip: true };
      if (why) entry.label = why;
      out.push(entry);
    }
  }
  return out;
}

/** `entry` with what `claim` (a legacy pointer's reading) says, that role replacing the other. */
function withClaim(entry: Raw, claim: Entry, role: "heart" | "skip"): Entry {
  const merged: Entry = { ...entry, ...claim, id: claim.id };
  if (role === "heart") delete merged.skip;
  else delete merged.heart;
  return merged;
}

/** Bare ids and entries as one list of entries (an unreadable item is kept as is). */
function entriesOf(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (isString(x) ? { id: x } : x));
}

const idOf = (x: unknown): string | undefined => (isObject(x) && isString(x.id) ? x.id : undefined);

/**
 * `hunkIds` + `heart` + `skip` on a unit become one `hunks` list: the ids in
 * order, then each heart pointer puts a one-segment `heart` on its entry (its
 * `why`, its `lines`) and each skip pointer sets `skip: true` with its `why`
 * as the label. A heart or skip id outside `hunkIds` is appended (the old
 * validator refused it; replay is lenient). Shipped as 2026.10.19.1.
 */
function pointersToHunks(raw: Raw): Raw {
  if ("hunks" in raw) return raw;
  if (!("hunkIds" in raw) && !("heart" in raw) && !("skip" in raw)) return raw;
  const ids = Array.isArray(raw.hunkIds) ? raw.hunkIds.filter(isString) : [];
  const hunks: Entry[] = ids.map((id) => ({ id }));
  for (const role of ["heart", "skip"] as const) {
    for (const e of legacyEntries(raw[role], role)) {
      const id = matchId(e.id, ids) ?? e.id;
      const at = hunks.findIndex((h) => h.id === id);
      if (at === -1) hunks.push({ ...e, id });
      else if (!hunks[at].heart && !hunks[at].skip) hunks[at] = withClaim(hunks[at], { ...e, id }, role);
    }
  }
  const out: Raw = { ...raw, hunks };
  delete out.hunkIds;
  delete out.heart;
  delete out.skip;
  return out;
}

/**
 * The same on a patch: `hunkIds` -> `hunks`, `addHunkIds` -> `addHunks`
 * (`removeHunkIds` keeps its name). A legacy `heart` or `skip` list replaced
 * the unit's whole list of that kind, so it becomes: the claim set on the
 * entries it names, and cleared from the unit's other entries carrying it.
 * With `hunks` in the patch that is applied to the new list; with the
 * existing unit it is an `addHunks` upsert of every affected entry. Without
 * either (a replayed event: the log carries no unit) the upsert names only
 * the entries that gain the claim; nothing else can be cleared, and the list
 * is never replaced, so membership is kept.
 */
function pointersToPatch(raw: Raw, existing?: ReviewUnit): Raw {
  const legacy = ["hunkIds", "addHunkIds", "heart", "skip"].some((k) => k in raw);
  if (!legacy) return raw;
  const out = { ...raw };
  if ("hunkIds" in out) {
    if (out.hunks === undefined) out.hunks = out.hunkIds;
    delete out.hunkIds;
  }
  if ("addHunkIds" in out) {
    if (out.addHunks === undefined) out.addHunks = out.addHunkIds;
    delete out.addHunkIds;
  }
  const sent = (["heart", "skip"] as const).filter((role) => Array.isArray(out[role]));
  const named = Object.fromEntries(sent.map((role) => [role, legacyEntries(out[role], role)])) as Record<
    "heart" | "skip",
    Entry[] | undefined
  >;
  delete out.heart;
  delete out.skip;
  if (sent.length === 0) return out;

  const clear = (entry: Raw, role: "heart" | "skip"): Raw => {
    const plain = { ...entry };
    delete plain[role];
    if (role === "skip") delete plain.label;
    return plain;
  };

  if (Array.isArray(out.hunks)) {
    // Applied to the list the patch sends.
    const list = entriesOf(out.hunks);
    const ids = list.map(idOf).filter(isString);
    for (const role of sent) {
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        if (isObject(h) && h[role] !== undefined) list[i] = clear(h, role);
      }
      for (const e of named[role] ?? []) {
        const id = matchId(e.id, ids) ?? e.id;
        const at = list.findIndex((h) => idOf(h) === id);
        const merged = withClaim(at === -1 ? {} : (list[at] as Raw), { ...e, id }, role);
        if (at === -1) list.push(merged);
        else list[at] = merged;
      }
    }
    out.hunks = list;
    return out;
  }

  // An upsert of every entry whose claim changes, judged on the existing unit.
  const known = existing?.hunks ?? [];
  const knownIds = known.map((h) => h.id);
  const upserts: Entry[] = [];
  for (const role of sent) {
    const entries = (named[role] ?? []).map((e) => ({ ...e, id: matchId(e.id, knownIds) ?? e.id }));
    const namedIds = new Set(entries.map((e) => e.id));
    for (const h of known) {
      if (h[role] !== undefined && !namedIds.has(h.id)) upserts.push(clear(h as unknown as Raw, role) as Entry);
    }
    for (const e of entries) {
      const had = upserts.find((u) => u.id === e.id) ?? known.find((h) => h.id === e.id);
      const merged = withClaim(had ? (had as unknown as Raw) : {}, e, role);
      const at = upserts.findIndex((u) => u.id === e.id);
      if (at === -1) upserts.push(merged);
      else upserts[at] = merged;
    }
  }
  const touched = new Set(upserts.map((e) => e.id));
  const add = entriesOf(out.addHunks).filter((h) => {
    const id = idOf(h);
    return id === undefined || !touched.has(id);
  });
  out.addHunks = [...add, ...upserts];
  return out;
}

const hunkEntriesStep: Step = {
  bridges: "hunkIds/heart/skip -> hunks (units written up to 2026.10.19.1)",
  unit: pointersToHunks,
  patch: pointersToPatch,
};

/* ------------------------------------------------------------- step 3 */

/**
 * An entry of the intermediate `hunks` shape, `{id, role, label, lines}`
 * (never shipped as a version, but state.json snapshots were rebuilt with it
 * and an event may carry it), in the current shape: `role: "heart"` is a
 * one-segment `heart` whose why is the label; `role: "skip"` is `skip: true`
 * with the label kept; no role leaves the entry as it is. `role` goes.
 */
function roleToClaim(entry: unknown): unknown {
  if (!isObject(entry) || !("role" in entry)) return entry;
  const out: Raw = { ...entry };
  const role = out.role;
  delete out.role;
  if (role === "heart") {
    const segment: Raw = { why: isString(out.label) && out.label ? out.label : "(no why recorded)" };
    if (out.lines !== undefined) segment.lines = out.lines;
    delete out.label;
    delete out.lines;
    out.heart = [segment];
  } else if (role === "skip") {
    out.skip = true;
    delete out.lines;
  } else {
    delete out.lines;
  }
  return out;
}

/** `raw` with `raw[field]`'s entries mapped through `roleToClaim`; the same object when none changed. */
function mapEntries(raw: Raw, field: string): Raw {
  const list = raw[field];
  if (!Array.isArray(list)) return raw;
  let changed = false;
  const next = list.map((e) => {
    const m = roleToClaim(e);
    if (m !== e) changed = true;
    return m;
  });
  return changed ? { ...raw, [field]: next } : raw;
}

const roleStep: Step = {
  bridges: "hunks entries with `role` -> label/skip/heart (an unshipped intermediate of 2026.10.19)",
  unit: (raw) => mapEntries(raw, "hunks"),
  patch: (raw) => mapEntries(mapEntries(raw, "hunks"), "addHunks"),
};

/* ------------------------------------------------------------- step 4 */

/** Current signals win a collision; legacy risks are always removed. */
function risksToSignals(raw: Raw, field: string): Raw {
  const list = raw[field];
  if (!Array.isArray(list)) return raw;
  let changed = false;
  const next = list.map((entry) => {
    if (!isObject(entry) || !("risks" in entry)) return entry;
    changed = true;
    const out = { ...entry };
    if (out.signals === undefined) out.signals = out.risks;
    delete out.risks;
    return out;
  });
  return changed ? { ...raw, [field]: next } : raw;
}

const signalsStep: Step = {
  bridges: "hunk risks -> signals (state shape 8)",
  unit: (raw) => risksToSignals(raw, "hunks"),
  patch: (raw) => risksToSignals(risksToSignals(raw, "hunks"), "addHunks"),
};

/* ------------------------------------------------------------- the order */

/** Every step, oldest shape first. Append; never reorder or edit a shipped one. */
const STEPS: readonly Step[] = [foldStep, hunkEntriesStep, roleStep, signalsStep];

function upcastUnit(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return STEPS.reduce<Raw>((u, step) => step.unit(u), raw);
}

/** `raw` with each of `raw.units` upcast; the same object when none changed. */
function upcastUnitsOf(raw: Raw): Raw {
  if (!Array.isArray(raw.units)) return raw;
  let changed = false;
  const units = raw.units.map((u) => {
    const next = upcastUnit(u);
    if (next !== u) changed = true;
    return next;
  });
  return changed ? { ...raw, units } : raw;
}

/** A raw event of any type, brought to the current shape. */
export function upcastEvent(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  if (raw.type === "analysis-set") return upcastUnitsOf(raw);
  if (raw.type === "unit-updated" && isObject(raw.patch)) {
    const patch = upcastUnitPatch(raw.patch);
    return patch === raw.patch ? raw : { ...raw, patch };
  }
  return raw;
}

/** A raw `set-analysis` payload (`{summary, units, unassigned}`, or any object carrying `units`). */
export function upcastAnalysisPayload(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return upcastUnitsOf(raw);
}

/**
 * A raw unit patch (or a new unit sent through `set-unit`). `existing` is
 * the unit it applies to, when there is one: a legacy role list needs it to
 * know which entries lose the role.
 */
export function upcastUnitPatch(raw: unknown, existing?: ReviewUnit): unknown {
  if (!isObject(raw)) return raw;
  return STEPS.reduce<Raw>((p, step) => step.patch(p, existing), raw);
}
