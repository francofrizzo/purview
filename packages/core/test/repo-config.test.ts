import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureRepoConfig,
  listPrs,
  listRepos,
  readLocalRubric,
  readRepoConfig,
  repoConfigExists,
  writeLocalRubric,
  writeMeta,
  writeRepoConfig,
} from "../src/store.js";
import { repoConfigPath, repoRubricPath } from "../src/paths.js";
import { EMPTY_REPO_CONFIG } from "../src/schemas.js";

const repo = { host: "github.com", owner: "acme", repo: "widgets" };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-repocfg-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedPr(number: number): void {
  writeMeta(
    { ...repo, number },
    {
      ...repo,
      number,
      url: `https://github.com/acme/widgets/pull/${number}`,
      createdAt: new Date().toISOString(),
      archived: false,
    },
    root,
  );
}

describe("repo.json", () => {
  it("defaults every field to null (inherit) and creates an empty file on demand", () => {
    expect(readRepoConfig(repo, root)).toEqual(EMPTY_REPO_CONFIG);
    expect(repoConfigExists(repo, root)).toBe(false);

    ensureRepoConfig(repo, root);

    expect(repoConfigExists(repo, root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(repoConfigPath(repo, root), "utf8"))).toEqual(
      EMPTY_REPO_CONFIG,
    );
    // Idempotent: a second call must not clobber what was set meanwhile.
    writeRepoConfig(repo, { autoAnalyze: true }, root);
    ensureRepoConfig(repo, root);
    expect(readRepoConfig(repo, root).autoAnalyze).toBe(true);
  });

  it("merges patches instead of overwriting the whole file", () => {
    writeRepoConfig(repo, { repoPath: "/src/widgets" }, root);
    writeRepoConfig(repo, { autoAnalyze: false }, root);
    expect(readRepoConfig(repo, root)).toEqual({
      ...EMPTY_REPO_CONFIG,
      autoAnalyze: false,
      repoPath: "/src/widgets",
    });
  });

  it("parses tolerantly: garbage and wrong types fall back to inherit", () => {
    fs.mkdirSync(path.dirname(repoConfigPath(repo, root)), { recursive: true });
    fs.writeFileSync(repoConfigPath(repo, root), "{not json");
    expect(readRepoConfig(repo, root)).toEqual(EMPTY_REPO_CONFIG);

    fs.writeFileSync(
      repoConfigPath(repo, root),
      JSON.stringify({ autoAnalyze: "yes", repoPath: "/keep/me", extra: 1 }),
    );
    expect(readRepoConfig(repo, root)).toEqual({
      ...EMPTY_REPO_CONFIG,
      autoAnalyze: null,
      repoPath: "/keep/me",
    });
  });
});

describe("model settings in repo.json", () => {
  it("round-trips the CLI aliases and defaults them to inherit", () => {
    expect(readRepoConfig(repo, root).analysisModel).toBeNull();
    writeRepoConfig(repo, { analysisModel: "opus" }, root);
    expect(readRepoConfig(repo, root).analysisModel).toBe("opus");
    // Independent of each other, and of autoAnalyze.
    expect(readRepoConfig(repo, root).chatModel).toBeNull();
    writeRepoConfig(repo, { chatModel: "haiku" }, root);
    expect(readRepoConfig(repo, root)).toMatchObject({
      analysisModel: "opus",
      chatModel: "haiku",
    });
  });

  it("rejects anything that is not an alias, salvaging the rest of the file", () => {
    fs.mkdirSync(path.dirname(repoConfigPath(repo, root)), { recursive: true });
    // A pinned model id is exactly the mistake this guards against: it rots.
    fs.writeFileSync(
      repoConfigPath(repo, root),
      JSON.stringify({ analysisModel: "claude-opus-4-6", chatModel: "haiku", repoPath: "/keep" }),
    );
    expect(readRepoConfig(repo, root)).toEqual({
      ...EMPTY_REPO_CONFIG,
      analysisModel: null,
      chatModel: "haiku",
      repoPath: "/keep",
    });
  });
});

describe("RUBRIC.local.md", () => {
  it("reads as an empty string when absent, and an empty write deletes it", () => {
    expect(readLocalRubric(repo, root)).toBe("");
    writeLocalRubric(repo, "# House rules\n", root);
    expect(readLocalRubric(repo, root)).toBe("# House rules\n");
    expect(fs.existsSync(repoRubricPath(repo, root))).toBe(true);
    writeLocalRubric(repo, "", root);
    expect(fs.existsSync(repoRubricPath(repo, root))).toBe(false);
    expect(readLocalRubric(repo, root)).toBe("");
  });
});

describe("listing", () => {
  it("lists repos, and repo-level files never look like a PR", () => {
    seedPr(7);
    seedPr(9);
    ensureRepoConfig(repo, root);
    writeLocalRubric(repo, "overlay", root);

    expect(listRepos(root)).toEqual([repo]);
    expect(listPrs(root).map((k) => k.number).sort()).toEqual([7, 9]);
  });

  it("lists a repo that has settings but no PRs yet", () => {
    writeRepoConfig(repo, { autoAnalyze: true }, root);
    expect(listRepos(root)).toEqual([repo]);
    expect(listPrs(root)).toEqual([]);
  });
});
