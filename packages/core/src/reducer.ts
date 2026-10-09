import { STATE_SHAPE_VERSION, isRemovedUnit } from "./schemas.js";
import { GENERATED_UNIT_ID, buildGeneratedUnit, isGeneratedUnit } from "./generated.js";
import type {
  ReviewUnit,
  ReviewUnitPatch,
  ReviewerEvent,
  State,
  HunkState,
  FileRollup,
  UnitChangelogEntry,
} from "./schemas.js";

export function initialState(): State {
  return {
    shapeVersion: STATE_SHAPE_VERSION,
    currentRevision: 0,
    revisions: [],
    summary: "",
    units: [],
    hunks: {},
    files: [],
    unassignedHunkIds: [],
    generated: [],
    archived: [],
    reviewSubmissions: [],
    corrections: [],
  };
}

function freshHunkState(): HunkState {
  return { viewed: false, changedSinceViewed: false };
}

/** A unit given hunks again is no longer a husk. */
function reviveIfPopulated(unit: ReviewUnit): ReviewUnit {
  if (unit.hunkIds.length === 0) return unit;
  if (!isRemovedUnit(unit) && unit.readBeforeRemoval === undefined) return unit;
  const next = { ...unit };
  delete next.removedAtRevision;
  delete next.readBeforeRemoval;
  return next;
}

/**
 * `changelog` with `text` recorded for `revision`: one entry per revision, so
 * a re-run for the same revision replaces its entry instead of adding one.
 * Oldest first.
 */
export function upsertChangelog(
  changelog: UnitChangelogEntry[] | undefined,
  revision: number,
  text: string,
): UnitChangelogEntry[] {
  return [...(changelog ?? []).filter((e) => e.revision !== revision), { revision, text }].sort(
    (a, b) => a.revision - b.revision,
  );
}

/** Merge a unit patch; the patch-only `changelogEntry` lands in `changelog`. */
function applyUnitPatch(unit: ReviewUnit, patch: ReviewUnitPatch, revision: number): ReviewUnit {
  const { changelogEntry, ...fields } = patch;
  const next = { ...unit, ...fields } as ReviewUnit;
  if (changelogEntry) next.changelog = upsertChangelog(next.changelog, revision, changelogEntry);
  return next;
}

function recomputeRollups(state: State): void {
  state.files = state.files.map((f): FileRollup => {
    const states = f.hunkIds.map((id) => state.hunks[id] ?? freshHunkState());
    const viewedCount = states.filter((s) => s.viewed).length;
    return {
      ...f,
      total: f.hunkIds.length,
      viewedCount,
      viewed: f.hunkIds.length > 0 && viewedCount === f.hunkIds.length,
      changedSinceViewed: states.some((s) => s.changedSinceViewed),
    };
  });
}

/**
 * Re-establish the generated-unit invariant on `state` (in place): every hunk
 * of the current revision's generated files (`state.generated`) sits in the
 * one fixed `generated` unit, placed last, and nowhere else — not in another
 * unit, not in `unassignedHunkIds`. The unit is rebuilt from scratch each
 * time, so it can never drift, become a husk, or carry analysis fields; with
 * no generated hunks it does not exist.
 *
 * A unit that only ever held generated hunks (an analysis written before this
 * existed grouped the lockfiles itself) is dropped rather than left empty. A
 * hunk that stops being generated simply leaves the unit: it is then in no
 * unit, exactly like a new hunk, so the incremental analysis classifies it.
 */
