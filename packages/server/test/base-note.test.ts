import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearDefaultBranchCache,
  readMeta,
  repoGithubCachePath,
  repoKeyOf,
  setGhRunner,
  updateMeta,
  type GhRunner,
} from "@reviewer/core";
import { analysisPrompt } from "../src/analysis.js";
import { baseNote, formatBaseNote } from "../src/base-note.js";
import { chatSystemPrompt, terminalContext } from "../src/chat.js";
import { checkStaleness, clearStalenessCache } from "../src/staleness.js";
import { buildFixture, key } from "./fixtures.js";

const BASE_PR = {
  number: 8501,
  title: "Deuda provincia",
  url: "https://github.com/acme/widgets/pull/8501",
};
const STACKED_REF = "codex/provincia-seguros-deuda-ENG-5681";

const NORMAL = "Base: this PR targets main (the default branch).";
const STACKED_PR =
  `Base: this PR is STACKED. It targets ${STACKED_REF}, which is the head of #8501 "Deuda provincia" ` +
  "(https://github.com/acme/widgets/pull/8501), not main. The diff shows only this PR's own changes on top of #8501. " +
  "Code that looks new but isn't in the diff came from #8501, so review it there, not here.";
const STACKED_PR_MANAGED = STACKED_PR + " `base-file` shows files as #8501 leaves them.";
const STACKED_BRANCH =
  `Base: this PR is STACKED. It targets ${STACKED_REF}, not main. The diff shows only this PR's own changes on top of ${STACKED_REF}. ` +
  `Code that looks new but isn't in the diff came from ${STACKED_REF}, so review it there, not here.`;

const managed = {
  path: "/co/7",
  resolvedWorktree: true,
  managed: { headSha: "a".repeat(40) },
};
const unmanaged = { path: "/repo", resolvedWorktree: false };

let root: string;

function seedDefaultBranch(branch: string) {
  const file = repoGithubCachePath(repoKeyOf(key), root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ defaultBranch: branch, fetchedAt: new Date().toISOString() }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-base-note-"));
  process.env.REVIEWER_SKILL_DIR = path.join(root, "skills");
  process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
  clearDefaultBranchCache();
  clearStalenessCache();
  // The prompt path must never reach GitHub.
  setGhRunner((args) => {
    throw new Error(`unexpected gh ${args.join(" ")}`);
  });
  buildFixture(root);
});

