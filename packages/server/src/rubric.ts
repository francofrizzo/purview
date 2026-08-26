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
  opts: { committed?: CommittedConfig } = {},
): string {
  const layers = rubricLayers(key, root, opts);
  if (layers.length === 1) return "";
  const out: string[] = [
    "===== REVIEW RUBRIC — LAYERED =====",
    "Layers apply in order; a later layer refines and overrides the ones above it where they disagree.",
  ];
  for (const layer of layers) {
    out.push("", `----- RUBRIC LAYER ${layer.level}: ${layer.label} -----`);
    if (layer.path) out.push(`Read it from: ${layer.path}`);
    if (layer.origin) out.push(`Source: ${layer.origin}`);
    if (layer.content) out.push(layer.content.trimEnd());
  }
  out.push("", "===== END REVIEW RUBRIC =====");
  return out.join("\n");
}
