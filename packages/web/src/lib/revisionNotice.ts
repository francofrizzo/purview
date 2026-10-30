/**
 * What a refresh did to the reader's review, in the reader's words: the
 * migration report (core's carried / fuzzy / renamed / archived / new) as one
 * sentence, and per file for whoever wants the detail. Hunk ids and match
 * scores are the engine's business and stay out of it.
 */

import type { MigrationReport } from "../api/types";

export interface FileChange {
  file: string;
  added: number;
  changed: number;
  gone: number;
  moved: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One sentence: what the new revision brought, or that nothing did. */
export function revisionNoticeText(report: MigrationReport): string {
  const at = report.revision !== undefined ? `Revision ${report.revision}` : "This refresh";
  if (report.noChange) return "Already up to date.";
  if (report.baseOnly) return `${at}: only the base branch moved, nothing to read again.`;
  const c = report.counts ?? {};
  const added = c.new ?? report.new?.length ?? 0;
  const changed = c.fuzzy ?? report.fuzzy?.length ?? 0;
  const gone = c.archived ?? report.archived?.length ?? 0;
  const moved = c.renamed ?? report.renamed?.length ?? 0;
  const parts = [
    added ? plural(added, "new hunk") : "",
    changed ? `${changed} changed` : "",
    moved ? `${moved} in renamed files` : "",
    gone ? `${gone} gone` : "",
  ].filter(Boolean);
  if (!parts.length) return `${at}: nothing you read changed.`;
  return `${at}: ${parts.join(", ")}.`;
}

/** The same counts per file, the busiest file first. */
export function revisionFileChanges(report: MigrationReport): FileChange[] {
  const byFile = new Map<string, FileChange>();
  const bump = (file: string | undefined, key: keyof Omit<FileChange, "file">) => {
    if (!file) return;
    const row = byFile.get(file) ?? { file, added: 0, changed: 0, gone: 0, moved: 0 };
    row[key]++;
    byFile.set(file, row);
  };
  for (const i of report.new ?? []) bump(i.file, "added");
  for (const i of report.fuzzy ?? []) bump(i.file, "changed");
  for (const i of report.archived ?? []) bump(i.file, "gone");
  for (const i of report.renamed ?? []) bump(i.file, "moved");
  const total = (r: FileChange) => r.added + r.changed + r.gone + r.moved;
  return [...byFile.values()].sort((a, b) => total(b) - total(a) || a.file.localeCompare(b.file));
}
