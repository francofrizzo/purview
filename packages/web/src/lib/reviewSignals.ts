import type { SignalFlag } from "../api/types";

/** Risk surfaces are stakes, smells are questions—not verified findings. */
export const REVIEW_SIGNALS: Record<SignalFlag, { label: string; kind: "risk" | "smell" }> = {
  auth: { label: "auth", kind: "risk" },
  migration: { label: "migration", kind: "risk" },
  concurrency: { label: "concurrency", kind: "risk" },
  money: { label: "money", kind: "risk" },
  "external-call": { label: "external call", kind: "risk" },
  security: { label: "security", kind: "risk" },
  abstraction: { label: "unnecessary abstraction?", kind: "smell" },
  duplication: { label: "duplicated logic?", kind: "smell" },
  "defensive-code": { label: "speculative fallback?", kind: "smell" },
  "convention-drift": { label: "convention drift?", kind: "smell" },
  "intent-drift": { label: "intent drift?", kind: "smell" },
  "test-gap": { label: "test gap?", kind: "smell" },
};
