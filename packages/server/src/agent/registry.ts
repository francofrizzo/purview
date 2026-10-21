import { INLINE_LIMIT_ENV } from "@reviewer/core";
import { claudeCodeHarness } from "./claude-code/index.js";
import { claudeSharedHarness } from "./claude-shared/index.js";
import { codexHarness } from "./codex/index.js";
import type { AgentHarness, HarnessId } from "./types.js";

/**
 * The harnesses this server can run. Callers go through here, never to an
 * adapter directly. Selecting a harness per run arrives with configuration
 * that names one; until then every run uses the default.
 */

const EXPERIMENTAL: AgentHarness[] = [claudeSharedHarness, codexHarness];

/**
 * `PURVIEW_HARNESS=<id>` runs every analysis and chat on that harness, over
 * whatever the settings say, without showing it anywhere: a private switch for
 * trying an experimental adapter. `undefined` when unset or naming nothing.
 */
export function harnessOverride(): HarnessId | undefined {
  const id = process.env.PURVIEW_HARNESS?.trim();
  return id && [claudeCodeHarness, ...EXPERIMENTAL].some((h) => h.manifest.id === id) ? id : undefined;
}

/** The override as set, even when it names nothing (so the error can say so). */
export function harnessOverrideRaw(): string | undefined {
  const id = process.env.PURVIEW_HARNESS?.trim();
  return id || undefined;
}

function harnesses(): AgentHarness[] {
  // The experimental adapters exist for the settings UI only when opted in;
  // the private override needs them registered without listing them.
  if (process.env.PURVIEW_EXPERIMENTAL_HARNESSES === "1") return [claudeCodeHarness, ...EXPERIMENTAL];
  const override = harnessOverride();
  const extra = EXPERIMENTAL.filter((h) => h.manifest.id === override);
  return [claudeCodeHarness, ...extra];
}

export const DEFAULT_HARNESS: HarnessId = claudeCodeHarness.manifest.id;

/** What the settings UI may offer: the experimental ones only when opted in. */
export function listedHarnessIds(): HarnessId[] {
  const listed = process.env.PURVIEW_EXPERIMENTAL_HARNESSES === "1" ? [claudeCodeHarness, ...EXPERIMENTAL] : [claudeCodeHarness];
  return listed.map((harness) => harness.manifest.id);
}

/** A registered harness; throws on an unknown id rather than falling back. */
export function getHarness(id: HarnessId = DEFAULT_HARNESS): AgentHarness {
  const harness = findHarness(id);
  if (!harness) throw new Error(`Unknown agent harness "${id}"`);
  return harness;
}

/** A registered harness, or undefined. */
export function findHarness(id: HarnessId): AgentHarness | undefined {
  return harnesses().find(harness => harness.manifest.id === id);
}

export function harnessIds(): HarnessId[] {
  return harnesses().map(harness => harness.manifest.id);
}

/**
 * What the reviewer-state CLI needs to know about the harness running it,
 * added to the environment of every run that has a shell tool.
 */
export function cliEnvironment(manifest: AgentHarness["manifest"]): Record<string, string> {
  return { [INLINE_LIMIT_ENV]: String(manifest.inlineOutputLimit) };
}
