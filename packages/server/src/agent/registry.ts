import { INLINE_LIMIT_ENV } from "@reviewer/core";
import { claudeCodeHarness } from "./claude-code/index.js";
import type { AgentHarness, HarnessId } from "./types.js";

/**
 * The harnesses this server can run. Callers go through here, never to an
 * adapter directly. Selecting a harness per run arrives with configuration
 * that names one; until then every run uses the default.
 */

const HARNESSES: ReadonlyMap<HarnessId, AgentHarness> = new Map([
  [claudeCodeHarness.manifest.id, claudeCodeHarness],
]);

export const DEFAULT_HARNESS: HarnessId = claudeCodeHarness.manifest.id;

/** A registered harness; throws on an unknown id rather than falling back. */
export function getHarness(id: HarnessId = DEFAULT_HARNESS): AgentHarness {
  const harness = HARNESSES.get(id);
  if (!harness) throw new Error(`Unknown agent harness "${id}"`);
  return harness;
}

/** A registered harness, or undefined. */
export function findHarness(id: HarnessId): AgentHarness | undefined {
  return HARNESSES.get(id);
}

export function harnessIds(): HarnessId[] {
  return [...HARNESSES.keys()];
}

/**
 * What the reviewer-state CLI needs to know about the harness running it,
 * added to the environment of every run that has a shell tool.
 */
export function cliEnvironment(manifest: AgentHarness["manifest"]): Record<string, string> {
  return { [INLINE_LIMIT_ENV]: String(manifest.inlineOutputLimit) };
}
