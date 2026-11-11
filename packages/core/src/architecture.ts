import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/* ------------------------------------------------------------ architecture */

/**
 * An experiment (`architecture`): the PR held against the repo's documented
 * architecture. Written only when the repo documents one (ARCHITECTURE.md,
 * docs/adr/**, the rule sections of AGENTS.md…); absent, the Overview shows
 * nothing. Most PRs get the empty answer: rules checked, none broken, no
 * decision the docs miss.
 *
 * Every rule is a verbatim quote of its source. Purview checks each quote
 * against the PR's checkout before saving (`architectureQuoteProblems`), so
 * a rule the docs do not say never reaches the reader.
 */

const docPath = z.string().min(1).max(200);

export const ARCHITECTURE_WHAT_MAX = 60;
export const ARCHITECTURE_QUOTE_MAX = 300;
export const ARCHITECTURE_WHY_MAX = 160;
export const ARCHITECTURE_MEANS_MAX = 200;
export const ARCHITECTURE_EXCERPT_LINES = 3;
export const MAX_ARCHITECTURE_SOURCES = 8;
export const MAX_ARCHITECTURE_CHECKED = 12;
export const MAX_ARCHITECTURE_DEVIATIONS = 5;
export const MAX_ARCHITECTURE_DECISIONS = 4;

/** A rule as the docs say it: the words, where they are. */
export const ArchitectureRuleSchema = z
  .object({
    /** the doc it is quoted from, a path of the repo */
    source: docPath,
    /** the rule, verbatim (whitespace may differ) */
    quote: z.string().min(1).max(ARCHITECTURE_QUOTE_MAX),
    /** the heading it sits under, when it has one */
    heading: z.string().min(1).max(100).optional(),
  })
  .strict();

/** One place the PR does what a documented rule says not to. */
export const ArchitectureDeviationSchema = z
  .object({
    /** the situation, in the reader's words: "Reconciler reads the ledger table" */
    what: z.string().min(1).max(ARCHITECTURE_WHAT_MAX),
    rule: ArchitectureRuleSchema,
    /** the code that breaks it, at its clearest site */
    code: z
      .object({
        unit: z.string().min(1),
        file: docPath,
        line: z.number().int().positive(),
        /** a short verbatim excerpt, at most three lines */
        excerpt: z
          .string()
          .min(1)
          .max(240)
          .refine((s) => s.split("\n").length <= ARCHITECTURE_EXCERPT_LINES, `at most ${ARCHITECTURE_EXCERPT_LINES} lines`),
      })
      .strict(),
    /** the link between rule and code, only when it is not obvious */
    why: z.string().min(1).max(ARCHITECTURE_WHY_MAX).optional(),
  })
  .strict();
export type ArchitectureDeviation = z.infer<typeof ArchitectureDeviationSchema>;

/** A decision the PR makes that the docs say nothing about, and a later PR would have to follow. */
export const ArchitectureDecisionSchema = z
  .object({
    /** a noun phrase: "Jobs call the gateway in batches" */
    what: z.string().min(1).max(ARCHITECTURE_WHAT_MAX),
    /** one sentence: what the PR decides, and that the docs are silent on it */
    means: z.string().min(1).max(ARCHITECTURE_MEANS_MAX),
    unit: z.string().min(1).optional(),
    /** a line the author could paste into the doc, in its own voice */
    docLine: z
      .object({
        target: docPath,
        heading: z.string().min(1).max(100).optional(),
        text: z.string().min(1).max(240),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ArchitectureDecision = z.infer<typeof ArchitectureDecisionSchema>;

export const ArchitectureSchema = z
  .object({
    /** the docs read */
    sources: z.array(docPath).min(1).max(MAX_ARCHITECTURE_SOURCES),
    /** the rules the diff's files could break, each verbatim: what "checked" means */
    checked: z
      .array(z.object({ source: docPath, rule: z.string().min(1).max(ARCHITECTURE_QUOTE_MAX) }).strict())
      .max(MAX_ARCHITECTURE_CHECKED),
    deviations: z.array(ArchitectureDeviationSchema).max(MAX_ARCHITECTURE_DEVIATIONS),
    decisions: z.array(ArchitectureDecisionSchema).max(MAX_ARCHITECTURE_DECISIONS),
  })
  .strict();
export type Architecture = z.infer<typeof ArchitectureSchema>;

/** Whitespace runs as one space, and the quotes and dashes a model retypes as their plain forms. */
function normalized(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A doc of the checkout, or why it cannot be read: a path outside the
 * checkout (absolute, `..`, a symlink out) is refused like a missing one.
 */
function readDoc(checkout: string, file: string): { text: string } | { problem: string } {
  const clean = file.replace(/^\.\//, "");
  if (path.isAbsolute(clean) || clean.includes("\0") || clean.split(/[\\/]/).some((p) => p === ".." || p === ".git")) {
    return { problem: `"${file}" is not a path of the repo` };
  }
  try {
    const base = fs.realpathSync(checkout);
    const real = fs.realpathSync(path.join(base, clean));
    if (!real.startsWith(base + path.sep)) return { problem: `"${file}" is outside the checkout` };
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return { problem: `"${file}" is not a text file of the checkout` };
    return { text: fs.readFileSync(real, "utf8") };
  } catch {
    return { problem: `"${file}" cannot be read in the PR's checkout` };
  }
}

/**
 * Every rule of `architecture` that its source does not say: each
 * deviation's quote and each checked rule must appear in its source file, in
 * the PR's checkout, as written (whitespace aside). Without a checkout nothing
 * can be checked, and the whole view is refused.
 */
export function architectureQuoteProblems(arch: Architecture, checkout: string | undefined): string[] {
  if (!checkout) {
    return ["there is no checkout to check its quotes against; leave `architecture` out"];
  }
  const docs = new Map<string, { text: string } | { problem: string }>();
  const doc = (file: string) => {
    if (!docs.has(file)) {
      const read = readDoc(checkout, file);
      docs.set(file, "text" in read ? { text: normalized(read.text) } : read);
    }
    return docs.get(file)!;
  };
  const problems: string[] = [];
  const check = (where: string, source: string, quote: string) => {
    const d = doc(source);
    if ("problem" in d) problems.push(`${where}: ${d.problem}`);
    else if (!d.text.includes(normalized(quote))) {
      problems.push(`${where}: "${quote.length > 80 ? quote.slice(0, 77) + "..." : quote}" is not in ${source}; quote the rule as the doc writes it`);
    }
  };
  arch.checked.forEach((c, i) => check(`architecture.checked[${i}]`, c.source, c.rule));
  arch.deviations.forEach((d, i) => check(`architecture.deviations[${i}].rule`, d.rule.source, d.rule.quote));
  return problems;
}
