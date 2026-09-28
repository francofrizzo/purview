import { describe, expect, it } from "vitest";
import type { AgentsInfo, HarnessManifest } from "../api/types";
import { editSelection, inheritedHarness } from "./agentSelection";

const CC = "claude-code";
const harness = (id: string): HarnessManifest => ({
  id,
  name: id,
  agentName: id,
  models: [],
  efforts: [],
  defaults: { model: "m", effort: "e" },
  capabilities: { resume: true, handoff: false },
});
const ONE: AgentsInfo = { default: CC, harnesses: [harness(CC)] };
const TWO: AgentsInfo = { default: CC, harnesses: [harness(CC), harness("other")] };

describe("editSelection", () => {
  it("pins a model on the harness the layer runs on when it names none", () => {
    expect(editSelection(null, "model", "opus", CC, CC)).toEqual({ harness: CC, model: "opus" });
  });

  it("keeps the other field when one changes", () => {
    expect(editSelection({ harness: CC, model: "opus" }, "effort", "high", CC, CC)).toEqual({
      harness: CC,
      model: "opus",
      effort: "high",
    });
  });

  it("re-inherits once the last field is cleared", () => {
    expect(editSelection({ harness: CC, model: "opus" }, "model", null, CC, CC)).toBeNull();
  });

  it("keeps a harness the layer chose itself even with nothing else pinned", () => {
    expect(editSelection({ harness: "other", model: "x" }, "model", null, "other", null)).toEqual({
      harness: "other",
    });
  });

  it("starts over on a harness change, and null inherits everything", () => {
    expect(editSelection({ harness: CC, model: "opus", effort: "high" }, "harness", "other", CC, null)).toEqual({
      harness: "other",
    });
    expect(editSelection({ harness: CC, model: "opus" }, "harness", null, CC, null)).toBeNull();
  });
});

describe("inheritedHarness", () => {
  it("is the only harness when there is one", () => {
    expect(inheritedHarness(ONE, { harness: CC, model: "opus" }, CC)).toBe(CC);
  });

  it("is unknowable with a choice of harnesses once the layer names one", () => {
    expect(inheritedHarness(TWO, null, CC)).toBe(CC);
    expect(inheritedHarness(TWO, { harness: "other" }, "other")).toBeNull();
  });
});
