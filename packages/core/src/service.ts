import fs from "node:fs";
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
import { analysisJobPath, commentsPath, repoKeyOf, stateRoot, type PrKey } from "./paths.js";
import { nextRevisionNumber, priorRevisions } from "./reducer.js";
import { planUnitPatches, remainingWork, type RemainingWork, type UnitPatchRequest } from "./unit-patch.js";
import {
  appendEvent,
  appendEvents,
  ensureRepoConfig,
  listPrs,
  loadState,
  prExists,
  readEvents,
  readFilesJson,
  readMeta,
  updateMeta,
  writeMeta,
  writeMigrationReport,
  writeRevision,
} from "./store.js";
import type {
  Analysis,
  AnalysisJob,
  BasePr,
  Meta,
  MigrationReport,
  NewEvent,
  State,
} from "./schemas.js";
import {
  AnalysisJobSchema,
  AnalysisSchema,
  CHANGELOG_TEXT_MAX,
  FINDING_EVIDENCE_MAX,
  FINDING_TEXT_MAX,
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
  // Not current + 1: a discarded revision's number is never handed out again.
  // The migration below still diffs against `current`, the revision in force.
  const revision = nextRevisionNumber(readEvents(key, root));
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

export type DiscardRefusal =
  | "not_latest"
  | "only_revision"
  | "analysis_in_progress"
  | "comments_since";

/** A guard refused `discardRevision`; `code` is what the HTTP layer answers with. */
export class DiscardRefusedError extends Error {
  constructor(
    readonly code: DiscardRefusal,
    message: string,
  ) {
    super(message);
    this.name = "DiscardRefusedError";
  }
}

/**
 * Comments (any status) created at or after `since`, an ISO timestamp.
 * comments.json belongs to the server; all this needs is `createdAt`, so it
 * is read loosely rather than through the server's schema.
 */
export function commentsCreatedSince(key: PrKey, since: string, root = stateRoot()): number {
  const file = commentsPath(key, root);
  if (!fs.existsSync(file)) return 0;
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) return 0;
  // Submitted comments are public on GitHub and can't be deleted, so counting
  // them would block the discard for good; they stay where GitHub put them.
  return raw.filter(
    (c) => typeof c?.createdAt === "string" && c.createdAt >= since && c.status !== "submitted",
  ).length;
}

function readJobLoosely(key: PrKey, root: string): AnalysisJob | null {
  try {
    return AnalysisJobSchema.parse(JSON.parse(fs.readFileSync(analysisJobPath(key, root), "utf8")));
  } catch {
    return null;
  }
}

export interface DiscardResult {
  state: State;
  discarded: number;
  /** the revision now in force */
  revision: number;
}

/**
 * Throw away the latest revision — a refresh that caught the author
 * mid-rebase — so the next refresh diffs straight against the one before it.
 * Appends `revision-discarded`; the fold then restores exactly the state as it
 * was before `revision` was added, plus whatever was done on GitHub since.
 * `revisions/<n>/` stays on disk and the number is never reused.
 *
 * Refused (DiscardRefusedError) unless `revision` is the current one and there
 * is an earlier one to fall back to, no analysis is queued or running, and no
 * comment was written since it was added: comments are stored by file+line,
 * so one written against this revision's diff has no safe place to go.
 */
