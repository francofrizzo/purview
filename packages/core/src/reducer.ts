import type {
  ReviewUnit,
  ReviewerEvent,
  State,
  HunkState,
  FileRollup,
} from "./schemas.js";

export function initialState(): State {
  return {
    currentRevision: 0,
    revisions: [],
    summary: "",
    units: [],
    hunks: {},
    files: [],
    unassignedHunkIds: [],
    archived: [],
    corrections: [],
  };
}

function freshHunkState(): HunkState {
  return { viewed: false, changedSinceViewed: false };
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

      const previousHunks = state.hunks;
      const nextHunks: Record<string, HunkState> = {};
      const idRemap = new Map<string, string>();

      if (event.migration) {
        for (const entry of event.migration.entries) {
          if (entry.status === "archived") {
            state.archived.push({
              hunkId: entry.hunkId,
              file: entry.file,
              archivedAtRevision: event.revision,
              wasViewed: entry.wasViewed ?? false,
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
        state.units = state.units.map((u) => ({
          ...u,
          hunkIds: remap(u.hunkIds),
        }));
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
      state.units = event.units.map((u) => ({ ...u }));
      state.unassignedHunkIds = [...(event.unassigned ?? [])];
      state.analysisRevision = event.revision;
      break;
    }

    case "unit-updated": {
      const idx = state.units.findIndex((u) => u.id === event.unitId);
      if (idx === -1) {
        const created = {
          id: event.unitId,
          title: "",
          summary: "",
          kind: "wiring",
          attention: "skim",
          attentionWhy: "",
          riskFlags: [],
          hunkIds: [],
          order: state.units.length,
          ...event.patch,
        } as ReviewUnit;
        state.units.push(created);
      } else {
        state.units[idx] = { ...state.units[idx], ...event.patch };
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

export function unitProgress(state: State): UnitProgress[] {
  return [...state.units]
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

/** Files whose hunks are all viewed — the set to project onto GitHub. */
export function viewedFiles(state: State): string[] {
  return state.files.filter((f) => f.viewed).map((f) => f.path);
}
