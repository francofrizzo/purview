import {
  fetchDefaultBranch,
  fetchMergeBase,
  findOpenPrByHead,
  fetchPullDiff,
  fetchPullRequest,
  fetchRemoteViewedState,
  fetchReviewDecision,
  resolveReviewRequest,
  setFileViewedOnGithub,
} from "./github.js";
import { migrate, toRevisionFiles } from "./migration.js";
import { parseDiff } from "./parse-diff.js";
import { repoKeyOf, stateRoot, type PrKey } from "./paths.js";
import {
  appendEvent,
  appendEvents,
  ensureRepoConfig,
  listPrs,
  loadState,
  prExists,
  readFilesJson,
  readMeta,
  updateMeta,
  writeMeta,
  writeMigrationReport,
  writeRevision,
} from "./store.js";
import type {
  Analysis,
  BasePr,
  Meta,
  MigrationReport,
  NewEvent,
  ReviewUnitPatch,
  State,
} from "./schemas.js";
import {
  AnalysisSchema,
  FINDING_EVIDENCE_MAX,
  FINDING_TEXT_MAX,
  ReviewUnitPatchSchema,
  ReviewUnitSchema,
} from "./schemas.js";

/**
 * A locally tracked, still-open PR of the same repo whose head is `branch` —
 * the free answer to "which PR is this one stacked on?". Unreadable meta is
 * skipped rather than failing the caller.
 */
export function findTrackedPrByHead(
  key: PrKey,
  branch: string,
  root = stateRoot(),
): BasePr | null {
  const matches: Meta[] = [];
  for (const other of listPrs(root)) {
    if (
      other.host !== key.host ||
      other.owner !== key.owner ||
      other.repo !== key.repo ||
      other.number === key.number
    ) {
      continue;
    }
    try {
      const m = readMeta(other, root);
      if (m.headRef !== branch) continue;
      if (m.prState === "merged" || m.prState === "closed") continue;
      matches.push(m);
    } catch {
      // skip unreadable state
    }
  }
  if (matches.length === 0) return null;
  // Branch names get reused; the newest PR is the live one.
  const m = matches.sort((a, b) => b.number - a.number)[0];
  return { number: m.number, title: m.title ?? "", url: m.url };
}

const sameBasePr = (a: BasePr | null | undefined, b: BasePr | null | undefined) =>
  (a ?? null) === (b ?? null) ||
  (!!a && !!b && a.number === b.number && a.title === b.title && a.url === b.url);

/**
 * The meta fields that say what a PR targets: `baseRef`, and — when that is
 * not the repo's default branch — `basePr`, the PR it is stacked on. Returns
 * only what changed. Best-effort throughout: an unknown default branch leaves
 * `basePr` alone (cleared if the base itself moved), and a failed `gh` lookup
 * keeps the previous value.
 */
export function resolveBaseMeta(
  key: PrKey,
  meta: Pick<Meta, "baseRef" | "basePr">,
  baseRef: string,
  root = stateRoot(),
): Partial<Meta> {
  const patch: Partial<Meta> = {};
  const moved = meta.baseRef !== baseRef;
  if (moved) patch.baseRef = baseRef;
  const previous = moved ? undefined : meta.basePr;

  let next: BasePr | null | undefined = previous;
  const defaultBranch = fetchDefaultBranch(repoKeyOf(key), root);
  if (defaultBranch !== null) {
    if (baseRef === defaultBranch) {
      next = null;
    } else {
      const local = findTrackedPrByHead(key, baseRef, root);
      if (local) {
        next = local;
      } else {
        const remote = findOpenPrByHead(repoKeyOf(key), baseRef);
        // `undefined` = the lookup failed: keep what we knew.
        if (remote !== undefined) next = remote;
      }
    }
  }
  if (next === undefined) {
    // Unresolved: only a moved base needs its stale basePr dropped.
    if (meta.basePr !== undefined) patch.basePr = undefined;
  } else if (!sameBasePr(next, meta.basePr) || meta.basePr === undefined) {
    patch.basePr = next;
  }
  return patch;
}

/**
 * The `reviewRequest` meta patch for a PR in `prState`: a fresh lookup, or
 * nothing at all for a merged/closed PR (nobody is waiting on a review there,
 * and the call would be wasted). A failed lookup keeps the previous value but
 * still stamps `reviewRequestCheckedAt`, so a broken `gh` is not re-asked on
 * every pass.
 */
