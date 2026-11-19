import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { loadState, setGhRunner } from "@reviewer/core";
import { analysisPrompt } from "../src/analysis.js";
import { reviewRunPrompt } from "../src/agent/review-tools/prompts.js";
import { createReviewOperations } from "../src/agent/review-tools/operations.js";
import { writeConfig } from "../src/config.js";
import type { AgentRunRequest } from "../src/agent/types.js";
import { buildFixture, key } from "./fixtures.js";

/** The `findingKinds` experiment: asked for and shown to the run only while it is on. */

let root: string;
let checkout: string;
let hunkIds: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-kinds-"));
  process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
  setGhRunner((args) => {
    throw new Error(`unexpected gh ${args.join(" ")}`);
  });
  ({ hunkIds } = buildFixture(root));
  checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  execFileSync("git", ["init", "-q", checkout]);
});

afterEach(() => {
  setGhRunner(null);
  delete process.env.REVIEWER_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

const checkoutOf = () => ({ path: checkout, resolvedWorktree: false });
const request = (): AgentRunRequest => ({
  task: { kind: "analysis", scratchDir: root, reviewerCommands: [] },
  review: { root, key, revision: 1, checkout, analysisMode: "initial" },
  cwd: checkout, prompt: "review", model: "test",
});
const shown = (name: string) => {
  const tool = createReviewOperations(request(), "test").tools.find((t) => t.name === name)!;
  const json = toJsonSchemaCompat(tool.schema) as Record<string, unknown>;
  return JSON.stringify(tool.wire ? tool.wire(json) : json);
};

describe("with the experiment off", () => {
  it("no prompt asks for kinds, and set_analysis shows findings without one", () => {
    for (const incremental of [false, true]) {
      expect(analysisPrompt(key, root, { incremental, checkout: checkoutOf() })).not.toContain("FINDING KINDS");
      expect(reviewRunPrompt(key, root, checkoutOf(), incremental)).not.toContain("FINDING KINDS");
    }
    const schema = shown("set_analysis");
    expect(schema).toContain('"evidence"');
    expect(schema).not.toContain('"untested"');
  });
});

describe("with the experiment on", () => {
  beforeEach(() => writeConfig({ experiments: { findingKinds: true } }, root));

  it("both flows ask for a kind on every warning, only with a checkout", () => {
    for (const incremental of [false, true]) {
      expect(analysisPrompt(key, root, { incremental, checkout: checkoutOf() })).toContain("FINDING KINDS: give every warning a `kind`.");
      expect(reviewRunPrompt(key, root, checkoutOf(), incremental)).toContain("FINDING KINDS");
    }
    expect(analysisPrompt(key, root, { incremental: false })).not.toContain("FINDING KINDS");
  });

  it("set_analysis shows the kinds and saves one", async () => {
    expect(shown("set_analysis")).toContain('"untested"');
    await createReviewOperations(request(), "test").execute("set_analysis", {
      summary: "Change foo",
      units: [{
        id: "foo", title: "Change foo", summary: "The value changes", kind: "core-logic", attention: "must-read", attentionWhy: "w", order: 0, hunks: hunkIds,
        findings: [{ severity: "warning", kind: "bug", text: "The caller ignores the new error", evidence: "src/foo.ts:2" }],
      }],
      unassigned: [],
    });
    expect(loadState(key, root).units.find((u) => u.id === "foo")?.findings?.[0].kind).toBe("bug");
  });
});
