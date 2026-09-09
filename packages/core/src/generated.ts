import type { FileDiff, ReviewUnit } from "./schemas.js";

export const GENERATED_UNIT_ID = "purview:generated";

/** Repository patterns use *, ** and ?; all other characters are literal. */
function matches(path: string, pattern: string): boolean {
  const parts = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map((part) =>
    part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" :
      part === "?" ? "[^/]" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("")}$`).test(path);
}

export function detectGenerated(file: FileDiff, patterns: string[]): string | undefined {
  const pattern = patterns.find((p) => matches(file.path, p));
  if (pattern) return `Repository rule: ${pattern}`;
  // Only inspect comment headers present in the first 30 lines of the relevant
  // side. Removed markers in a modified file must never classify its new content.
  for (const h of file.hunks) {
    const removed = file.status === "removed";
    let line = removed ? h.oldStart : h.newStart;
    for (const raw of h.text.split("\n")) {
      if (raw.startsWith(removed ? "+" : "-") || raw.startsWith("\\")) continue;
      const text = raw.slice(1);
      if (line <= 30 && /^\s*(?:\/\/|\/\*|\*|#|<!--|--)\s*(?:@generated\b|Code generated\b.*DO NOT EDIT\b|(?:This file (?:is|was) )?(?:auto[- ]?generated|automatically generated)\b)/i.test(text)) {
        return "Generated-file header";
      }
      line++;
    }
  }
}

type GeneratedFile = { path: string; hunkIds: string[]; generatedReason?: string };

export function normalizeGeneratedUnits(files: GeneratedFile[], units: ReviewUnit[]): ReviewUnit[] {
  const generated = files.filter((f) => f.generatedReason && f.hunkIds.length);
  const ids = new Set(generated.flatMap((f) => f.hunkIds));
  const result: ReviewUnit[] = units.filter((u) => u.id !== GENERATED_UNIT_ID)
    .filter((u) => !u.hunkIds.length || u.hunkIds.some((id) => !ids.has(id))).map((u) => ({
    ...u, generated: undefined, hunkIds: u.hunkIds.filter((id) => !ids.has(id)),
  }));
  if (ids.size) result.push({
    id: GENERATED_UNIT_ID, generated: true, title: "Generated files",
    summary: `${generated.length} generated ${generated.length === 1 ? "file" : "files"}. Hunks are automatically marked viewed unless you mark them unviewed. Open a file below to inspect its changes.`,
    kind: "ripple", attention: "skip", attentionWhy: [...new Set(generated.map((f) => f.generatedReason))].join("; "),
    riskFlags: [], hunkIds: [...ids], order: Math.max(0, ...result.map((u) => u.order)) + 1,
  });
  return result;
}