export function reviewRequestPatch(
  key: PrKey,
  prState: string | undefined,
  root = stateRoot(),
  now: number = Date.now(),
): Partial<Meta> {
  if (prState === "merged" || prState === "closed") return {};
  const patch: Partial<Meta> = { reviewRequestCheckedAt: new Date(now).toISOString() };
  try {
    const next = resolveReviewRequest(key, root);
    if (next !== undefined) patch.reviewRequest = next;
  } catch {
    // best-effort
  }
  return patch;
}

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

  // The repo's own config file is created with the first PR of that repo, so
  // it is discoverable (and editable) from the moment the repo is tracked.
  ensureRepoConfig(repoKeyOf(key), root);

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
        author: pr.author,
        authorAvatarUrl: pr.authorAvatarUrl,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        prState: pr.prState,
        reviewDecision: fetchReviewDecision(key),
        archived: false,
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
  const meta = readMeta(key, root); // ensures the PR was initialized
  const pr = fetchPullRequest(key);
  // The head branch can be renamed (or was never recorded, on older state), and
  // worktree resolution keys off it, so keep it current on every refresh.
  // GitHub's PR state and review decision ride along on the same refresh:
  // there is no background polling, so a refresh is the only moment they can
  // move. Both are additive, and a failed decision query degrades to null.
  const reviewDecision = fetchReviewDecision(key);
  const metaPatch: Partial<Meta> = {};
  if (meta.headRef !== pr.headRef) metaPatch.headRef = pr.headRef;
  // Same for the base branch, plus the PR it is stacked on (when it targets
  // anything but the default branch) — the prompts tell Claude about it.
  Object.assign(metaPatch, resolveBaseMeta(key, meta, pr.baseRef, root));
  // Backfills state written before the author was recorded.
  if (pr.author && meta.author !== pr.author) metaPatch.author = pr.author;
  if (pr.authorAvatarUrl && meta.authorAvatarUrl !== pr.authorAvatarUrl) {
    metaPatch.authorAvatarUrl = pr.authorAvatarUrl;
  }
  if (meta.prState !== pr.prState) metaPatch.prState = pr.prState;
  if ((meta.reviewDecision ?? null) !== reviewDecision) {
    metaPatch.reviewDecision = reviewDecision;
  }
  // Whether the user's review is still being waited on, and since when.
  Object.assign(metaPatch, reviewRequestPatch(key, pr.prState, root));
  if (Object.keys(metaPatch).length > 0) updateMeta(key, metaPatch, root);
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

export interface DuplicateHunk {
  hunkId: string;
  /** unit ids (and `unassigned`) the hunk appears in, in payload order */
  owners: string[];
}

/** Hunk ids listed more than once across units' `hunkIds` and `unassigned`. */
export function duplicateHunks(analysis: {
  units: { id: string; hunkIds: string[] }[];
  unassigned?: string[];
}): DuplicateHunk[] {
  const owners = new Map<string, string[]>();
  const add = (id: string, owner: string) => {
    const list = owners.get(id);
    if (list) list.push(owner);
    else owners.set(id, [owner]);
  };
  for (const u of analysis.units) for (const id of u.hunkIds) add(id, u.id);
  for (const id of analysis.unassigned ?? []) add(id, "unassigned");
  return [...owners]
    .filter(([, list]) => list.length > 1)
    .map(([hunkId, list]) => ({ hunkId, owners: list }));
}

/** Cut `s` to at most `max` chars at a word boundary, ending in "…". */
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const room = s.slice(0, max - 1);
  const cut = room.search(/\s\S*$/);
  // A single very long token (a path, say): cut mid-word rather than to nothing.
  const kept = cut > max / 2 ? room.slice(0, cut) : room;
  return kept.replace(/[\s,;:.]+$/, "") + "…";
}

/**
 * Pre-schema pass for `set-analysis` / `set-unit` payloads: over-long finding
 * `text`/`evidence` are truncated to the stored-state limits rather than
 * failing the whole payload, and each truncated finding yields one warning
 * line. A model trimming prose to fit a char count across several retries
 * costs far more than a clipped sentence. Accepts an analysis (`units[]`) or a
 * single unit/patch (`findings[]`); anything else passes through untouched,
 * and the schema still has the last word on shape.
 */
