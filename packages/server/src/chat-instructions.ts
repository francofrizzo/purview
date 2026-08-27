import {
  readLocalChatInstructions,
  repoChatInstructionsPath,
  repoKeyOf,
  stateRoot,
  type PrKey,
} from "@reviewer/core";
import { cachedCommitted, TEAM_CHAT_FILE, type CommittedConfig } from "./team-config.js";

/**
 * Chat-only counterpart to rubric.ts's layering, for the review-chat system
 * prompt rather than the analysis rubric:
 *
 *   1. `.purview/CHAT.md`     — committed in the target repo: the team's
 *      shared chat guidance, inlined so the run sees it even when the file
 *      was read through the GitHub API rather than a checkout;
 *   2. `CHAT.local.md`        — this machine's overlay for this repo,
 *      inlined, highest precedence.
 *
 * There is no built-in base layer here (unlike the rubric, which always has
 * the skill's RUBRIC.md as level 1): with neither file present, there is
 * nothing to say and the block is entirely absent from the prompt. This is
 * chat-only — the analysis prompt is untouched by design.
 */

/** Inlined layers are capped: guidance is not a corpus. Mirrors MAX_INLINE_RUBRIC. */
export const MAX_INLINE_CHAT_INSTRUCTIONS = 24_000;

export interface ChatInstructionsLayer {
  level: 1 | 2;
  label: string;
  content: string;
  origin?: string;
}

function clip(text: string): string {
  return text.length <= MAX_INLINE_CHAT_INSTRUCTIONS
    ? text
    : text.slice(0, MAX_INLINE_CHAT_INSTRUCTIONS) + "\n… [truncated]";
}

export function chatInstructionsLayers(
  key: PrKey,
  root = stateRoot(),
  opts: { committed?: CommittedConfig } = {},
): ChatInstructionsLayer[] {
  const layers: ChatInstructionsLayer[] = [];

  const committed = opts.committed ?? cachedCommitted(key, root);
  if (committed.chatInstructions && committed.chatInstructions.trim() !== "") {
    layers.push({
      level: 1,
      label: "team chat instructions — repo-specific guidance",
      origin: `${TEAM_CHAT_FILE} in ${key.owner}/${key.repo}`,
      content: clip(committed.chatInstructions),
    });
  }

  const local = readLocalChatInstructions(repoKeyOf(key), root);
  if (local.trim() !== "") {
    layers.push({
      level: 2,
      label: "local overlay — highest precedence",
      origin: repoChatInstructionsPath(repoKeyOf(key), root),
      content: clip(local),
    });
  }

  return layers;
}

/**
 * The prompt block. Empty when neither overlay is present, so the common case
 * adds not a single token to the chat prompt, and the analysis prompt (which
 * never calls this) is entirely unaffected.
 */
export function chatInstructionsSection(
  key: PrKey,
  root = stateRoot(),
  opts: { committed?: CommittedConfig } = {},
): string {
  const layers = chatInstructionsLayers(key, root, opts);
  if (layers.length === 0) return "";
  const out: string[] = [
    "===== CHAT INSTRUCTIONS — LAYERED =====",
    "Layers apply in order; a later layer refines and overrides the ones above it where they disagree.",
  ];
  for (const layer of layers) {
    out.push("", `----- CHAT LAYER ${layer.level}: ${layer.label} -----`);
    if (layer.origin) out.push(`Source: ${layer.origin}`);
    out.push(layer.content.trimEnd());
  }
  out.push("", "===== END CHAT INSTRUCTIONS =====");
  return out.join("\n");
}
