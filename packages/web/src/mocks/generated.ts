/**
 * Mock-mode stand-in for the server's generated-files unit: built from the
 * files' `generated` classification exactly the way the server is specified
 * to (one fixed `skip` unit, every hunk of every generated file, gone when no
 * generated file remains). Kept pure so the fixture and the mock server's
 * override endpoint build it the same way.
 */

import { GENERATED_UNIT_ID, type FileEntry, type GeneratedSource, type ReviewUnit } from "../api/types";

const SIGNAL_NAMES: Record<GeneratedSource, string> = {
  repo: "repo patterns",
  gitattributes: ".gitattributes",
  lockfile: "lockfile names",
  path: "path conventions",
  marker: "generated markers",
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildGeneratedUnit(files: FileEntry[], order = 999): ReviewUnit | null {
  const generated = files.filter((f) => f.generated);
  if (!generated.length) return null;
  const locks = generated.filter((f) => f.generated!.source === "lockfile").length;
  const others = generated.length - locks;
  const additions = generated.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = generated.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const parts = [
    locks ? count(locks, "lockfile", "lockfiles") : null,
    others ? count(others, "generated file", "generated files") : null,
  ].filter(Boolean);
  const signals = [...new Set(generated.map((f) => SIGNAL_NAMES[f.generated!.source]))];
  return {
    id: GENERATED_UNIT_ID,
    origin: "generated",
    title: "Generated & lockfiles",
    summary: `${parts.join(", ")} · +${additions.toLocaleString("en-US")} −${deletions.toLocaleString("en-US")}`,
    kind: "wiring",
    attention: "skip",
    attentionWhy: `Generated or lock files: detected by Purview (${signals.join(", ")}), not read by the analysis.`,
    riskFlags: [],
    hunkIds: generated.flatMap((f) => f.hunks.map((h) => h.id)),
    order,
  };
}
