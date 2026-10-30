import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  keyToString,
  loadState,
  parseDiff,
  prCheckoutPath,
  readDiff,
  setGhRunner,
  updateMeta,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { localPrDiff } from "../src/pr-checkout.js";
import { buildFixture, key } from "./fixtures.js";
import { cloneRepo, git, makePrRemote, makeRepo, type PrRemote } from "./git-fixtures.js";

/**
 * The PR diff from a local clone, against real git: a temp "GitHub" remote
 * that exposes the PR head only as refs/pull/<n>/head (base commit, then a PR
 * commit that edits, renames and adds), and the reader's clone of it.
 */

let root: string;
let work: string;
let remote: PrRemote;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-localdiff-state-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "purview-localdiff-work-"));
  remote = makePrRemote(path.join(work, "gh", "acme", "widgets"), key.number);
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

/** The unified diff GitHub serves for this range: git's defaults, 11-char abbrevs. */
function expectGithubShape(diff: string) {
  const short = (sha: string) => sha.slice(0, 11);
  const blob = (rev: string, file: string) => short(git(["rev-parse", `${rev}:${file}`], remote.path));
  expect(diff).toBe(
    `diff --git a/added.ts b/added.ts\n` +
      `new file mode 100644\n` +
      `index 00000000000..${blob(remote.headSha, "added.ts")}\n` +
      `--- /dev/null\n` +
      `+++ b/added.ts\n` +
      `@@ -0,0 +1 @@\n` +
      `+export const added = 1;\n` +
      `diff --git a/legacy.ts b/modern.ts\n` +
      `similarity index 100%\n` +
      `rename from legacy.ts\n` +
      `rename to modern.ts\n` +
      `diff --git a/pricing.ts b/pricing.ts\n` +
      `index ${blob(remote.baseSha, "pricing.ts")}..${blob(remote.headSha, "pricing.ts")} 100644\n` +
      `--- a/pricing.ts\n` +
      `+++ b/pricing.ts\n` +
      `@@ -1 +1 @@\n` +
      `-export const rate = 0.1;\n` +
      `+export const rate = 0.2;\n`,
  );
  expect(parseDiff(diff).map((f) => f.path)).toEqual(["added.ts", "modern.ts", "pricing.ts"]);
}

describe("localPrDiff", () => {
  it("fetches the PR head into the clone and diffs merge base..head in GitHub's format", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    // The reader's own git settings must not reach the bytes.
    git(["config", "diff.noprefix", "true"], user);
    git(["config", "diff.mnemonicPrefix", "true"], user);
    git(["config", "diff.algorithm", "patience"], user);
    git(["config", "color.diff", "always"], user);
    git(["config", "core.abbrev", "7"], user);
    const before = {
      head: git(["rev-parse", "HEAD"], user),
      branch: git(["symbolic-ref", "HEAD"], user),
      refs: git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"], user),
    };
    expect(() => git(["cat-file", "-e", `${remote.headSha}^{commit}`], user)).toThrow();

    const diff = await localPrDiff(key, remote.baseSha, remote.headSha, { root, repoPath: user });
    expectGithubShape(diff!);

    // Objects only: the clone's HEAD, branches and work tree are as they were.
    expect(git(["rev-parse", "HEAD"], user)).toBe(before.head);
    expect(git(["symbolic-ref", "HEAD"], user)).toBe(before.branch);
    expect(git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"], user)).toBe(before.refs);
    expect(git(["status", "--porcelain"], user)).toBe("");
  });

  it("uses the managed checkout when no repo path is configured", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    git(["fetch", "-q", "origin", `refs/pull/${key.number}/head`], user);
    const managed = prCheckoutPath(key, root);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    git(["worktree", "add", "-q", "--detach", managed, remote.headSha], user);
    expectGithubShape((await localPrDiff(key, remote.baseSha, remote.headSha, { root }))!);
  });

  it("answers null when no clone can produce the diff", async () => {
    // Nothing configured, nothing managed.
    expect(await localPrDiff(key, remote.baseSha, remote.headSha, { root })).toBeNull();
    // Not a git repository.
    const plain = path.join(work, "plain");
    fs.mkdirSync(plain);
    expect(await localPrDiff(key, remote.baseSha, remote.headSha, { root, repoPath: plain })).toBeNull();
    // A repo of something else: the head is missing and no remote can bring it.
    const other = makeRepo(path.join(work, "other"), { origin: "https://github.com/someone/else.git" });
    expect(await localPrDiff(key, remote.baseSha, remote.headSha, { root, repoPath: other.path })).toBeNull();
    // Not real SHAs at all.
    expect(await localPrDiff(key, "mb1", "head1", { root, repoPath: remote.path })).toBeNull();
  });
});

describe("refresh and add read the diff without pulls/{n}", () => {
  const encodedKey = encodeURIComponent(keyToString(key));
  let diffAsks: string[];

  /**
   * gh for one PR at `remote`'s SHAs. The PR endpoint's diff answers 406, the
   * way GitHub does above 300 files; `compareDiff` is what compare serves.
   */
  function stubGh(compareDiff: string | Error) {
    diffAsks = [];
    setGhRunner((args) => {
      const joined = args.join(" ");
      if (joined.includes("Accept: application/vnd.github.v3.diff")) {
        const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
        diffAsks.push(endpoint);
        if (endpoint.includes("/pulls/")) {
          throw new Error(`gh ${joined} failed: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).`);
        }
        if (compareDiff instanceof Error) throw compareDiff;
        return compareDiff;
      }
      if (args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
      if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: remote.baseSha } });
      if (/pulls\/\d+$/.test(args[args.length - 1] ?? "")) {
        return JSON.stringify({
          node_id: "PR_7",
          number: key.number,
          title: "Add widgets",
          html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
          state: "open",
          base: { ref: "main", sha: remote.baseSha },
          head: { ref: "feature", sha: remote.headSha },
        });
      }
      return "{}";
    });
  }

  it("a refresh with a configured clone reads the diff from git, not GitHub", async () => {
    buildFixture(root);
    const user = cloneRepo(remote.path, path.join(work, "user"));
    updateMeta(key, { repoPath: user }, root);
    stubGh(new Error("gh compare diff must not be asked"));
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });

    const res = await app.request(`/api/prs/${encodedKey}/refresh?analyze=false`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(diffAsks).toEqual([]);
    const state = loadState(key, root);
    expect(state.currentRevision).toBe(2);
    expectGithubShape(readDiff(key, 2, root));
  });

  it("adds a PR over 300 files through compare/<base>...<head>", async () => {
    const patch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    stubGh(patch);
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });

    const res = await app.request("/api/prs?analyze=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect(res.status).toBe(200);
    expect(diffAsks).toEqual([`repos/acme/widgets/compare/${remote.baseSha}...${remote.headSha}`]);
    expect(readDiff(key, 1, root)).toBe(patch);
  });

  it("says GitHub could not render the diff when neither git nor compare can give it", async () => {
    stubGh(new Error("gh api compare failed: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)."));
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });

    const res = await app.request("/api/prs?analyze=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("gh_failed");
    expect(body.detail).toMatch(/^GitHub could not render the diff of acme\/widgets#7\./);
    expect(body.detail).not.toContain("HTTP 406");
  });
});