function applyGenerated(state: State): void {
  const paths = new Set(state.generated.map((g) => g.path));
  const genIds: string[] = [];
  for (const f of state.files) if (paths.has(f.path)) genIds.push(...f.hunkIds);
  const gen = new Set(genIds);

  const others: ReviewUnit[] = [];
  for (const u of state.units) {
    if (isGeneratedUnit(u)) continue;
    if (isRemovedUnit(u) || !u.hunkIds.some((id) => gen.has(id))) {
      others.push(u);
      continue;
    }
    const hunkIds = u.hunkIds.filter((id) => !gen.has(id));
    if (hunkIds.length > 0) others.push({ ...u, hunkIds });
  }
  if (genIds.length > 0) {
    const order = others.reduce((m, u) => Math.max(m, u.order + 1), 0);
    others.push(buildGeneratedUnit(state.generated, genIds, order));
  }
  state.units = others;
  if (state.unassignedHunkIds.some((id) => gen.has(id))) {
    state.unassignedHunkIds = state.unassignedHunkIds.filter((id) => !gen.has(id));
  }
}

/** A unit as analysis sends it: Purview's own `origin` never comes from there. */
function fromAnalysis<T extends { origin?: unknown }>(unit: T): Omit<T, "origin"> {
  const { origin: _origin, ...rest } = unit;
  void _origin;
  return rest;
}

