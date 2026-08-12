import {
  fetchMergeBase,
  fetchPullDiff,
  fetchPullRequest,
  fetchRemoteViewedState,
  setFileViewedOnGithub,
} from "./github.js";
import { migrate, toRevisionFiles } from "./migration.js";
import { parseDiff } from "./parse-diff.js";
import { stateRoot, type PrKey } from "./paths.js";
import {
  appendEvent,
  appendEvents,
  loadState,
  prExists,
  readFilesJson,
  readMeta,
  writeMeta,
  writeMigrationReport,
  writeRevision,
} from "./store.js";
import type {
  Analysis,
  MigrationReport,
  NewEvent,
  ReviewUnitPatch,
  State,
} from "./schemas.js";
import {
  AnalysisSchema,
  ReviewUnitPatchSchema,
  ReviewUnitSchema,
} from "./schemas.js";

export interface InitResult {
  key: PrKey;
  state: State;
  revision: number;
  created: boolean;
}

/** Fetch PR meta + diff from GitHub and create the state dir (idempotent). */
export function initPr(key: PrKey, root = stateRoot()): InitResult {
  const created = !prExists(key, root);
  const pr = fetchPullRequest(key);
  const now = new Date().toISOString();

  if (created) {
    writeMeta(
      key,
      {
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: pr.url,
        title: pr.title,
        createdAt: now,
      },
      root,
    );
    appendEvent(
      key,
      {
        type: "pr-initialized",
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: pr.url,
        title: pr.title,
      },
      root,
    );
  }

  const res = refreshPr(key, root);
  return { key, state: res.state, revision: res.revision, created };
}

export interface RefreshResult {
  state: State;
  revision: number;
  added: boolean;
  baseOnly: boolean;
  report?: MigrationReport;
}

/**
 * Fetch the current diff from GitHub; if (baseSha, headSha, mergeBase) is new,
 * store a revision, run migration and record it as a `revision-added` event.
 */
export function refreshPr(key: PrKey, root = stateRoot()): RefreshResult {
  readMeta(key, root); // ensures the PR was initialized
  const pr = fetchPullRequest(key);
  const mergeBase = fetchMergeBase(key, pr.baseSha, pr.headSha);
  const state = loadState(key, root);
  const current = state.revisions.find(
    (r) => r.revision === state.currentRevision,
  );

  if (
    current &&
    current.headSha === pr.headSha &&
    current.mergeBase === mergeBase &&
    current.baseSha === pr.baseSha
  ) {
    return {
      state,
      revision: current.revision,
      added: false,
      baseOnly: current.baseOnly,
    };
  }

  const patch = fetchPullDiff(key);
  const files = parseDiff(patch);
  const revision = (current?.revision ?? 0) + 1;
  const baseOnly = !!current && current.headSha === pr.headSha;

  writeRevision(
    key,
    revision,
    patch,
    files,
    { baseSha: pr.baseSha, headSha: pr.headSha, mergeBase },
    root,
  );

  let report: MigrationReport | undefined;
  if (current) {
    report = migrate({
      revision,
      previousRevision: current.revision,
      previousFiles: readFilesJson(key, current.revision, root).files,
      nextFiles: files,
      hunkStates: state.hunks,
      baseOnly,
    });
    writeMigrationReport(key, report, root);
  }

  const next = appendEvent(
    key,
    {
      type: "revision-added",
      revision,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      mergeBase,
      baseOnly,
      files: toRevisionFiles(files),
      migration: report,
    },
    root,
  );

  return { state: next, revision, added: true, baseOnly, report };
}

export interface AnalysisCoverage {
  covered: string[];
  missing: string[];
  unknown: string[];
}

/** Which hunks of the current revision the analysis accounts for. */
export function analysisCoverage(
  state: State,
  analysis: Analysis,
): AnalysisCoverage {
  const all = new Set(state.files.flatMap((f) => f.hunkIds));
  const claimed = new Set([
    ...analysis.units.flatMap((u) => u.hunkIds),
    ...(analysis.unassigned ?? []),
  ]);
  return {
    covered: [...all].filter((id) => claimed.has(id)),
    missing: [...all].filter((id) => !claimed.has(id)),
    unknown: [...claimed].filter((id) => !all.has(id)),
  };
}

/** Validates coverage, then emits `analysis-set`. Throws on gaps. */
export function setAnalysis(
  key: PrKey,
  input: unknown,
  root = stateRoot(),
): { state: State; coverage: AnalysisCoverage } {
  const analysis = AnalysisSchema.parse(input);
  const state = loadState(key, root);
  const coverage = analysisCoverage(state, analysis);
  if (coverage.missing.length > 0) {
    throw new Error(
      `Analysis does not cover ${coverage.missing.length} hunk(s) of revision ` +
        `${state.currentRevision}; assign them to a unit or list them in ` +
        `"unassigned":\n  ${coverage.missing.join("\n  ")}`,
    );
  }
  if (coverage.unknown.length > 0) {
    throw new Error(
      `Analysis references ${coverage.unknown.length} hunk id(s) that are not in ` +
        `revision ${state.currentRevision}:\n  ${coverage.unknown.join("\n  ")}`,
    );
  }
  const next = appendEvent(
    key,
    {
      type: "analysis-set",
      revision: state.currentRevision,
      summary: analysis.summary,
      units: analysis.units,
      unassigned: analysis.unassigned ?? [],
    },
    root,
  );
  return { state: next, coverage };
}

