/**
 * Experiments: features still being tried, each off until the reader turns
 * it on in Settings. The flags live in the server's config (one switch gates
 * both what the analysis is asked to write and what the app shows), so every
 * browser on this machine sees the same set.
 */
import { useGlobalConfig } from "../api/hooks";

export const EXPERIMENTS = [
  {
    id: "behaviorChanges",
    title: "Behavior changes",
    hint: "A before and after table under the overview's summary. Analyses write it once this is on.",
  },
  {
    id: "unitDiagrams",
    title: "Unit diagrams",
    hint: "A sequence, state or data diagram beside a unit when one helps. Analyses draw them once this is on.",
  },
] as const;

export type ExperimentId = (typeof EXPERIMENTS)[number]["id"];
export type Experiments = Partial<Record<ExperimentId, boolean>>;

/** Whether an experiment is on; off while the config loads or on a server without experiments. */
export function useExperiment(id: ExperimentId): boolean {
  return useGlobalConfig().data?.experiments?.[id] === true;
}