/** Apply one event to a state, returning a new state (input is not mutated). */
export function applyEvent(prev: State, event: ReviewerEvent): State {
  const state: State = structuredClone(prev);

  switch (event.type) {
    case "pr-initialized": {
      state.pr = {
        host: event.host,
        owner: event.owner,
        repo: event.repo,
        number: event.number,
        url: event.url,
        title: event.title,
      };
      break;
    }

    case "revision-added": {
      state.revisions = state.revisions.filter(
        (r) => r.revision !== event.revision,
      );
      state.revisions.push({
        revision: event.revision,
        baseSha: event.baseSha,
        headSha: event.headSha,
        mergeBase: event.mergeBase,
        baseOnly: event.baseOnly ?? false,
        addedAt: event.ts,
      });
      state.revisions.sort((a, b) => a.revision - b.revision);
      state.currentRevision = event.revision;

      // A husk (see ReviewUnit.removedAtRevision) lives for exactly one
      // revision: the one that emptied it. Any later revision deletes it.
      // Re-adding the *same* revision keeps it, so a replayed event is a no-op.
      state.units = state.units.filter(
        (u) =>
          !(isRemovedUnit(u) && u.hunkIds.length === 0 && u.removedAtRevision !== event.revision),
      );

      const previousHunks = state.hunks;
      const nextHunks: Record<string, HunkState> = {};
      /**
       * old hunk id -> every new hunk whose predecessor it is. Usually one; a
       * containment match (MigrationEntry.match) can give an old hunk several
       * successors — the halves of a split hunk.
       */
      const idRemap = new Map<string, string[]>();
      /**
       * old hunk id -> how it migrated; used for the findings staleness rule.
       * With several successors, any non-identical one wins: the code under
       * the finding moved for at least part of it.
       */
      const statusByOldId = new Map<string, string>();
      const noteStatus = (oldId: string, status: string) => {
        const had = statusByOldId.get(oldId);
        if (had === undefined || had === "identical") statusByOldId.set(oldId, status);
      };

      // Which live unit held each outgoing hunk, so an archived hunk remembers
      // the unit it left (`changedUnits` reads it back).
      const unitOfOldHunk = new Map<string, string>();
      for (const u of state.units) {
        if (isRemovedUnit(u)) continue;
        for (const id of u.hunkIds) unitOfOldHunk.set(id, u.id);
      }

      if (event.migration) {
        for (const entry of event.migration.entries) {
          if (entry.status === "archived") noteStatus(entry.hunkId, "archived");
          else if (entry.previousHunkId) noteStatus(entry.previousHunkId, entry.status);
          if (entry.status === "archived") {
            state.archived.push({
              hunkId: entry.hunkId,
              file: entry.file,
              archivedAtRevision: event.revision,
              wasViewed: entry.wasViewed ?? false,
              unitId: unitOfOldHunk.get(entry.hunkId),
            });
            continue;
          }
          if (entry.status === "new") {
            const s = freshHunkState();
            s.migration = "new";
            if (event.baseOnly) {
              s.defaultAttention = "skip";
              s.defaultAttentionWhy = "base moved";
            }
            nextHunks[entry.hunkId] = s;
            continue;
          }
          const old = entry.previousHunkId
            ? previousHunks[entry.previousHunkId]
            : undefined;
          const carried: HunkState = {
            ...(old ?? freshHunkState()),
            predecessorId: entry.previousHunkId,
            migration: entry.status,
            changedSinceViewed:
              entry.changedSinceViewed ?? old?.changedSinceViewed ?? false,
          };
          // A changed-since-viewed hunk is no longer viewed: the reader saw
          // an earlier version of it, and "viewed" gating (readiness, the
          // progress bar, space-to-next-unviewed) must bring them back. The
          // flag itself stays on so the UI can say *why* it needs a re-read;
          // re-viewing clears both (see "hunk-viewed"). `viewedAtRevision` is
          // kept: it is the baseline the diff-of-diffs view compares against,
          // i.e. the version the reader actually read.
          if (carried.changedSinceViewed && carried.viewed) {
            carried.viewed = false;
          }
          nextHunks[entry.hunkId] = carried;
          if (entry.previousHunkId) {
            const successors = idRemap.get(entry.previousHunkId) ?? [];
            successors.push(entry.hunkId);
            idRemap.set(entry.previousHunkId, successors);
          }
        }
      } else {
        for (const f of event.files) {
          for (const id of f.hunkIds) {
            nextHunks[id] = previousHunks[id] ?? freshHunkState();
          }
        }
      }

      // Any hunk listed in the revision but missing from the migration report
      // (defensive) gets a fresh state.
      for (const f of event.files) {
        for (const id of f.hunkIds) nextHunks[id] ??= freshHunkState();
      }

      state.hunks = nextHunks;

      if (idRemap.size > 0 || event.migration) {
        const live = new Set(Object.keys(nextHunks));
        // Successors of one old hunk go in new-revision order, at its place.
        const position = new Map<string, number>();
        for (const f of event.files) for (const id of f.hunkIds) position.set(id, position.size);
        for (const successors of idRemap.values()) {
          if (successors.length > 1)
            successors.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
        }
        // Each new hunk has exactly one predecessor (MigrationEntry.previousHunkId),
        // so remapping never puts one new hunk in two units: in a merge, the
        // unit of the recorded predecessor (the larger contributor) keeps it
        // and the other unit's old hunk is archived.
        const remap = (ids: string[]) =>
          Array.from(
            new Set(ids.flatMap((id) => idRemap.get(id) ?? [id]).filter((id) => live.has(id))),
          );
        // Findings are verified against a specific hunk body. A hunk that
        // migrated `identical` is byte-for-byte the same code, so what was
        // verified about it is still true and the findings carry. Anything
        // else — fuzzy, renamed, archived, or a hunk the report never
        // mentioned — means the code under the finding moved, so the finding
        // is stale and is dropped rather than re-asserted; the incremental
        // re-analysis of the new/changed hunks re-verifies it if it still
        // holds. Simplest rule that can never leave a stale claim on screen.
        const findingsSurvive = (unit: ReviewUnit): boolean =>
          event.migration !== undefined &&
          unit.hunkIds.every((id) => statusByOldId.get(id) === "identical");
        state.units = state.units.map((u) => {
          const keepFindings = u.findings?.length ? findingsSurvive(u) : false;
          const next: ReviewUnit = { ...u, hunkIds: remap(u.hunkIds) };
          if (!keepFindings) delete next.findings;
          // Every hunk of the unit left the PR: keep it as a visible husk for
          // this one revision (title, summary, kind, attention intact) so the
          // reader sees the decision was dropped rather than it vanishing.
          // `readBeforeRemoval` is judged on the hunk states *before* this
          // revision — afterwards those hunks no longer exist.
          if (u.hunkIds.length > 0 && next.hunkIds.length === 0) {
            next.removedAtRevision = event.revision;
            next.readBeforeRemoval = u.hunkIds.every((id) => previousHunks[id]?.viewed === true);
          }
          return next;
        });
        state.unassignedHunkIds = remap(state.unassignedHunkIds);
      }

      const previousRollups = new Map(state.files.map((f) => [f.path, f]));
      state.files = event.files.map((f) => ({
        path: f.path,
        hunkIds: f.hunkIds,
        viewedCount: 0,
        total: f.hunkIds.length,
        viewed: false,
        changedSinceViewed: false,
        syncedToGithub: previousRollups.get(f.path)?.syncedToGithub,
      }));
      state.lastMigration = event.migration;
      state.generated = event.generated ?? [];
      if (event.generated) state.generatedRevision = event.revision;
      else delete state.generatedRevision;
      applyGenerated(state);
      break;
    }

    case "analysis-set": {
      state.summary = event.summary;
      // A full analysis replaces every unit, so husks drop out unless re-sent;
      // one re-sent with hunks is a live unit again.
      // The generated unit is Purview's, not the analysis's: one in the
      // payload (an import, a model echoing it) is dropped and rebuilt.
      state.units = event.units
        .filter((u) => !isGeneratedUnit(u))
        .map((u) => reviveIfPopulated(fromAnalysis(u) as ReviewUnit));
      state.unassignedHunkIds = [...(event.unassigned ?? [])];
      state.analysisRevision = event.revision;
      state.analysisOrigin = event.origin;
      applyGenerated(state);
      break;
    }

    case "unit-updated": {
      // Never patched: it is rebuilt from the classification (and the CLI
      // refuses such a patch before it gets here).
      if (event.unitId === GENERATED_UNIT_ID) break;
      const patch = fromAnalysis(event.patch);
      const idx = state.units.findIndex((u) => u.id === event.unitId);
      if (idx === -1) {
        const blank: ReviewUnit = {
          id: event.unitId,
          title: "",
          summary: "",
          kind: "wiring",
          attention: "skim",
          attentionWhy: "",
          riskFlags: [],
          hunkIds: [],
          order: state.units.length,
        };
        state.units.push(reviveIfPopulated(applyUnitPatch(blank, patch, state.currentRevision)));
      } else {
        state.units[idx] = reviveIfPopulated(applyUnitPatch(state.units[idx], patch, state.currentRevision));
      }
      // A patch may have claimed a generated hunk, or appended a unit after
      // the generated one; both are put right.
      if (state.generated.length > 0) applyGenerated(state);
      break;
    }

    case "hunk-viewed": {
      const s = state.hunks[event.hunkId] ?? freshHunkState();
      state.hunks[event.hunkId] = {
        ...s,
        viewed: true,
        viewedAtRevision: event.revision,
        changedSinceViewed: false,
      };
      break;
    }

    case "hunk-unviewed": {
      const s = state.hunks[event.hunkId] ?? freshHunkState();
      state.hunks[event.hunkId] = {
        ...s,
        viewed: false,
        viewedAtRevision: undefined,
        changedSinceViewed: false,
      };
      break;
    }

    case "unit-viewed": {
      const unit = state.units.find((u) => u.id === event.unitId);
      if (unit) {
        for (const id of unit.hunkIds) {
          const s = state.hunks[id] ?? freshHunkState();
          state.hunks[id] = {
            ...s,
            viewed: true,
            viewedAtRevision: event.revision ?? state.currentRevision,
            changedSinceViewed: false,
          };
        }
      }
      break;
    }

    case "classification-corrected": {
      state.corrections.push({
        hunkId: event.hunkId,
        from: event.from,
        to: event.to,
        note: event.note ?? "",
        ts: event.ts,
      });
      break;
    }

    case "file-synced-github": {
      const f = state.files.find((x) => x.path === event.file);
      if (f) f.syncedToGithub = event.viewed;
      break;
    }

    case "analysis-started": {
      state.analysisRun = {
        revision: event.revision,
        status: "running",
        startedAt: event.ts,
      };
      break;
    }

    case "analysis-finished": {
      // A finish with no matching start (log truncated, or the start predates
      // this event type) still records a terminal run rather than dropping it.
      state.analysisRun = {
        revision: event.revision,
        status: event.status,
        startedAt: state.analysisRun?.startedAt ?? event.ts,
        finishedAt: event.ts,
        error: event.error,
      };
      break;
    }

    case "review-submitted": {
      // Append-only: a PR can be reviewed several times (approve, then a new
      // round after a force-push). `reviewSubmissions` may be absent on a
      // state built before this event existed, so default it here too.
      state.reviewSubmissions = [
        ...(state.reviewSubmissions ?? []),
        {
          event: event.event,
          url: event.url,
          commentCount: event.commentCount ?? 0,
          ts: event.ts,
          revision: state.currentRevision,
        },
      ];
      break;
    }

    case "revision-discarded":
      // Consumed by `withoutDiscarded` before the fold reaches the reducer.
      break;

    case "generated-classified": {
      if (event.revision !== state.currentRevision) break;
      state.generated = event.files;
      state.generatedRevision = event.revision;
      applyGenerated(state);
      break;
    }
  }

  recomputeRollups(state);
  return state;
}

