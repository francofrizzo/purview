/**
 * Unit diagrams (the `unitDiagrams` experiment): the analysis's Mermaid
 * source is untrusted text. The server refuses the directives below
 * (core's diagram.ts); the app checks again before rendering, so a state
 * written by an older or hand-edited payload still never reaches mermaid
 * with a click binding, an init block or raw HTML. A refused source is not
 * drawn at all: stripping lines could draw something the analysis never said.
 */

const FORBIDDEN: RegExp[] = [
  /%%\s*\{/,
  /^\s*click\s/im,
  /^\s*links?\s+[^:]+:/im,
  /^\s*(style|linkStyle)\s/im,
  /^\s*(classDef|class)\s/im,
  /:::/,
  /<\/?(script|iframe|object|embed|style|img|a|svg|foreignObject|link|meta)\b/i,
  /javascript:/i,
];

const HEADER = /^(sequenceDiagram|stateDiagram(-v2)?|(flowchart|graph)\s+(LR|RL|TB|TD|BT)|erDiagram)\b/;

export const UNIT_DIAGRAM_MAX = 3000;

/** Whether the source may be handed to mermaid: a known diagram type, bounded, none of the refused directives. */
export function isSafeDiagram(mermaid: string): boolean {
  if (!mermaid || mermaid.length > UNIT_DIAGRAM_MAX) return false;
  const first = mermaid
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("%%"));
  if (!first || !HEADER.test(first)) return false;
  return !FORBIDDEN.some((re) => re.test(mermaid));
}