export function truncateFindings(
  payload: unknown,
  fallbackUnitId?: string,
): { payload: unknown; warnings: string[] } {
  const warnings: string[] = [];
  const fixUnit = (unit: unknown): unknown => {
    if (!unit || typeof unit !== "object") return unit;
    const u = unit as Record<string, unknown>;
    if (!Array.isArray(u.findings)) return unit;
    const unitId = typeof u.id === "string" ? u.id : (fallbackUnitId ?? "?");
    const findings = u.findings.map((f, i) => {
      if (!f || typeof f !== "object") return f;
      const finding = f as Record<string, unknown>;
      const cut: string[] = [];
      const next = { ...finding };
      for (const [field, max] of [
        ["text", FINDING_TEXT_MAX],
        ["evidence", FINDING_EVIDENCE_MAX],
      ] as const) {
        const v = finding[field];
        if (typeof v === "string" && v.length > max) {
          next[field] = truncateAtWord(v, max);
          cut.push(`${field} ${v.length}->${max}`);
        }
      }
      if (cut.length > 0) {
        warnings.push(`warning: unit ${unitId} finding ${i + 1} truncated (${cut.join(", ")} chars)`);
      }
      return next;
    });
    return { ...u, findings };
  };
  if (!payload || typeof payload !== "object") return { payload, warnings };
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.units)) return { payload: { ...p, units: p.units.map(fixUnit) }, warnings };
  return { payload: fixUnit(p), warnings };
}

export interface SetAnalysisOptions {
  /** Provenance: set to "import" when the units came from another reader's
   *  exported analysis (see analysis-share.ts) rather than a fresh Claude run. */
  origin?: "import";
}

/** Validates coverage, then emits `analysis-set`. Throws on gaps. */
export function setAnalysis(
  key: PrKey,
  input: unknown,
  opts: SetAnalysisOptions = {},
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
  // An imported analysis comes from another reader's (possibly older) CLI and
  // is re-anchored mechanically; it is taken as it is rather than refused.
  if (opts.origin !== "import") {
    const dupes = duplicateHunks(analysis);
    if (dupes.length > 0) {
      throw new Error(
        `Analysis lists ${dupes.length} hunk id(s) in more than one place; each hunk ` +
          `belongs to exactly one unit (or "unassigned"):\n  ` +
          dupes.map((d) => `${d.hunkId}: ${d.owners.join(", ")}`).join("\n  "),
      );
    }
  }
  const next = appendEvent(
    key,
    {
      type: "analysis-set",
      revision: state.currentRevision,
      summary: analysis.summary,
      units: analysis.units,
      unassigned: analysis.unassigned ?? [],
      origin: opts.origin,
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

  // The patched unit's own old list is replaced, not added to, so only the
  // *other* units can clash. Moving a hunk is two patches: drop it from its
  // old unit first, then add it to the new one.
  if (patch.hunkIds) {
    const dupes = duplicateHunks({
      units: [...state.units.filter((u) => u.id !== unitId), { id: unitId, hunkIds: patch.hunkIds }],
    });
    if (dupes.length > 0) {
      throw new Error(
        `Unit "${unitId}" would share ${dupes.length} hunk id(s) with another unit; each ` +
          `hunk belongs to exactly one (to move one, first set-unit its current unit ` +
          `without it):\n  ` +
          dupes.map((d) => `${d.hunkId}: ${d.owners.join(", ")}`).join("\n  "),
      );
    }
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

/**
 * Mark several hunks viewed (or not) in one append: one request, one event
 * batch, one state rebuild. Used by the diff pane's per-file checkbox. Every
 * id must belong to the current revision; an unknown id rejects the whole
 * batch rather than recording part of it.
 */
export function setHunksViewed(
  key: PrKey,
  hunkIds: string[],
  viewed: boolean,
  root = stateRoot(),
): State {
  const state = loadState(key, root);
  const unknown = hunkIds.filter((id) => !state.hunks[id]);
  if (unknown.length > 0) {
    throw new Error(
      `Hunk(s) not in revision ${state.currentRevision}: ${unknown.join(", ")}; nothing was recorded.`,
    );
  }
  const ids = [...new Set(hunkIds)];
  if (ids.length === 0) return state;
  return appendEvents(
    key,
    ids.map((hunkId) => ({
      type: viewed ? ("hunk-viewed" as const) : ("hunk-unviewed" as const),
      hunkId,
      revision: state.currentRevision,
    })),
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