/**
 * Events that record something that already happened on GitHub. Discarding a
 * revision cannot undo them, so they survive it (see `withoutDiscarded`).
 */
const SURVIVES_DISCARD: ReadonlySet<ReviewerEvent["type"]> = new Set([
  "review-submitted",
  "file-synced-github",
]);

/**
 * The log as if every discarded revision had never been added: a
 * `revision-discarded {revision: N}` drops everything from N's (last)
 * `revision-added` up to itself, except SURVIVES_DISCARD events. Position is
 * what counts, not per-event revision fields — `unit-updated` and
 * `classification-corrected` carry none. Runs over the already-filtered list,
 * so discarding N and then N-1 unwinds both, and a discard naming a revision
 * that is not in the (filtered) log is a no-op. The discard events themselves
 * are consumed here; the reducer never sees them.
 */
export function withoutDiscarded(events: ReviewerEvent[]): ReviewerEvent[] {
  const out: ReviewerEvent[] = [];
  for (const event of events) {
    if (event.type !== "revision-discarded") {
      out.push(event);
      continue;
    }
    let from = out.length - 1;
    while (from >= 0) {
      const e = out[from];
      if (e.type === "revision-added" && e.revision === event.revision) break;
      from--;
    }
    if (from === -1) continue;
    const kept = out.slice(from).filter((e) => SURVIVES_DISCARD.has(e.type));
    out.splice(from, out.length - from, ...kept);
  }
  return out;
}

