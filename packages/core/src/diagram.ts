import { z } from "zod";

/* ------------------------------------------------------------ unit diagrams */

/**
 * A small Mermaid diagram beside a unit whose
 * logic is a sequence across components, a state machine or data
 * relationships that prose struggles with. Most units have none.
 *
 * The Mermaid source is untrusted text written by an analysis. The app
 * renders it with Mermaid's strict security level; on top of that, the
 * directives that style the diagram, reconfigure the renderer or wire it to
 * callbacks are refused here, so they never reach the state at all.
 */
export const UNIT_DIAGRAM_KINDS = ["sequence", "state", "flow", "er"] as const;
export const UnitDiagramKindSchema = z.enum(UNIT_DIAGRAM_KINDS);
export type UnitDiagramKind = z.infer<typeof UnitDiagramKindSchema>;

export const UNIT_DIAGRAM_TITLE_MAX = 60;
export const UNIT_DIAGRAM_MERMAID_MAX = 3000;

/** The diagram header each kind must open with (after comments and blank lines). */
export const UNIT_DIAGRAM_HEADERS: Record<UnitDiagramKind, RegExp> = {
  sequence: /^sequenceDiagram\b/,
  state: /^stateDiagram(-v2)?\b/,
  flow: /^(flowchart|graph)\s+(LR|RL|TB|TD|BT)\b/,
  er: /^erDiagram\b/,
};

/**
 * Directives refused in a unit diagram, each with why: a line matching one
 * makes the whole diagram invalid (the analysis fixes and resends it).
 */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /%%\s*\{/, what: "an `%%{init}` directive (the app themes the diagram itself)" },
  { pattern: /^\s*click\s/im, what: "a `click` directive (diagrams carry no links or callbacks)" },
  { pattern: /^\s*links?\s+[^:]+:/im, what: "a `link` directive (diagrams carry no links or callbacks)" },
  { pattern: /^\s*(style|linkStyle)\s/im, what: "a `style` directive (the app themes the diagram itself)" },
  { pattern: /^\s*(classDef|class)\s/im, what: "a `classDef` or `class` directive (the app themes the diagram itself)" },
  { pattern: /:::/, what: "a `:::class` shorthand (the app themes the diagram itself)" },
  { pattern: /<\/?(script|iframe|object|embed|style|img|a|svg|foreignObject|link|meta)\b/i, what: "an HTML tag" },
  { pattern: /javascript:/i, what: "a `javascript:` URL" },
];

/** Every reason this Mermaid source is refused as a unit diagram; empty when it is fine. */
export function unitDiagramProblems(mermaid: string, kind?: UnitDiagramKind): string[] {
  const problems = FORBIDDEN.filter((f) => f.pattern.test(mermaid)).map((f) => `the diagram has ${f.what}`);
  if (kind) {
    const first = mermaid
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("%%"));
    if (!first || !UNIT_DIAGRAM_HEADERS[kind].test(first)) {
      const expected = { sequence: "sequenceDiagram", state: "stateDiagram-v2", flow: "flowchart LR", er: "erDiagram" }[kind];
      problems.push(`a "${kind}" diagram starts with \`${expected}\``);
    }
  }
  return problems;
}

export const UnitDiagramSchema = z
  .object({
    /** what the diagram shows: a sequence, a state machine, a flow, data relationships */
    kind: UnitDiagramKindSchema,
    /** a short caption in the reader's words: "Retrying a charge" */
    title: z.string().min(1).max(UNIT_DIAGRAM_TITLE_MAX).optional(),
    /** the Mermaid source: sequenceDiagram, stateDiagram-v2, flowchart LR or erDiagram */
    mermaid: z.string().min(1).max(UNIT_DIAGRAM_MERMAID_MAX),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const message of unitDiagramProblems(d.mermaid, d.kind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mermaid"], message });
    }
  });
export type UnitDiagram = z.infer<typeof UnitDiagramSchema>;
