import { keyToString, type PrKey } from "./paths.js";
import { loadState, readFilesJson, readMeta } from "./store.js";
import { setAnalysis } from "./service.js";
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

/** Build the envelope for the PR's current analysis. Throws if there is none. */
export function buildAnalysisExport(key: PrKey, root: string): AnalysisExport {
  const meta = readMeta(key, root);
  const state = loadState(key, root);
  if (state.units.length === 0) {
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
    units: state.units,
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
