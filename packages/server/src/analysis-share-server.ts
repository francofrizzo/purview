import {
  applyAnalysisImport,
  buildAnalysisExport,
  extractAnalysisFromComment,
  keyToString,
  listIssueComments,
  loadState,
  postIssueComment,
  renderAnalysisComment,
  updateIssueComment,
  type AnalysisExport,
  type AnalysisImportReport,
  type IssueComment,
  type PrKey,
} from "@reviewer/core";
import { HttpError } from "./http-error.js";

/**
 * The PR-comment channel for Purview-to-Purview analysis sharing: instead of
 * passing a file around, one reader posts their analysis as a GitHub comment
 * (marked with `ANALYSIS_COMMENT_MARKER`) and a teammate tracking the same PR
 * can import it straight from there — including automatically, at add time,
 * to avoid re-paying for a Claude run another reader already ran (see the
 * `resolveAutoSharedAnalysis` auto-detection helper below, used by
 * `POST /api/prs` and `review-import.ts`).
 */

export interface MarkedComment {
  comment: IssueComment;
  envelope: AnalysisExport;
}

/**
 * Every marked comment on the PR, oldest first, with its envelope already
 * extracted and schema-validated. A comment whose body no longer parses (hand
 * -edited, a future/older format) is skipped rather than failing the scan —
 * same tolerance `extractAnalysisFromComment` itself has.
 */
function markedComments(key: PrKey): MarkedComment[] {
  return listIssueComments(key)
    .map((comment) => {
      const envelope = extractAnalysisFromComment(comment.body);
      return envelope ? { comment, envelope } : null;
    })
    .filter((x): x is MarkedComment => x !== null);
}

type Resolved =
  | { ok: true; comments: MarkedComment[] }
  | { ok: false; error: string };

/** Tolerant wrapper: a `gh` failure here must never propagate as a thrown error. */
function resolveMarked(key: PrKey): Resolved {
  try {
    return { ok: true, comments: markedComments(key) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* -------------------------------------------------------------- share/post */

export interface ShareResult {
  commentUrl: string;
  updated: boolean;
}

/**
 * Post (or update) the one canonical analysis comment on this PR. "Canonical"
 * means: if ANY marked comment already exists — including one posted by a
 * teammate — we update *that* one rather than adding a second, so a PR never
 * accumulates more than one purview-analysis comment. When more than one
 * somehow exists (a very unlucky race), the newest is treated as canonical.
 */
export function shareAnalysisToPr(key: PrKey, root: string): ShareResult {
  const envelope = buildAnalysisExport(key, root);
  const body = renderAnalysisComment(envelope);
  const existing = listIssueComments(key)
    .map((comment) => ({ comment, marked: extractAnalysisFromComment(comment.body) !== null }))
    .filter((c) => c.marked);
  const target = existing[existing.length - 1];
  if (target) {
    const updated = updateIssueComment(key, target.comment.id, body);
    return { commentUrl: updated.htmlUrl, updated: true };
  }
  const created = postIssueComment(key, body);
  return { commentUrl: created.htmlUrl, updated: false };
}

/* ------------------------------------------------------------------ import */

export interface ImportFromPrResult {
  report: AnalysisImportReport;
  author?: string;
  postedAt: string;
  commentUrl: string;
}

/**
 * Import the newest marked comment on this PR, re-anchoring it through the
 * same `applyAnalysisImport` path the file-import endpoint uses. Callers are
 * expected to have already checked `isBusy` (see app.ts) — mid-run imports
 * would race the run's own `set-analysis` call.
 */
export function importAnalysisFromPr(key: PrKey, root: string): ImportFromPrResult {
  const resolved = resolveMarked(key);
  if (!resolved.ok) {
    throw new HttpError(
      502,
      "gh_failed",
      `Could not read comments for ${keyToString(key)}: ${resolved.error}`,
    );
  }
  const newest = resolved.comments[resolved.comments.length - 1];
  if (!newest) {
    throw new HttpError(
      404,
      "no_shared_analysis",
      `No shared Purview analysis comment found on ${keyToString(key)}.`,
    );
  }
  const { report } = applyAnalysisImport(key, newest.envelope, root);
  return {
    report,
    author: newest.comment.author,
    postedAt: newest.comment.updatedAt,
    commentUrl: newest.comment.htmlUrl,
  };
}

/* ------------------------------------------------------------------- probe */

export interface SharedProbeResult {
  found: boolean;
  author?: string;
  postedAt?: string;
  headSha?: string;
  /** whether the shared envelope's headSha matches the importer's current revision */
  sameCommit?: boolean;
  error?: string;
}

/**
 * Cheap read-only check: is there a shared analysis on this PR, and does it
 * match what the reader is currently looking at? Never throws — a `gh`
 * failure degrades to `{ found: false, error }`, exactly like the staleness
 * probe this mirrors.
 */
export function probeSharedAnalysis(key: PrKey, root: string): SharedProbeResult {
  const resolved = resolveMarked(key);
  if (!resolved.ok) return { found: false, error: resolved.error };
  const newest = resolved.comments[resolved.comments.length - 1];
  if (!newest) return { found: false };

  let sameCommit: boolean | undefined;
  try {
    const state = loadState(key, root);
    const revisionInfo = state.revisions.find((r) => r.revision === state.currentRevision);
    sameCommit = revisionInfo ? revisionInfo.headSha === newest.envelope.headSha : undefined;
  } catch {
    sameCommit = undefined;
  }

  return {
    found: true,
    author: newest.comment.author,
    postedAt: newest.comment.updatedAt,
    headSha: newest.envelope.headSha,
    sameCommit,
  };
}

/* ------------------------------------------------------- auto-detection */

export interface AutoSharedAnalysisResult {
  /** true when a shared analysis matching the current revision was imported. */
  imported: boolean;
  sharedAnalysis?: { author?: string; postedAt: string };
  /** true when a shared analysis exists but is for a different revision. */
  foundDifferentCommit: boolean;
}

/**
 * Cost-avoidance check for a PR that has just been added and has no local
 * analysis yet: is there already a shared analysis for this exact revision?
 * If so, import it instead of spending a Claude run. Tolerant end-to-end — a
 * `gh` failure, a state-loading failure, or an import failure all fall back
 * to "nothing to import," so the caller can proceed exactly as it would have
 * before this feature existed.
 */
export function resolveAutoSharedAnalysis(key: PrKey, root: string): AutoSharedAnalysisResult {
  const resolved = resolveMarked(key);
  if (!resolved.ok) return { imported: false, foundDifferentCommit: false };
  const newest = resolved.comments[resolved.comments.length - 1];
  if (!newest) return { imported: false, foundDifferentCommit: false };

  let currentHeadSha: string | undefined;
  try {
    const state = loadState(key, root);
    currentHeadSha = state.revisions.find((r) => r.revision === state.currentRevision)?.headSha;
  } catch {
    return { imported: false, foundDifferentCommit: false };
  }
  if (!currentHeadSha || currentHeadSha !== newest.envelope.headSha) {
    return { imported: false, foundDifferentCommit: true };
  }

  try {
    applyAnalysisImport(key, newest.envelope, root);
  } catch {
    return { imported: false, foundDifferentCommit: false };
  }
  return {
    imported: true,
    foundDifferentCommit: false,
    sharedAnalysis: { author: newest.comment.author, postedAt: newest.comment.updatedAt },
  };
}
