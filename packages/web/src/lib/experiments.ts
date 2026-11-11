/**
 * Experiments: features still being tried, each off until the reader turns
 * it on in Settings. The flags live in the server's config (one switch gates
 * both what the analysis is asked to write and what the app shows), so every
 * browser on this machine sees the same set.
 */
import { useGlobalConfig } from "../api/hooks";

export interface Experiment {
  /** also in the server's EXPERIMENT_IDS */
  id: string;
  title: string;
  hint: string;
}

export const EXPERIMENTS = [
  {
    id: "architecture",
    title: "Architecture",
    hint: "An Overview section holding the PR against the repo's documented architecture: the rules it breaks, the decisions the docs miss. Analyses write it once this is on.",
  },
] as const satisfies readonly Experiment[];

export type ExperimentId = (typeof EXPERIMENTS)[number]["id"];
export type Experiments = Partial<Record<ExperimentId, boolean>>;

/** Whether an experiment is on; off while the config loads or on a server without experiments. */
export function useExperiment(id: ExperimentId): boolean {
  return useGlobalConfig().data?.experiments?.[id] === true;
}
