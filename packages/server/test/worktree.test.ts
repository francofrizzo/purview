import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listWorktrees,
  repoToplevel,
  resolveCheckout,
  setGitRunner,
} from "../src/worktree.js";
import { addDetachedWorktree, addWorktree, git, makeRepo } from "./git-fixtures.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-wt-"));
});

afterEach(() => {
  setGitRunner(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("repoToplevel", () => {
  it("resolves from a subdirectory of the checkout", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    const sub = path.join(repo.path, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect(repoToplevel(sub)).toBe(fs.realpathSync(repo.path));
  });

  it("resolves from inside a worktree, whose .git is a file not a directory", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    const wt = addWorktree(repo.path, path.join(dir, "feature"), "feature-x");
    expect(fs.statSync(path.join(wt.path, ".git")).isFile()).toBe(true);
    expect(repoToplevel(wt.path)).toBe(fs.realpathSync(wt.path));
  });

  it("returns undefined for a plain directory", () => {
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    expect(repoToplevel(plain)).toBeUndefined();
  });
});

describe("listWorktrees", () => {
  it("lists the main checkout and every worktree with its branch", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    addWorktree(repo.path, path.join(dir, "feature"), "feature-x");
    const entries = listWorktrees(repo.path);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.branch).sort()).toEqual(["feature-x", "main"]);
    expect(entries.every((e) => !!e.head)).toBe(true);
  });

  it("is empty rather than throwing outside a repo", () => {
    expect(listWorktrees(dir)).toEqual([]);
  });
});

describe("resolveCheckout", () => {
  it("picks the worktree whose branch is the PR head, given the main checkout", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    const wt = addWorktree(repo.path, path.join(dir, "feature"), "feature-x");
    const res = resolveCheckout(repo.path, { headRef: "feature-x", headSha: wt.headSha });
    expect(res.path).toBe(fs.realpathSync(wt.path));
    expect(res.resolvedWorktree).toBe(true);
    expect(res.mismatch).toBeUndefined();
  });

  it("picks the same worktree when the reader pasted the worktree itself", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    const wt = addWorktree(repo.path, path.join(dir, "feature"), "feature-x");
    const res = resolveCheckout(wt.path, { headRef: "feature-x" });
    expect(res.path).toBe(fs.realpathSync(wt.path));
    expect(res.mismatch).toBeUndefined();
  });

  it("matches on head sha when no branch name matches (detached worktree)", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    const prSha = repo.headSha;
    // Move main on, so only the detached worktree sits on the PR's head.
    fs.writeFileSync(path.join(repo.path, "other.ts"), "export const x = 1;\n");
    git(["add", "."], repo.path);
    git(["commit", "-q", "-m", "later work"], repo.path);

    const detached = addDetachedWorktree(repo.path, path.join(dir, "detached"), prSha);
    expect(detached.headSha).toBe(prSha);
    const res = resolveCheckout(repo.path, { headRef: "renamed-on-github", headSha: prSha });
    expect(res.path).toBe(fs.realpathSync(detached.path));
  });

  it("falls back to the stored checkout and reports the mismatch when nothing matches", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    const res = resolveCheckout(repo.path, { headRef: "feature-x", headSha: "deadbeef" });
    expect(res.path).toBe(fs.realpathSync(repo.path));
    expect(res.resolvedWorktree).toBe(false);
    expect(res.mismatch).toEqual({ checkedOutBranch: "main", prHeadRef: "feature-x" });
  });

  it("reports an error instead of a path when the checkout was deleted", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    fs.rmSync(repo.path, { recursive: true, force: true });
    const res = resolveCheckout(repo.path, { headRef: "feature-x" });
    expect(res.path).toBeUndefined();
    expect(res.error).toContain("no longer exists");
  });

  it("reports an error when the path is no longer a git repository", () => {
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    const res = resolveCheckout(plain, { headRef: "feature-x" });
    expect(res.path).toBeUndefined();
    expect(res.error).toContain("not a git repository");
  });

  it("skips a worktree whose directory was removed behind git's back", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    const wt = addWorktree(repo.path, path.join(dir, "feature"), "feature-x");
    fs.rmSync(wt.path, { recursive: true, force: true }); // still listed, gone on disk
    const res = resolveCheckout(repo.path, { headRef: "feature-x" });
    expect(res.path).toBe(fs.realpathSync(repo.path));
    expect(res.mismatch).toEqual({ checkedOutBranch: "main", prHeadRef: "feature-x" });
  });

  it("degrades to no checkout when git itself fails", () => {
    const repo = makeRepo(path.join(dir, "repo"), { origin: "git@github.com:acme/widgets.git" });
    setGitRunner(() => {
      throw new Error("git: command not found");
    });
    const res = resolveCheckout(repo.path, { headRef: "feature-x" });
    expect(res.path).toBeUndefined();
    expect(res.error).toContain("not a git repository");
  });

  it("does nothing when no path is stored", () => {
    expect(resolveCheckout(undefined, { headRef: "x" })).toEqual({ resolvedWorktree: false });
  });
});