/**
 * Upsert one unit. Reclassifying kind/attention on an existing unit also logs
 * `classification-corrected` for each of its hunks (the skill's feedback loop).
 *
 * Semantics are explicit about which "mode" a call is in, because the two
 * are dangerously easy to conflate: `unit-updated` events are always a merge
 * patch (see reducer.ts), so a caller creating a brand-new unit but missing
 * a field (e.g. forgetting `kind`) would otherwise silently get the
 * reducer's fallback defaults (kind "wiring", attention "skim", ...) baked
 * in instead of a validation error.
 *   - unit does not exist yet -> payload must satisfy the full ReviewUnit
 *     schema; missing/invalid fields are a hard error naming them.
 *   - unit exists -> payload is a partial patch of only the provided
 *     fields; no defaults are ever injected for fields left out.
 */
export function setUnit(
  key: PrKey,
  unitId: string,
  patchInput: unknown,
  opts: { note?: string } = {},
  root = stateRoot(),
): State {
  const state = loadState(key, root);
  const existing = state.units.find((u) => u.id === unitId);

  let patch: ReviewUnitPatch;
  if (!existing) {
    const result = ReviewUnitSchema.safeParse({
      ...(patchInput as Record<string, unknown>),
      id: unitId,
    });
    if (!result.success) {
      const fields = [
        ...new Set(
          result.error.issues
            .map((i) => i.path.join(".") || "(root)")
            .filter((p) => p !== "id"),
        ),
      ];
      throw new Error(
        `Unit "${unitId}" does not exist yet; creating a new unit requires ` +
          `the full ReviewUnit schema. Missing/invalid field(s): ${fields.join(", ")}`,
      );
    }
    patch = result.data;
  } else {
    patch = ReviewUnitPatchSchema.parse(patchInput);
  }

  const events: NewEvent[] = [{ type: "unit-updated", unitId, patch }];
  if (existing && patch.kind && patch.kind !== existing.kind) {
    for (const hunkId of existing.hunkIds) {
      events.push({
        type: "classification-corrected",
        hunkId,
        from: existing.kind,
        to: patch.kind,
        note: opts.note ?? "",
      });
    }
  }
  if (existing && patch.attention && patch.attention !== existing.attention) {
    for (const hunkId of existing.hunkIds) {
      events.push({
        type: "classification-corrected",
        hunkId,
        from: existing.attention,
        to: patch.attention,
        note: opts.note ?? "",
      });
    }
  }
  return appendEvents(key, events, root);
}

export function setHunkViewed(
  key: PrKey,
  hunkId: string,
  viewed: boolean,
  root = stateRoot(),
): State {
  const state = loadState(key, root);
  return appendEvent(
    key,
    {
      type: viewed ? "hunk-viewed" : "hunk-unviewed",
      hunkId,
      revision: state.currentRevision,
    },
    root,
  );
}

export function setUnitViewed(
  key: PrKey,
  unitId: string,
  viewed: boolean,
  root = stateRoot(),
): State {
  const state = loadState(key, root);
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) {
    throw new Error(
      `No unit "${unitId}" in the current analysis (revision ${state.currentRevision}); nothing was recorded.`,
    );
  }
  if (viewed) {
    return appendEvent(
      key,
      { type: "unit-viewed", unitId, revision: state.currentRevision },
      root,
    );
  }
  return appendEvents(
    key,
    unit.hunkIds.map((hunkId) => ({
      type: "hunk-unviewed" as const,
      hunkId,
      revision: state.currentRevision,
    })),
    root,
  );
}

export interface SyncResult {
  pushed: { file: string; viewed: boolean }[];
  drift: { file: string; local: boolean; remote: string }[];
  state: State;
}

/**
 * Push the viewed-file projection to GitHub. Local is the source of truth;
 * remote state is only read to report drift.
 */
export function syncPr(key: PrKey, root = stateRoot()): SyncResult {
  const state = loadState(key, root);
  const remote = fetchRemoteViewedState(key);
  const pushed: SyncResult["pushed"] = [];
  const drift: SyncResult["drift"] = [];
  const events: NewEvent[] = [];

  for (const file of state.files) {
    const remoteState = remote.files[file.path];
    const remoteViewed = remoteState === "VIEWED";
    if (remoteState && remoteViewed !== file.viewed) {
      drift.push({ file: file.path, local: file.viewed, remote: remoteState });
    }
    // GitHub already matches the local projection (unknown remote == unviewed).
    if (remoteViewed === file.viewed) continue;
    setFileViewedOnGithub(key, remote.pullRequestId, file.path, file.viewed);
    pushed.push({ file: file.path, viewed: file.viewed });
    events.push({
      type: "file-synced-github",
      file: file.path,
      viewed: file.viewed,
    });
  }

  const next = events.length > 0 ? appendEvents(key, events, root) : state;
  return { pushed, drift, state: next };
}
