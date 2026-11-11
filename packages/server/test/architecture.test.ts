import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ArchitectureSchema, loadState, repoKeyOf, repoKeyToString, setGhRunner, writeRepoConfig } from "@reviewer/core";
import { analysisPrompt, analysisSystemPrompt } from "../src/analysis.js";
import { reviewRunPrompt, reviewSystemPrompt } from "../src/agent/review-tools/prompts.js";
import { createReviewOperations } from "../src/agent/review-tools/operations.js";
import { createApp } from "../src/app.js";
import { writeConfig } from "../src/config.js";
import { skillDir } from "../src/skill-paths.js";
import type { AgentRunRequest } from "../src/agent/types.js";
import { buildFixture, key } from "./fixtures.js";

/** The `architecture` experiment: asked for, shown and checked only while it is on. */

let root: string;
let checkout: string;
let hunkIds: string[];

const RULE = "Only `src/foo.ts` holds the values; nothing else writes them.";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-arch-"));
  process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
  setGhRunner((args) => {
    throw new Error(`unexpected gh ${args.join(" ")}`);
  });
  ({ hunkIds } = buildFixture(root));
  checkout = path.join(root, "checkout");
  fs.mkdirSync(path.join(checkout, "docs"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "docs/architecture.md"), `# Architecture\n\n## Values\n\n${RULE}\n`);
  execFileSync("git", ["init", "-q", checkout]);
});

afterEach(() => {
  setGhRunner(null);
  delete process.env.REVIEWER_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

const on = () => writeConfig({ experiments: { architecture: true } }, root);
const checkoutOf = () => ({ path: checkout, resolvedWorktree: false });
const request = (): AgentRunRequest => ({
  task: { kind: "analysis", scratchDir: root, reviewerCommands: [] },
  review: { root, key, revision: 1, checkout, analysisMode: "initial" },
  cwd: checkout, prompt: "review", model: "test",
});
const analysis = (extra = {}) => ({
  summary: "Change foo",
  units: [{ id: "foo", title: "Change foo", summary: "The value changes", kind: "core-logic", attention: "must-read", attentionWhy: "w", order: 0, hunks: hunkIds }],
  unassigned: [],
  ...extra,
});
const view = (quote = RULE) => ({
  sources: ["docs/architecture.md"],
  checked: [{ source: "docs/architecture.md", rule: quote }],
  deviations: [],
  decisions: [],
});

describe("with the experiment off", () => {
  it("no prompt asks for it, in either flow, first analysis or refresh", () => {
    for (const incremental of [false, true]) {
      expect(analysisPrompt(key, root, { incremental, checkout: checkoutOf() })).not.toMatch(/ARCHITECTURE|architecture/);
      expect(reviewRunPrompt(key, root, checkoutOf(), incremental)).not.toMatch(/ARCHITECTURE|architecture/);
      expect(analysisSystemPrompt({ incremental })).not.toContain("### Architecture");
      expect(reviewSystemPrompt(key, root, { task: "analysis", incremental })).not.toContain("### Architecture");
    }
  });

  it("the tools neither take the field nor show it", async () => {
    const ops = createReviewOperations(request(), "test");
    const tool = (name: string) => ops.tools.find((t) => t.name === name)!.schema as unknown as { shape: Record<string, unknown> };
    expect(tool("set_analysis").shape).not.toHaveProperty("architecture");
    expect(await ops.execute("review_context", {})).not.toHaveProperty("architecture");
  });
});

describe("with the experiment on", () => {
  beforeEach(on);

  it("the guide's section reaches both flows, without its markers", () => {
    for (const incremental of [false, true]) {
      for (const prompt of [analysisSystemPrompt({ incremental, experiments: { architecture: true } }), reviewSystemPrompt(key, root, { task: "analysis", incremental })]) {
        expect(prompt).toContain("### Architecture");
        expect(prompt).not.toContain("<!-- experiment:");
      }
    }
  });

  it("a first analysis is told where to look, or which docs the repo settings name and to look no further", () => {
    expect(analysisPrompt(key, root, { incremental: false, checkout: checkoutOf() })).toContain("ARCHITECTURE (WRITING.md, 'Architecture'): Look for the repo's documented architecture: ARCHITECTURE.md");
    expect(reviewRunPrompt(key, root, checkoutOf(), false)).toContain("ARCHITECTURE (WRITING GUIDE, 'Architecture'): Look for");
    writeRepoConfig(repoKeyOf(key), { architectureDocs: ["docs/architecture.md", "docs/adr"] }, root);
    const told = analysisPrompt(key, root, { incremental: false, checkout: checkoutOf() });
    expect(told).toContain("documented in `docs/architecture.md`, `docs/adr` (its repo settings): read those, and look for no other docs.");
    expect(told).not.toContain("Look for the repo's documented architecture");
    // Nothing to check quotes in: left out.
    expect(analysisPrompt(key, root, { incremental: false })).toContain("there is no checkout to check rule quotes against");
  });

  it("a refresh redraws a view the PR has, and does not search again for one it has not", async () => {
    expect(analysisPrompt(key, root, { incremental: true, checkout: checkoutOf() })).not.toContain("ARCHITECTURE");
    await createReviewOperations(request(), "test").execute("set_analysis", analysis({ architecture: view() }));
    expect(analysisPrompt(key, root, { incremental: true, checkout: checkoutOf() })).toContain("redraw it whole with `set-shape` after `set-units`");
    expect(reviewRunPrompt(key, root, checkoutOf(), true)).toContain("redraw it whole with set_shape");
  });

  it("set_analysis checks the quotes in the run's checkout and passes back what to fix", async () => {
    const ops = createReviewOperations(request(), "test");
    await expect(ops.execute("set_analysis", analysis({ architecture: view("Nothing writes the values.") }))).rejects.toMatchObject({
      code: "invalid_payload",
      message: expect.stringMatching(/architecture\.checked\[0\]: "Nothing writes the values\." is not in docs\/architecture\.md/),
    });
    await ops.execute("set_analysis", analysis({ architecture: view() }));
    expect(loadState(key, root).architecture?.checked[0].rule).toBe(RULE);
    expect(await ops.execute("review_context", {})).toBeTypeOf("object");
  });
});

it("the guide's example view passes the schema", () => {
  const guide = fs.readFileSync(path.join(skillDir(), "WRITING.md"), "utf8");
  const section = guide.split("### Architecture")[1].split("<!-- /experiment:architecture -->")[0];
  const json = /```json\n"architecture": ([\s\S]*?)\n```/.exec(section)![1];
  expect(ArchitectureSchema.safeParse(JSON.parse(json)).success).toBe(true);
});

describe("the repo setting", () => {
  it("stores the docs, trimmed and without blanks, and refuses a path out of the repo", async () => {
    const app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
    const rkey = encodeURIComponent(repoKeyToString(repoKeyOf(key)));
    const put = (body: unknown) => app.request(`/api/repos/${rkey}/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const res = await put({ architectureDocs: [" docs/architecture.md ", "", "./AGENTS.md"] });
    expect(res.status).toBe(200);
    expect((await res.json()).local.architectureDocs).toEqual(["docs/architecture.md", "AGENTS.md"]);
    expect((await put({ architectureDocs: ["../secrets.md"] })).status).toBe(400);
    expect((await put({ architectureDocs: ["/etc/passwd"] })).status).toBe(400);
  });
});
