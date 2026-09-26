import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteRepoState,
  ensureRepoConfig,
  listPrs,
  listRepos,
  readLocalChatInstructions,
  readLocalRubric,
  readRepoConfig,
  repoConfigExists,
  writeLocalChatInstructions,
  writeLocalRubric,
  writeMeta,
  writeRepoConfig,
} from "../src/store.js";
import {
  checkoutsRoot,
  repoChatInstructionsPath,
  repoConfigPath,
  repoDir,
  repoRubricPath,
} from "../src/paths.js";
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

describe("repo-level archive in repo.json", () => {
  it("round-trips, and a repo.json written before the field existed reads as not archived", () => {
    fs.mkdirSync(path.dirname(repoConfigPath(repo, root)), { recursive: true });
    fs.writeFileSync(
      repoConfigPath(repo, root),
      JSON.stringify({ autoAnalyze: null, repoPath: "/keep", watchReviews: true }),
    );
    expect(readRepoConfig(repo, root)).toEqual({
      ...EMPTY_REPO_CONFIG,
      repoPath: "/keep",
      watchReviews: true,
      archived: null,
    });

    writeRepoConfig(repo, { archived: true }, root);
    expect(readRepoConfig(repo, root)).toMatchObject({ repoPath: "/keep", watchReviews: true, archived: true });
    writeRepoConfig(repo, { archived: null }, root);
    expect(readRepoConfig(repo, root).archived).toBeNull();
  });

  it("salvages the flag, and drops a wrong-typed one, when another field is invalid", () => {
    fs.mkdirSync(path.dirname(repoConfigPath(repo, root)), { recursive: true });
    fs.writeFileSync(repoConfigPath(repo, root), JSON.stringify({ autoAnalyze: "yes", archived: true }));
    expect(readRepoConfig(repo, root).archived).toBe(true);
    fs.writeFileSync(repoConfigPath(repo, root), JSON.stringify({ autoAnalyze: "yes", archived: "yes" }));
    expect(readRepoConfig(repo, root).archived).toBeNull();
  });
});

describe("deleteRepoState", () => {
  it("removes the repo dir (PRs and repo files) and nothing beside it", () => {
    seedPr(7);
    writeRepoConfig(repo, { archived: true }, root);
    writeLocalRubric(repo, "overlay", root);
    const sibling = { ...repo, repo: "gadgets" };
    writeRepoConfig(sibling, {}, root);
    fs.mkdirSync(checkoutsRoot(root), { recursive: true });

    expect(deleteRepoState(repo, root)).toBe(true);
    expect(fs.existsSync(repoDir(repo, root))).toBe(false);
    expect(listPrs(root)).toEqual([]);
    expect(listRepos(root)).toEqual([sibling]);
    expect(fs.existsSync(checkoutsRoot(root))).toBe(true);
    expect(deleteRepoState(repo, root)).toBe(false);
  });

  it("drops the owner and host dirs once empty, never the root", () => {
    seedPr(7);
    deleteRepoState(repo, root);
    expect(fs.existsSync(path.join(root, repo.host))).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("refuses keys that could reach outside one repo dir", () => {
    for (const bad of [
      { ...repo, repo: ".." },
      { ...repo, owner: "." },
      { ...repo, repo: "" },
      { ...repo, owner: "a/b" },
      { host: "checkouts", owner: "acme", repo: "widgets" },
    ]) {
      expect(() => deleteRepoState(bad, root)).toThrow(/Refusing/);
    }
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

describe("CHAT.local.md", () => {
  it("reads as an empty string when absent, and an empty write deletes it", () => {
    expect(readLocalChatInstructions(repo, root)).toBe("");
    writeLocalChatInstructions(repo, "# House chat rules\n", root);
    expect(readLocalChatInstructions(repo, root)).toBe("# House chat rules\n");
    expect(fs.existsSync(repoChatInstructionsPath(repo, root))).toBe(true);
    writeLocalChatInstructions(repo, "", root);
    expect(fs.existsSync(repoChatInstructionsPath(repo, root))).toBe(false);
    expect(readLocalChatInstructions(repo, root)).toBe("");
  });
});

describe("listing", () => {
  it("lists repos, and repo-level files never look like a PR", () => {
    seedPr(7);
    seedPr(9);
    ensureRepoConfig(repo, root);
    writeLocalRubric(repo, "overlay", root);
    writeLocalChatInstructions(repo, "chat overlay", root);

    expect(listRepos(root)).toEqual([repo]);
    expect(listPrs(root).map((k) => k.number).sort()).toEqual([7, 9]);
  });

  it("lists a repo that has settings but no PRs yet", () => {
    writeRepoConfig(repo, { autoAnalyze: true }, root);
    expect(listRepos(root)).toEqual([repo]);
    expect(listPrs(root)).toEqual([]);
  });
});
