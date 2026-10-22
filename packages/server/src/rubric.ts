import path from "node:path";
import {
  readLocalRubric,
  repoKeyOf,
  repoRubricPath,
  stateRoot,
  type PrKey,
} from "@reviewer/core";
import { skillDir } from "./analysis.js";
import { cachedCommitted, TEAM_RUBRIC_FILE, type CommittedConfig } from "./team-config.js";

/**
 * The rubric a run is judged against is a stack, not a file:
 *
 *   1. the built-in skill rubric   — the base taxonomy, referenced by path
 *      because it is long, stable, and already readable by the run;
 *   2. `.purview/RUBRIC.md`        — committed in the target repo: the team's
 *      refinements, inlined so the run sees them even when the file was read
 *      through the GitHub API rather than a checkout;
 *   3. `RUBRIC.local.md`           — this machine's overlay for this repo,
 *      inlined, highest precedence.
 *
 * Later layers refine earlier ones; where they disagree, the later one wins.
 * That ordering is stated in the block itself, because it is the only thing a
 * model has to go on when two rubrics conflict.
 */

/** Inlined layers are capped: a rubric is guidance, not a corpus. */
export const MAX_INLINE_RUBRIC = 24_000;

export interface RubricLayer {
  level: 1 | 2 | 3;
  label: string;
  /** set for layers referenced by path (the built-in one) */
  path?: string;
  /** set for inlined layers */
  content?: string;
  origin?: string;
}

function clip(text: string): string {
  return text.length <= MAX_INLINE_RUBRIC
    ? text
    : text.slice(0, MAX_INLINE_RUBRIC) + "\n… [truncated]";
}

export function rubricLayers(
  key: PrKey,
  root = stateRoot(),
  opts: { committed?: CommittedConfig } = {},
): RubricLayer[] {
  const layers: RubricLayer[] = [
    {
      level: 1,
      label: "built-in skill rubric (base)",
      path: path.join(skillDir(), "RUBRIC.md"),
    },
  ];

  const committed = opts.committed ?? cachedCommitted(key, root);
  if (committed.rubric && committed.rubric.trim() !== "") {
    layers.push({
      level: 2,
      label: "team rubric — refines the above",
      origin: `${TEAM_RUBRIC_FILE} in ${key.owner}/${key.repo}`,
      content: clip(committed.rubric),
    });
  }

  const local = readLocalRubric(repoKeyOf(key), root);
  if (local.trim() !== "") {
    layers.push({
      level: 3,
      label: "local overlay — highest precedence",
      origin: repoRubricPath(repoKeyOf(key), root),
      content: clip(local),
    });
  }

  return layers;
}

/**
 * The prompt block. Empty when nothing overlays the built-in rubric, so the
 * common case adds not a single token to the prompt.
 */
export function rubricSection(
  key: PrKey,
  root = stateRoot(),
  opts: {
    committed?: CommittedConfig;
    /** the built-in rubric is already inlined (the analysis system prompt): say so instead of naming its path */
    baseInline?: boolean;
  } = {},
): string {
  const layers = rubricLayers(key, root, opts);
  if (layers.length === 1) return "";
  const out: string[] = [
    "===== REVIEW RUBRIC — LAYERED =====",
    "Layers apply in order; a later layer refines and overrides the ones above it where they disagree.",
  ];
  for (const layer of layers) {
    out.push("", `----- RUBRIC LAYER ${layer.level}: ${layer.label} -----`);
    if (layer.path) {
      out.push(
        opts.baseInline
          ? "Already in the system prompt (RUBRIC.md) — do not read it from disk."
          : `Read it from: ${layer.path}`,
      );
    }
    // Provenance only: naming the path without this warning reliably baits
    // the model into `cat`ing a file outside its readable roots and burning a
    // turn on the denial.
    if (layer.origin) out.push(`Source (already inlined below — do NOT read this path): ${layer.origin}`);
    if (layer.content) out.push(layer.content.trimEnd());
  }
  out.push("", "===== END REVIEW RUBRIC =====");
  return out.join("\n");
}

/**
 * Which language the run writes in. Purview takes no side: a rubric layer may
 * state one and wins; otherwise the reader's own choice for analyses
 * (config.json's `analysisLanguage`, when set), else the PR's own description
 * decides. Stated explicitly because "the reader's language" on its own is
 * ambiguous, and two harnesses were seen resolving it differently on the same
 * repository. A refresh does not come here: it keeps the language the PR's
 * analysis already reads in (analysis.ts `languageNote`).
 */
export function languageRule(kind: "analysis" | "chat", language?: string | null): string {
  const written = kind === "analysis"
    ? "unit titles, summaries, attentionWhy, hunk labels and heart whys, findings, the flow and file notes, and revision summaries"
    : "comment drafts";
  const otherwise = kind === "analysis" && language ? language : "the language of the PR's title and description";
  return [
    "LANGUAGE:",
    `Write ${written} in the language a rubric layer above names, if one does; otherwise in ${otherwise}.`,
    kind === "chat"
      ? "Answer the reader in the language they write to you in, whatever the drafts' language."
      : "Code identifiers, paths and quoted code stay as they are; JSON keys and enum values (kind, attention, risk flags…) stay exactly as SKILL.md spells them.",
  ].join("\n");
}