afterEach(() => {
  setGhRunner(null);
  clearDefaultBranchCache();
  clearStalenessCache();
  delete process.env.REVIEWER_SKILL_DIR;
  delete process.env.REVIEWER_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("formatBaseNote", () => {
  it("normal PR", () => {
    expect(formatBaseNote({ baseRef: "main", basePr: null }, "main", { managed: true })).toBe(NORMAL);
  });

  it("stacked on a known PR; base-file only with a managed checkout", () => {
    const meta = { baseRef: STACKED_REF, basePr: BASE_PR };
    expect(formatBaseNote(meta, "main", { managed: false })).toBe(STACKED_PR);
    expect(formatBaseNote(meta, "main", { managed: true })).toBe(STACKED_PR_MANAGED);
  });

  it("stacked, base PR unknown", () => {
    const meta = { baseRef: STACKED_REF, basePr: null };
    expect(formatBaseNote(meta, "main", { managed: false })).toBe(STACKED_BRANCH);
    expect(formatBaseNote(meta, "main", { managed: true })).toBe(
      STACKED_BRANCH + ` \`base-file\` shows files as they are on ${STACKED_REF}.`,
    );
  });

  it("prints nothing when baseRef or the default branch is unknown", () => {
    expect(formatBaseNote({}, "main", { managed: true })).toBe("");
    expect(formatBaseNote({ baseRef: STACKED_REF, basePr: BASE_PR }, null, { managed: true })).toBe("");
  });
});

describe("the base line in the prompts", () => {
  const setStacked = () => {
    seedDefaultBranch("main");
    updateMeta(key, { baseRef: STACKED_REF, basePr: BASE_PR }, root);
  };

  it("analysis prompt: right after the checkout note", () => {
    setStacked();
    const prompt = analysisPrompt(key, root, { incremental: false, checkout: managed });
    const lines = prompt.split("\n");
    const i = lines.findIndex((l) => l.startsWith("An exact checkout of the PR head"));
    expect(lines[i + 1]).toBe(STACKED_PR_MANAGED);
  });

  it("analysis prompt: no base-file mention without a managed checkout", () => {
    setStacked();
    const prompt = analysisPrompt(key, root, { incremental: false, checkout: unmanaged });
    expect(prompt).toContain(STACKED_PR);
    expect(prompt).not.toContain("`base-file` shows");
    const none = analysisPrompt(key, root, { incremental: false });
    expect(none).toContain(STACKED_PR);
    expect(none).not.toContain("`base-file` shows");
  });

  it("chat system prompt and terminal context: stacked with PR", () => {
    setStacked();
    const chat = chatSystemPrompt(key, root, { resolution: managed });
    expect(chat).toContain(`current revision 1\n${STACKED_PR_MANAGED}\n`);
    expect(chatSystemPrompt(key, root, { resolution: unmanaged })).not.toContain("`base-file` shows");
    expect(terminalContext(key, root, { checkout: { resolution: managed } })).toContain(STACKED_PR_MANAGED);
  });

  it("chat: normal and stacked-without-PR", () => {
    seedDefaultBranch("main");
    updateMeta(key, { baseRef: "main", basePr: null }, root);
    expect(chatSystemPrompt(key, root)).toContain(`current revision 1\n${NORMAL}\n`);
    updateMeta(key, { baseRef: STACKED_REF, basePr: null }, root);
    expect(chatSystemPrompt(key, root)).toContain(STACKED_BRANCH);
  });

  it("unknown (old meta, or no cached default branch): nothing, and no gh call", () => {
    // Old meta: no baseRef at all.
    seedDefaultBranch("main");
    expect(baseNote(key, root, managed)).toBe("");
    expect(chatSystemPrompt(key, root)).not.toContain("Base:");
    expect(analysisPrompt(key, root, { incremental: false })).not.toContain("Base:");
    // baseRef known but the default branch was never read.
    fs.rmSync(repoGithubCachePath(repoKeyOf(key), root));
    clearDefaultBranchCache();
    updateMeta(key, { baseRef: STACKED_REF }, root);
    expect(chatSystemPrompt(key, root)).not.toContain("Base:");
  });
});

describe("staleness backfills baseRef/basePr on old meta", () => {
  it("fills them in on the next poll, then stops asking", () => {
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push([...args]);
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify([BASE_PR]);
      if (args[1] === "graphql") return JSON.stringify({ data: {} });
      if (args[1] === "repos/acme/widgets") return JSON.stringify({ default_branch: "main" });
      return JSON.stringify({
        node_id: "PR_1",
        number: key.number,
        title: "Add widgets",
        html_url: "https://github.com/acme/widgets/pull/7",
        state: "open",
        base: { ref: STACKED_REF, sha: "base1" },
        head: { ref: "feature", sha: "head1" },
      });
    };
    setGhRunner(runner);
    expect(readMeta(key, root).baseRef).toBeUndefined();

    checkStaleness(key, root, { force: true });
    expect(readMeta(key, root)).toMatchObject({ baseRef: STACKED_REF, basePr: BASE_PR });
    expect(chatSystemPrompt(key, root)).toContain(STACKED_PR);

    const before = calls.length;
    checkStaleness(key, root, { force: true });
    const extra = calls.slice(before).filter((c) => c[0] === "pr" || c[1] === "repos/acme/widgets");
    expect(extra).toHaveLength(0);
  });
});
