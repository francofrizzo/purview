import { describe, expect, it } from "vitest";
import { analysisSystemPrompt } from "../src/analysis.js";
import { withExperiments } from "../src/experiment-docs.js";
import { EXPERIMENT_IDS } from "../src/config.js";

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
      // Graduated: behavior changes and unit diagrams are asked for with every experiment off.
      expect(off).toContain("### Behavior changes");
      expect(off).toContain("### Unit diagrams");
      expect(off).not.toContain("<!-- experiment:");
      // An experiment that is on never leaks its markers; with none, nothing to check.
      for (const id of EXPERIMENT_IDS as readonly string[]) {
        const on = analysisSystemPrompt({ incremental, experiments: { [id]: true } });
        expect(on).not.toContain("<!-- experiment:");
      }
    });
  }
});
