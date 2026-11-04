import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setGhRunner, UnitDiagramSchema } from "@reviewer/core";
import { analysisPrompt } from "../src/analysis.js";
import { reviewSystemPrompt } from "../src/agent/review-tools/prompts.js";
import { writeConfig } from "../src/config.js";
import { buildFixture, key } from "./fixtures.js";

/** The unitDiagrams experiment: the prompts ask for diagrams only while it is on. */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-unit-diagrams-"));
  process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
  setGhRunner((args) => {
    throw new Error(`unexpected gh ${args.join(" ")}`);
  });
  buildFixture(root);
});

afterEach(() => {
  setGhRunner(null);
  delete process.env.REVIEWER_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("unit diagram prompt lines", () => {
  it("are absent while the experiment is off", () => {
    for (const incremental of [false, true]) {
      expect(analysisPrompt(key, root, { incremental })).not.toContain("Unit diagrams");
      expect(reviewSystemPrompt(key, root, { task: "analysis", incremental }).split("===== WRITING GUIDE =====")[0]).not.toContain("Unit diagrams");
    }
  });

  it("ask for a diagram on an initial run and let a refresh patch or drop one, in both flows", () => {
    writeConfig({ experiments: { unitDiagrams: true } as never }, root);
    expect(analysisPrompt(key, root, { incremental: false })).toContain("Give a unit a `diagram` only where");
    expect(analysisPrompt(key, root, { incremental: true })).toContain("`\"diagram\": null` drops one");
    expect(reviewSystemPrompt(key, root, { task: "analysis", incremental: false })).toContain("Give a unit a diagram only where");
    expect(reviewSystemPrompt(key, root, { task: "analysis", incremental: true })).toContain("diagram: null drops one");
  });
});

it("the writing guide's example diagram passes the schema", () => {
  const guide = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/pr-review/WRITING.md"),
    "utf8",
  );
  const section = guide.slice(guide.indexOf("### Unit diagrams"));
  const json = section.match(/```json\s*([\s\S]*?)```/)![1];
  const parsed = JSON.parse(`{${json}}`) as { diagram: unknown };
  expect(UnitDiagramSchema.safeParse(parsed.diagram).success).toBe(true);
});
