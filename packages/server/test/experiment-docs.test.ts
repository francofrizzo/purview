import { describe, expect, it } from "vitest";
import { analysisSystemPrompt } from "../src/analysis.js";
import { withExperiments } from "../src/experiment-docs.js";

describe("withExperiments", () => {
  const doc = [
    "Intro.",
    "<!-- experiment:alpha -->",
    "### Alpha",
    "Alpha body.",
    "<!-- /experiment:alpha -->",
    "",
    "Outro.",
    "",
  ].join("\n");

  it("drops a block whose experiment is off, markers included", () => {
    expect(withExperiments(doc, () => false)).toBe("Intro.\n\nOutro.\n");
  });

  it("keeps a block whose experiment is on, without its markers", () => {
    expect(withExperiments(doc, (id) => id === "alpha")).toBe("Intro.\n### Alpha\nAlpha body.\n\nOutro.\n");
  });
});

describe("the analysis prompt with every experiment off", () => {
  for (const incremental of [false, true]) {
    it(`never mentions an experiment (${incremental ? "refresh" : "first analysis"})`, () => {
      const off = analysisSystemPrompt({ incremental });
      expect(off).not.toMatch(/behaviorChanges|Behavior changes|Unit diagrams|"diagram"/);
      expect(off).not.toContain("<!-- experiment:");
      const on = analysisSystemPrompt({ incremental, experiments: { behaviorChanges: true, unitDiagrams: true } });
      expect(on).toContain("### Behavior changes");
      expect(on).toContain("### Unit diagrams");
      expect(on).not.toContain("<!-- experiment:");
    });
  }
});
