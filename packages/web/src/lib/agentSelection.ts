/**
 * Editing one layer's agent selection from the settings pickers. The server
 * stores a selection whole and validates it against the harness's manifest;
 * this is only the arithmetic of "change one field, keep the rest".
 */
import type { AgentSelection, AgentsInfo, HarnessManifest } from "../api/types";

export function manifestOf(agents: AgentsInfo | undefined, harness: string): HarnessManifest | undefined {
  return agents?.harnesses.find((h) => h.id === harness);
}

/** Only worth a picker when there is a choice to make. */
export function offersHarnessChoice(agents: AgentsInfo | undefined): boolean {
  return (agents?.harnesses.length ?? 0) > 1;
}

/**
 * The harness a layer would run on if it named none — when that is knowable.
 * With one harness it always is; otherwise only while the layer names none
 * (then it is what the server resolved), since the layers below are not
 * resolved separately.
 */
export function inheritedHarness(
  agents: AgentsInfo | undefined,
  layer: AgentSelection | null,
  resolvedHarness: string,
): string | null {
  if (agents && !offersHarnessChoice(agents)) return agents.harnesses[0]?.id ?? resolvedHarness;
  return layer ? null : resolvedHarness;
}

/**
 * `layer` with one field changed. `resolvedHarness` is what the layer runs on
 * now; `inherited` is what it would run on naming none (see above).
 *
 * - A harness change starts the selection over: another harness's model or
 *   effort means nothing to the new one.
 * - A model or effort is pinned on the harness the layer runs on now.
 * - A selection left naming nothing but the harness it would inherit anyway
 *   is `null` again, so clearing the last field really re-inherits.
 */
export function editSelection<T extends AgentSelection>(
  layer: T | null,
  field: "harness" | "model" | "effort",
  value: string | null,
  resolvedHarness: string,
  inherited: string | null,
): T | null {
  if (field === "harness") return value === null ? null : ({ harness: value } as T);
  const next: AgentSelection = { ...(layer ?? { harness: resolvedHarness }) };
  if (value === null) delete next[field];
  else next[field] = value;
  if (next.model === undefined && next.effort === undefined && next.harness === inherited) return null;
  return next as T;
}

export interface PickerOption {
  value: string;
  label: string;
  title?: string;
}

export function harnessOptions(agents: AgentsInfo | undefined): PickerOption[] {
  return (agents?.harnesses ?? []).map((h) => ({ value: h.id, label: h.name }));
}

export function modelOptions(manifest: HarnessManifest | undefined): PickerOption[] {
  return (manifest?.models ?? []).map((m) => ({ value: m.id, label: m.label }));
}

export function effortOptions(manifest: HarnessManifest | undefined): PickerOption[] {
  return (manifest?.efforts ?? []).map((e) => ({
    value: e,
    label: e,
    title: e === "none" ? `Set no effort level at all, leaving it to ${manifest!.name}` : undefined,
  }));
}

/** A model's label, or its id when the manifest does not know it. */
export function modelLabel(manifest: HarnessManifest | undefined, id: string): string {
  return manifest?.models.find((m) => m.id === id)?.label ?? id;
}