/**
 * The number the next `revision-added` gets: one past every revision the log
 * ever added, discarded ones included. Analysis jobs, caches and the
 * `revisions/<n>/` dirs are keyed by number, so a number is never reused.
 */
export function nextRevisionNumber(events: ReviewerEvent[]): number {
  let max = 0;
  for (const e of events) {
    if (e.type === "revision-added" || e.type === "revision-discarded") {
      max = Math.max(max, e.revision);
    }
  }
  return max + 1;
}

/** Pure fold: events -> state.json. state.json is always rebuildable from this. */
export function fold(events: ReviewerEvent[]): State {
  return withoutDiscarded(events).reduce(applyEvent, initialState());
}

/**
 * Revisions before the current one that are still on record, newest first —
 * what to walk when looking back through history. Never counts down by
 * number: a discarded revision's files stay on disk but are not history.
 */
export function priorRevisions(state: Pick<State, "revisions" | "currentRevision">): number[] {
  return state.revisions
    .map((r) => r.revision)
    .filter((n) => n < state.currentRevision)
    .sort((a, b) => b - a);
}

/* --------------------------------------------------------------- selectors */

export interface UnitProgress {
  unitId: string;
  title: string;
  attention: string;
  kind: string;
  viewed: number;
  total: number;
  complete: boolean;
  changed: boolean;
}

