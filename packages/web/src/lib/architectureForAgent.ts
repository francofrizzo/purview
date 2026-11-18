import type { Architecture, ArchitectureDecision, ArchitectureDeviation } from "../api/types";

/**
 * The architecture view as markdown for a coding agent: each deviation with
 * the rule quoted, where it is and the code, and what the agent should do
 * about it; the decisions the docs miss, with the line to add to them.
 */

const ASK = "Check it against the code: change the code to follow the rule, or explain why the rule does not apply here.";
const ASK_ALL = "Check each against the code: change the code to follow the rule, or explain why the rule does not apply here.";

/** A fence longer than any backtick run in `text`. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

const quoted = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

function deviationBody(d: ArchitectureDeviation): string {
  const from = `\`${d.rule.source}\`${d.rule.heading ? ` (${d.rule.heading})` : ""}`;
  return [
    `### ${d.what}`,
    `\`${d.code.file}:${d.code.line}\` may break this rule from ${from}:`,
    quoted(d.rule.quote),
    fenced(d.code.excerpt),
    ...(d.why ? [d.why] : []),
  ].join("\n\n");
}

/** One deviation, for an agent to check and fix. */
export function deviationForAgent(d: ArchitectureDeviation): string {
  return [`A documented architecture rule this PR may break. ${ASK}`, deviationBody(d)].join("\n\n") + "\n";
}

function decisionLine(d: ArchitectureDecision): string {
  const doc = d.docLine
    ? ` Suggested line for \`${d.docLine.target}\`${d.docLine.heading ? `, under "${d.docLine.heading}"` : ""}: "${d.docLine.text}"`
    : "";
  return `- **${d.what}**: ${d.means}${doc}`;
}

/** The whole view: the deviations, then the decisions worth documenting. */
export function architectureForAgent(a: Pick<Architecture, "sources" | "deviations" | "decisions">): string {
  const parts: string[] = [];
  if (a.deviations.length) {
    parts.push(
      "## Possible architecture deviations",
      `Rules from ${a.sources.map((s) => `\`${s}\``).join(", ")} this PR may break. ${ASK_ALL}`,
      ...a.deviations.map(deviationBody),
    );
  }
  if (a.decisions.length) {
    parts.push(
      "## Worth documenting",
      "Decisions this PR makes that the architecture docs say nothing about. Add the line to the doc where it fits.",
      a.decisions.map(decisionLine).join("\n"),
    );
  }
  return parts.join("\n\n") + "\n";
}
