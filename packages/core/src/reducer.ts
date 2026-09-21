import { STATE_SHAPE_VERSION, isRemovedUnit } from "./schemas.js";
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
      const idRemap = new Map<string, string>();
      /** old hunk id -> how it migrated; used for the findings staleness rule */
      const statusByOldId = new Map<string, string>();

      // Which live unit held each outgoing hunk, so an archived hunk remembers
      // the unit it left (`changedUnits` reads it back).
      const unitOfOldHunk = new Map<string, string>();
      for (const u of state.units) {
        if (isRemovedUnit(u)) continue;
        for (const id of u.hunkIds) unitOfOldHunk.set(id, u.id);
      }

      if (event.migration) {
        for (const entry of event.migration.entries) {
          if (entry.status === "archived") statusByOldId.set(entry.hunkId, "archived");
          else if (entry.previousHunkId)
            statusByOldId.set(entry.previousHunkId, entry.status);
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
          if (entry.previousHunkId)
            idRemap.set(entry.previousHunkId, entry.hunkId);
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
        const remap = (ids: string[]) =>
          Array.from(
            new Set(ids.map((id) => idRemap.get(id) ?? id).filter((id) => live.has(id))),
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
      break;
    }

    case "analysis-set": {
      state.summary = event.summary;
      // A full analysis replaces every unit, so husks drop out unless re-sent;
      // one re-sent with hunks is a live unit again.
      state.units = event.units.map((u) => reviveIfPopulated({ ...u }));
      state.unassignedHunkIds = [...(event.unassigned ?? [])];
      state.analysisRevision = event.revision;
      state.analysisOrigin = event.origin;
      break;
    }

    case "unit-updated": {
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
        state.units.push(reviveIfPopulated(applyUnitPatch(blank, event.patch, state.currentRevision)));
      } else {
        state.units[idx] = reviveIfPopulated(
          applyUnitPatch(state.units[idx], event.patch, state.currentRevision),
        );
      }
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
  }

  recomputeRollups(state);
  return state;
}

/** Pure fold: events -> state.json. state.json is always rebuildable from this. */
export function fold(events: ReviewerEvent[]): State {
  return events.reduce(applyEvent, initialState());
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

/** Husks: units every hunk of which left the PR in the current revision. */
export function removedUnits(state: Pick<State, "units">): ReviewUnit[] {
  return state.units.filter(isRemovedUnit);
}

/** Per-unit progress over live units; husks count toward nothing. */
export function unitProgress(state: State): UnitProgress[] {
  return liveUnits(state)
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
  const hunkStates = Object.values(state.hunks);
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
