/**
 * Generated files and lockfiles. Purview classifies them itself when a
 * revision is recorded (`FileEntry.generated`) and gathers every hunk of them
 * into one fixed `skip` unit (`ReviewUnit.origin === "generated"`) that the
 * analysis never reads. The web only renders that decision, lets the reader
 * override it per path, and keeps the unit out of anything that counts review
 * work: it is a place to park machine output, not a unit to read.
 */

import {
  isGeneratedUnit,
  type FileEntry,
  type FileGenerated,
  type GeneratedSource,
  type ReviewUnit,
} from "../api/types";

/**
 * Units that are review work — everything but the generated unit. Use it for
 * "has this PR been analyzed?", "all units viewed" and next-unit hops; the
 * sidebar still lists the generated unit, under skip.
 */
export function workUnits<U extends Pick<ReviewUnit, "origin">>(units: U[]): U[] {
  return units.filter((u) => !isGeneratedUnit(u));
}

/**
 * The PR's overall "N/M viewed": every hunk except those of generated files,
 * which are not review work (the generated unit's own progress still counts
 * them, so "mark all viewed" there visibly does something).
 */
export function reviewProgress(
  files: Pick<FileEntry, "hunks" | "generated">[],
  hunks: Record<string, { viewed?: boolean } | undefined>,
): { viewed: number; total: number } {
  let viewed = 0;
  let total = 0;
  for (const f of files) {
    if (f.generated) continue;
    for (const h of f.hunks) {
      total++;
      if (hunks[h.id]?.viewed) viewed++;
    }
  }
  return { viewed, total };
}

/** The file tree's small tag: a lockfile reads as "lock", everything else as "gen". */
export function generatedTag(g: FileGenerated): "lock" | "gen" {
  return g.source === "lockfile" ? "lock" : "gen";
}

const SOURCE_TEXT: Record<GeneratedSource, string> = {
  repo: "matches this repo's “always treat as generated” patterns",
  gitattributes: "marked linguist-generated in .gitattributes",
  lockfile: "a lockfile",
  path: "a generated-code path",
  marker: "carries a generated-code marker",
};

/** Tooltip for a generated file: which signal fired, and on what. */
export function generatedReason(g: FileGenerated): string {
  const what = g.source === "lockfile" ? "Lockfile" : "Generated";
  const why = SOURCE_TEXT[g.source] ?? g.source;
  const detail = g.detail?.trim();
  return `${what}: ${why}${detail ? ` (${detail})` : ""}. Skipped by the analysis.`;
}

/** One glob per line, as the repo settings textareas hold them. Trimmed, de-duplicated. */
export function parsePatternLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

export interface GeneratedUnitFile {
  path: string;
  additions: number;
  deletions: number;
  generated?: FileGenerated;
}

/**
 * The files the generated unit holds, in the files view's order, with their
 * +/− — what its header lists instead of prose. Whole files: the unit always
 * holds every hunk of a generated file, so the file's own stats are its stats.
 */
export function generatedUnitFiles(
  files: FileEntry[],
  unit: Pick<ReviewUnit, "hunkIds">,
): GeneratedUnitFile[] {
  const ids = new Set(unit.hunkIds);
  const out: GeneratedUnitFile[] = [];
  for (const f of files) {
    if (!f.hunks.some((h) => ids.has(h.id))) continue;
    out.push({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      ...(f.generated ? { generated: f.generated } : {}),
    });
  }
  return out;
}

/**
 * The file header's override action. `generated` is what the click asks the
 * server for (the opposite of the file's current state); `explain` is the
 * confirmation line, which says the choice sticks for the whole repo.
 */
export function generatedToggle(
  file: Pick<FileEntry, "generated">,
  repoName: string,
): { generated: boolean; label: string; explain: string } {
  if (file.generated) {
    return {
      generated: false,
      label: "Not generated",
      explain:
        `Its hunks leave “Generated & lockfiles” and wait under “not in any unit” until an analysis places them. ` +
        `Remembered for every PR in ${repoName} (repo settings → never treat as generated).`,
    };
  }
  return {
    generated: true,
    label: "Treat as generated",
    explain:
      `Its hunks move to “Generated & lockfiles” (skip) and the analysis stops reading it. ` +
      `Remembered for every PR in ${repoName} (repo settings → always treat as generated).`,
  };
}
