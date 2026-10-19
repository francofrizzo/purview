import type { RevisionInfo } from "../api/types";

/** One "rN · what it changed" line: a revision that carries a summary. */
export interface RevisionSummaryLine {
  revision: number;
  summary: string;
}

/**
 * The revisions that have a summary (the refresh analysis writes one per
 * revision past the first), newest first; with `after`, only the ones that
 * landed after that revision — what the reader has not seen since their
 * last review. Revisions without a summary are left out: a line saying
 * "no summary" is noise everywhere this is shown.
 */
export function revisionSummaryLines(
  revisions: readonly RevisionInfo[] | undefined,
  after?: number,
): RevisionSummaryLine[] {
  return (revisions ?? [])
    .filter((r) => !!r.summary && (after === undefined || r.revision > after))
    .map((r) => ({ revision: r.revision, summary: r.summary! }))
    .sort((a, b) => b.revision - a.revision);
}

/** `r3 · <summary>` */
export function formatRevisionSummary(line: RevisionSummaryLine): string {
  return `r${line.revision} · ${line.summary}`;
}
