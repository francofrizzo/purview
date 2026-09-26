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