export function discardRevision(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): DiscardResult {
  const meta = readMeta(key, root);
  const state = loadState(key, root);
  if (revision !== state.currentRevision) {
    throw new DiscardRefusedError(
      "not_latest",
      `r${revision} is not the current revision (r${state.currentRevision}); only the latest ` +
        `revision can be discarded.`,
    );
  }
  const info = state.revisions.find((r) => r.revision === revision);
  const previous = priorRevisions(state)[0];
  if (!info || previous === undefined) {
    throw new DiscardRefusedError(
      "only_revision",
      `r${revision} is the only revision of this PR; there is nothing to fall back to.`,
    );
  }
  const job = readJobLoosely(key, root);
  if (job && (job.status === "queued" || job.status === "running")) {
    throw new DiscardRefusedError(
      "analysis_in_progress",
      `An analysis is ${job.status} for r${job.revision}; cancel it or let it finish first.`,
    );
  }
  const comments = commentsCreatedSince(key, info.addedAt, root);
  if (comments > 0) {
    throw new DiscardRefusedError(
      "comments_since",
      `${comments} comment${comments === 1 ? " was" : "s were"} written since r${revision} was ` +
        `added. They point at lines of r${revision}'s diff, so delete ${comments === 1 ? "it" : "them"} ` +
        `first ("copy & delete" in the comments drawer keeps the text).`,
    );
  }

  const next = appendEvent(key, { type: "revision-discarded", revision }, root);

  // What was recorded about the discarded revision outside the log goes too:
  // the "archived, so not analyzed" note, and the last run's record (the log
  // keeps its analysis-finished event; the header would otherwise show a
  // run for a revision that no longer exists).
  if (meta.analysisPending && meta.analysisPending.revision >= revision) {
    updateMeta(key, { analysisPending: undefined }, root);
  }
  if (job && job.revision >= revision) fs.rmSync(analysisJobPath(key, root), { force: true });

  return { state: next, discarded: revision, revision: next.currentRevision };
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
 * `text`/`evidence`, a unit patch's `changelogEntry` and `changelog[].text`
 * are truncated to the stored-state limits rather than failing the whole
 * payload, and each truncated one yields one warning line. A model trimming prose to fit a char count across several retries
 * costs far more than a clipped sentence. Accepts an analysis (`units[]`) or a
 * single unit/patch (`findings[]`); anything else passes through untouched,
 * and the schema still has the last word on shape.
 */
export function truncateFindings(
  payload: unknown,
  fallbackUnitId?: string,
): { payload: unknown; warnings: string[] } {
  const warnings: string[] = [];
  const fixChangelog = (u: Record<string, unknown>, unitId: string): Record<string, unknown> => {
    const next = { ...u };
    const entry = u.changelogEntry;
    if (typeof entry === "string" && entry.length > CHANGELOG_TEXT_MAX) {
      next.changelogEntry = truncateAtWord(entry, CHANGELOG_TEXT_MAX);
      warnings.push(
        `warning: unit ${unitId} changelogEntry truncated (${entry.length}->${CHANGELOG_TEXT_MAX} chars)`,
      );
    }
    if (Array.isArray(u.changelog)) {
      next.changelog = u.changelog.map((e) => {
        if (!e || typeof e !== "object") return e;
        const text = (e as Record<string, unknown>).text;
        if (typeof text !== "string" || text.length <= CHANGELOG_TEXT_MAX) return e;
        warnings.push(
          `warning: unit ${unitId} changelog r${(e as Record<string, unknown>).revision} truncated ` +
            `(${text.length}->${CHANGELOG_TEXT_MAX} chars)`,
        );
        return { ...e, text: truncateAtWord(text, CHANGELOG_TEXT_MAX) };
      });
    }
    return next;
  };
  const fixUnit = (unit: unknown): unknown => {
    if (!unit || typeof unit !== "object") return unit;
    const unitId =
      typeof (unit as Record<string, unknown>).id === "string"
        ? ((unit as Record<string, unknown>).id as string)
        : (fallbackUnitId ?? "?");
    const u = fixChangelog(unit as Record<string, unknown>, unitId);
    if (!Array.isArray(u.findings)) return u;
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
  return setUnits(key, [{ unitId, payload: patchInput, note: opts.note }], root).state;
}

/**
 * Upsert several units in one batch (`set-units`). Every patch is validated
 * first — schema, hunk ids, one-owner-per-hunk on the state the whole batch
 * produces — and only then are all events appended in a single write, so an
 * invalid patch anywhere means nothing is written. Each patch may use
 * `addHunkIds`/`removeHunkIds` instead of a full `hunkIds` (see unit-patch.ts).
 */
export function setUnits(
  key: PrKey,
  requests: UnitPatchRequest[],
  root = stateRoot(),
): { state: State; warnings: string[]; unitIds: string[] } {
  const state = loadState(key, root);
  const planned = planUnitPatches(state, requests);
  const next = appendEvents(key, planned.events, root);
  return { state: next, warnings: planned.warnings, unitIds: planned.unitIds };
}

/** What is left to do on the current revision (printed after every write). */
export function remainingWorkFor(key: PrKey, root = stateRoot()): RemainingWork {
  const state = loadState(key, root);
  const filesOf = (rev: number | undefined) => {
    if (rev === undefined) return undefined;
    try {
      return readFilesJson(key, rev, root).files;
    } catch {
      return undefined;
    }
  };
  const report = state.lastMigration;
  return remainingWork(state, readEvents(key, root), {
    previous: filesOf(report?.previousRevision),
    current: filesOf(state.currentRevision),
  });
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