/** Units still in the PR — everything but husks (see ReviewUnit.removedAtRevision). */
export function liveUnits(state: Pick<State, "units">): ReviewUnit[] {
  return state.units.filter((u) => !isRemovedUnit(u));
}

/**
 * Live units the analysis wrote: everything but husks and Purview's own
 * `generated` unit. "Has this PR been analyzed?" is whether this is empty —
 * the generated unit exists before any analysis runs.
 */
export function analysisUnits(state: Pick<State, "units">): ReviewUnit[] {
  return state.units.filter((u) => !isRemovedUnit(u) && !isGeneratedUnit(u));
}

/** Husks: units every hunk of which left the PR in the current revision. */
export function removedUnits(state: Pick<State, "units">): ReviewUnit[] {
  return state.units.filter(isRemovedUnit);
}

/** Hunk ids in Purview's generated unit (generated files and lockfiles). */
export function generatedHunkIds(state: Pick<State, "units">): Set<string> {
  return new Set(state.units.filter((u) => !isRemovedUnit(u) && isGeneratedUnit(u)).flatMap((u) => u.hunkIds));
}

/**
 * Per-unit progress over the analysis's units; husks count toward nothing,
 * and neither does the generated unit (it is not reading work, and a PR
 * whose only unit it is has not been analyzed).
 */
export function unitProgress(state: State): UnitProgress[] {
  return analysisUnits(state)
    .sort((a, b) => a.order - b.order)
    .map((u) => {
      const states = u.hunkIds.map((id) => state.hunks[id]).filter(Boolean);
      const viewed = states.filter((s) => s!.viewed).length;
      return {
        unitId: u.id,
        title: u.title,
        attention: u.attention,
        kind: u.kind,
        viewed,
        total: u.hunkIds.length,
        complete: u.hunkIds.length > 0 && viewed === u.hunkIds.length,
        changed: states.some((s) => s!.changedSinceViewed),
      };
    });
}

/** The most recent submitted review, if the reader has finished one. */
export function lastReviewSubmission(state: State) {
  const all = state.reviewSubmissions ?? [];
  return all.length > 0 ? all[all.length - 1] : undefined;
}

/**
 * "Am I done reading?" — the numbers the finish-review panel shows before it
 * lets the reader submit. must-read units are the ones worth blocking on.
 */
export interface ReadinessSummary {
  hunks: { viewed: number; total: number };
  units: { complete: number; total: number };
  mustRead: { complete: number; total: number; unviewed: number };
  changedSinceViewed: number;
  ready: boolean;
}

export function readiness(state: State): ReadinessSummary {
  const progress = unitProgress(state);
  const mustRead = progress.filter((u) => u.attention === "must-read");
  // Generated files and lockfiles are not part of the read.
  const generated = generatedHunkIds(state);
  const hunkStates = Object.entries(state.hunks)
    .filter(([id]) => !generated.has(id))
    .map(([, h]) => h);
  const mustReadUnviewed = mustRead.filter((u) => !u.complete).length;
  return {
    hunks: {
      viewed: hunkStates.filter((h) => h.viewed).length,
      total: hunkStates.length,
    },
    units: {
      complete: progress.filter((u) => u.complete).length,
      total: progress.length,
    },
    mustRead: {
      complete: mustRead.filter((u) => u.complete).length,
      total: mustRead.length,
      unviewed: mustReadUnviewed,
    },
    changedSinceViewed: hunkStates.filter((h) => h.changedSinceViewed).length,
    ready: mustReadUnviewed === 0,
  };
}

/** Files whose hunks are all viewed — the set to project onto GitHub. */
export function viewedFiles(state: State): string[] {
  return state.files.filter((f) => f.viewed).map((f) => f.path);
}
