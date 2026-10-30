import type { FileEntry, Hunk } from "../api/types";

/**
 * A mechanical one-word hint for a hunk that is not at a unit's heart: what
 * kind of glue it is, from its path and its lines alone. Shown muted on the
 * hunk header once a unit has a heart, so the support hunks announce
 * themselves as support instead of leaving the reader to guess. Never a
 * judgment of kind or attention — that stays the analysis's.
 *
 * The path patterns mirror core's triage (packages/core/src/triage.ts and
 * generated.ts), which the analysis reads the same facts from.
 */

const DOCS_PATH_RE = /(\.mdx?$|\.rst$|(^|\/)docs\/|(^|\/)(readme|license|notice|changelog|contributing)[^/]*\.txt$)/i;
/** Text a program ships (prompts, templates): it runs, so it is not documentation. */
const SHIPPED_TEXT_RE =
  /^(?!\.)(?!.*(^|\/)(README|AGENTS|CLAUDE)\.md$)(?!(.*\/)?docs\/)(.*\/)?(prompts?|templates?|assets?|skills)\/.*\.(mdx?|txt)$/;
const EVALS_PATH_RE = /(^|\/)evals?\//;
const ENCODED_BLOB_RE = /\.(b64|base64)$/;
const TESTS_PATH_RE =
  /(_test\.go$|\.test\.|\.spec\.|(^|\/)__tests__\/|(^|\/)testdata\/|(^|\/)(tests?|e2e|spec|__mocks__|integration[-_]?tests?)\/|(^|\/)fixtures\/)/;
const SNAP_PATH_RE = /((^|\/)__snapshots__\/|\.snap$|(^|\/)golden\/)/;
const MIG_PATH_RE = /((^|\/)migrations\/.*\.sql$|(^|\/)migrations\/)/;
const GEN_TEXT_RE = /(Code generated|DO NOT EDIT|@generated)/;

/** An import-ish line in the languages the diff is likely to show. */
const IMPORT_LINE_RE =
  /^\s*(import\b|from\s+\S+\s+import\b|export\s+(\*|\{[^}]*\})\s+from\b|(const|let|var)\s+[\w{}\s,*:$]+=\s*require\(|require\(|use\s+[\w:\\]+;|using\s+[\w.]+;|#include\b|\}?\s*from\s+["']|[\w./@-]+["'];?$)/;

export type HunkHint = "tests" | "docs" | "snapshot" | "migration" | "generated" | "lockfile" | "imports only";

/** What the file alone says, before looking at any of its lines. */
export function fileHint(file: Pick<FileEntry, "path" | "generated">): HunkHint | null {
  const p = file.path;
  if (file.generated?.source === "lockfile") return "lockfile";
  if (file.generated || ENCODED_BLOB_RE.test(p)) return "generated";
  if (SNAP_PATH_RE.test(p)) return "snapshot";
  if (MIG_PATH_RE.test(p)) return "migration";
  if (TESTS_PATH_RE.test(p)) return "tests";
  if (SHIPPED_TEXT_RE.test(p)) return null;
  if (DOCS_PATH_RE.test(p)) return "docs";
  if (EVALS_PATH_RE.test(p)) return "tests";
  return null;
}

export function hunkHint(file: FileEntry, hunk: Hunk): HunkHint | null {
  const hint = fileHint(file);
  if (hint) return hint;
  const changed = [...(hunk.addedLines ?? []), ...(hunk.removedLines ?? [])];
  if (changed.some((l) => GEN_TEXT_RE.test(l))) return "generated";
  const content = changed.filter((l) => l.trim() !== "");
  if (content.length > 0 && content.every((l) => IMPORT_LINE_RE.test(l))) return "imports only";
  return null;
}
