import type { Finding } from "../api/types";

/**
 * A unit's warning as markdown for a coding agent: what the analysis found,
 * the places it read, the change it sits in, and what to do about it.
 */
export function findingForAgent(f: Finding, unitTitle: string): string {
  return [
    "A possible problem a review of this PR found by reading the code. Check it: fix it if it holds, or explain why it does not.",
    `### ${f.text}`,
    `Where: ${f.evidence}`,
    `In the change: ${unitTitle}`,
  ].join("\n\n") + "\n";
}
