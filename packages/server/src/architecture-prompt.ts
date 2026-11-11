import { loadState, readRepoConfig, repoKeyOf, type PrKey } from "@reviewer/core";
import { experimentOn } from "./config.js";

/**
 * The run prompt's lines for the `architecture` experiment: where the repo's
 * architecture is documented (the repo setting's docs, or where to look) and
 * what to write from it. Empty while the experiment is off, so the prompt is
 * the one it was before the experiment existed. A refresh redraws the view
 * only when the PR already has one: a repo whose docs an analysis did not
 * find is not searched again on every revision.
 */
export function architecturePrompt(
  key: PrKey,
  root: string,
  opts: { incremental: boolean; hasCheckout: boolean; flow: "cli" | "tools" },
): string {
  if (!experimentOn("architecture", root)) return "";
  const guide = opts.flow === "cli" ? "WRITING.md" : "WRITING GUIDE";
  if (opts.incremental) {
    if (!loadState(key, root).architecture) return "";
    const shape = opts.flow === "cli" ? "`set-shape` after `set-units`" : "set_shape";
    return `ARCHITECTURE: the PR has an \`architecture\` view (${guide}, 'Architecture'). If this revision adds or fixes a deviation, makes a decision the docs miss, or makes a row untrue, redraw it whole with ${shape}; otherwise leave it.`;
  }
  if (!opts.hasCheckout) return "ARCHITECTURE: there is no checkout to check rule quotes against: leave `architecture` out.";
  const docs = readRepoConfig(repoKeyOf(key), root).architectureDocs;
  const where = docs.length
    ? `This repo's architecture is documented in ${docs.map((d) => `\`${d}\``).join(", ")} (its repo settings): read those, and look for no other docs.`
    : "Look for the repo's documented architecture: ARCHITECTURE.md, docs/architecture*, docs/adr/**, the rule sections of AGENTS.md or CLAUDE.md, and any doc the repo rubric names as its architecture.";
  return [
    `ARCHITECTURE (${guide}, 'Architecture'): ${where}`,
    "Hold the diff against the rules its files could break, then write `architecture`: the rules you checked, the deviations, and the decisions the docs do not cover. Most PRs follow the docs: empty deviations and decisions.",
    "With no such doc, leave `architecture` out. Every quote is checked against the checkout: copy each rule as the doc writes it.",
  ].join(" ");
}
