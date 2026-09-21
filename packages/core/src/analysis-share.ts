import { keyToString, type PrKey } from "./paths.js";
import { loadState, readFilesJson, readMeta } from "./store.js";
import { setAnalysis } from "./service.js";
import { liveUnits } from "./reducer.js";
import { AnalysisExportSchema, type AnalysisExport, type State } from "./schemas.js";

/**
 * Purview-to-Purview analysis sharing: one reviewer exports the analysis they
 * paid Claude to produce, a teammate tracking the same PR imports it and gets
 * the same units/findings without re-running analysis. Hunk ids are
 * content-derived (see hunk-id.ts), so the same PR revision yields identical
 * ids on every machine — import is re-anchoring by id intersection, not line
 * matching. When the importer's revision differs from the exporter's, ids
 * that still exist carry over; hunks of the importer's revision the export
 * doesn't cover land in `unassigned`, exactly like `set-analysis` already
 * handles a partial analysis.
 */

export const ANALYSIS_EXPORT_FORMAT = "purview-analysis" as const;
export const ANALYSIS_EXPORT_VERSION = 1 as const;

/* ------------------------------------------------------- PR-comment channel */

/**
 * Marks a GitHub conversation-tab comment as carrying a Purview analysis
 * envelope, so a later reader (or this same reader, re-sharing after a
 * refresh) can find it among the PR's other comments without guessing.
 * Versioned independently of `ANALYSIS_EXPORT_VERSION`: the comment's own
 * rendering could change shape someday without the envelope schema moving.
 */
export const ANALYSIS_COMMENT_MARKER = "<!-- purview-analysis v1 -->";

/** GitHub's hard cap on an issue/PR comment body. */
const GITHUB_COMMENT_MAX_CHARS = 65536;
/** Stay comfortably under the cap rather than skate right up to it. */
const ANALYSIS_COMMENT_SAFE_MAX_CHARS = 65000;

/**
 * Thrown by `renderAnalysisComment` when the envelope simply will not fit in
 * one GitHub comment. There is no truncation fallback — a truncated analysis
 * is a corrupted one — so the caller is told to fall back to the file
 * export/import path instead.
 */
export class AnalysisCommentTooLargeError extends Error {
  constructor(readonly chars: number) {
    super(
      `Analysis comment would be ${chars} characters, over GitHub's ${GITHUB_COMMENT_MAX_CHARS}-character ` +
        `comment limit — use "export analysis" (file) and share the file instead.`,
    );
    this.name = "AnalysisCommentTooLargeError";
  }
}

/**
 * Render an analysis envelope as a narrative GitHub comment: a one-line
 * header, the summary as prose, then the full envelope minified inside a
 * collapsed `<details>` block so the comment reads like a comment and not a
 * JSON dump. `extractAnalysisFromComment` is the exact inverse of the
 * `<details>` block, keyed off `ANALYSIS_COMMENT_MARKER`.
 */
export function renderAnalysisComment(envelope: AnalysisExport): string {
  const unitCount = envelope.units.length;
  const exportedDate = envelope.exportedAt.slice(0, 10) || envelope.exportedAt;
  const header = `**Purview analysis** — ${unitCount} unit${unitCount === 1 ? "" : "s"}, exported ${exportedDate}`;
  const summary = envelope.summary.trim();
  const json = JSON.stringify(envelope);
  const body = [
    header,
    "",
    summary,
    "",
    "<details>",
    "<summary>analysis data</summary>",
    "",
    "```json",
    json,
    "```",
    "",
    "</details>",
    "",
    ANALYSIS_COMMENT_MARKER,
  ].join("\n");

  if (body.length > ANALYSIS_COMMENT_SAFE_MAX_CHARS) {
    throw new AnalysisCommentTooLargeError(body.length);
  }
  return body;
}

/**
 * Inverse of `renderAnalysisComment`: pulls the fenced JSON block back out
 * and schema-validates it. Never throws — a comment that isn't one of ours,
 * one whose marker survived but whose body was hand-edited, or one from a
 * future/older format all just yield `null` so callers can treat "no usable
 * analysis here" uniformly.
 */
export function extractAnalysisFromComment(body: string): AnalysisExport | null {
  if (!body.includes(ANALYSIS_COMMENT_MARKER)) return null;
  const match = body.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const result = AnalysisExportSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Build the envelope for the PR's current analysis. Throws if there is none. */
export function buildAnalysisExport(key: PrKey, root: string): AnalysisExport {
  const meta = readMeta(key, root);
  const state = loadState(key, root);
  // Husks carry no hunks: an importer would only count them as dropped.
  const units = liveUnits(state);
  if (units.length === 0) {
    throw new Error(
      `No analysis to export for ${keyToString(key)} — run an analysis first.`,
    );
  }
  const revisionInfo = state.revisions.find((r) => r.revision === state.currentRevision);
  return AnalysisExportSchema.parse({
    format: ANALYSIS_EXPORT_FORMAT,
    version: ANALYSIS_EXPORT_VERSION,
    pr: { host: key.host, owner: key.owner, repo: key.repo, number: key.number },
    revision: state.currentRevision,
    headSha: revisionInfo?.headSha ?? "",
    mergeBase: revisionInfo?.mergeBase ?? "",
    exportedAt: new Date().toISOString(),
    summary: state.summary,
    units,
  });
}

export interface AnalysisImportReport {
  unitsImported: number;
  unitsDropped: number;
  hunksMatched: number;
  hunksUnassigned: number;
  /** true when the importer's revision matches the export's, i.e. nothing to re-anchor */
  sameRevision: boolean;
}

/**
 * Re-anchor an imported envelope onto the importer's current revision and
 * apply it through the same `setAnalysis` path `set-analysis` uses, so
 * coverage validation and the `analysis-set` event stay uniform. Throws if
 * the envelope's PR does not match `key`.
 */
export function applyAnalysisImport(
  key: PrKey,
  input: unknown,
  root: string,
): { state: State; report: AnalysisImportReport } {
  const envelope = AnalysisExportSchema.parse(input);
  if (
    envelope.pr.host !== key.host ||
    envelope.pr.owner !== key.owner ||
    envelope.pr.repo !== key.repo ||
    envelope.pr.number !== key.number
  ) {
    throw new Error(
      `Analysis export is for ${envelope.pr.host}/${envelope.pr.owner}/${envelope.pr.repo}#${envelope.pr.number}, ` +
        `not ${keyToString(key)} — cannot import.`,
    );
  }

  const state = loadState(key, root);
  const currentIds = new Set(readFilesJson(key, state.currentRevision, root).files.flatMap((f) => f.hunks.map((h) => h.id)));

  let unitsDropped = 0;
  const matched = new Set<string>();
  const units = [];
  for (const unit of envelope.units) {
    const hunkIds = unit.hunkIds.filter((id) => currentIds.has(id));
    if (hunkIds.length === 0) {
      unitsDropped++;
      continue;
    }
    for (const id of hunkIds) matched.add(id);
    units.push({ ...unit, hunkIds });
  }

  const unassigned = [...currentIds].filter((id) => !matched.has(id));

  const { state: next } = setAnalysis(
    key,
    { summary: envelope.summary, units, unassigned },
    { origin: "import" },
    root,
  );

  return {
    state: next,
    report: {
      unitsImported: units.length,
      unitsDropped,
      hunksMatched: matched.size,
      hunksUnassigned: unassigned.length,
      sameRevision: envelope.revision === state.currentRevision,
    },
  };
}
