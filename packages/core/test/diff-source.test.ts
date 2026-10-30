import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchPullDiff, fetchPullDiffAsync, setGhRunner } from "../src/github.js";
import type { PrKey } from "../src/paths.js";
import { initPr, initPrAsync, refreshPrAsync, type LocalDiffSource } from "../src/service.js";
import { readDiff } from "../src/store.js";

/**
 * Where a revision's diff comes from: a local source first (the server's git
 * clone), else GitHub's compare endpoint pinned to the SHAs the refresh
 * records — never `pulls/{n}`, whose v3.diff answers 406 above 300 files.
 */

const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const MB = "a".repeat(40);

const diffOf = (word: string) => `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+${word}
`;

let root: string;
let calls: string[][];
/** what the diff call answers: a patch, or an Error to throw */
let compareDiff: string | Error;
/** the head GitHub reports for the PR */
let head: string;

const diffCalls = () => calls.filter((c) => c.includes("Accept: application/vnd.github.v3.diff"));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-diff-source-"));
  calls = [];
  compareDiff = diffOf("github");
  head = HEAD;
  setGhRunner((args) => {
    calls.push([...args]);
    const joined = args.join(" ");
    if (joined.includes("Accept: application/vnd.github.v3.diff")) {
      if (compareDiff instanceof Error) throw compareDiff;
      return compareDiff;
    }
    if (args[0] !== "api") throw new Error(`unexpected gh ${joined}`);
    if (args[1] === "graphql") throw new Error("no graphql here");
    const endpoint = args[1];
    if (endpoint.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: MB } });
    if (endpoint === "repos/acme/widgets") return JSON.stringify({ default_branch: "main" });
    if (/\/pulls\/7$/.test(endpoint)) {
      return JSON.stringify({
        node_id: "PR_7",
        number: 7,
        title: "PR 7",
        html_url: "https://github.com/acme/widgets/pull/7",
        state: "open",
        base: { ref: "main", sha: BASE },
        head: { ref: "feature", sha: head },
      });
    }
    throw new Error(`unexpected gh api ${endpoint}`);
  });
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fetchPullDiff", () => {
  it("asks compare/<base>...<head> for the v3.diff media type", async () => {
    fetchPullDiff(key, BASE, HEAD);
    await fetchPullDiffAsync(key, BASE, HEAD);
    const expected = [
      "api",
      `repos/acme/widgets/compare/${BASE}...${HEAD}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
    ];
    expect(calls).toEqual([expected, expected]);
  });

  it("names the GHE host", () => {
    fetchPullDiff({ ...key, host: "ghe.example.com" }, BASE, HEAD);
    expect(calls[0].slice(0, 3)).toEqual(["api", "--hostname", "ghe.example.com"]);
  });
});

describe("refresh diff source", () => {
  it("fetches the diff for exactly the base and head it records", async () => {
    const res = await initPrAsync(key, root);
    const rev = res.state.revisions[0];
    expect(rev).toMatchObject({ baseSha: BASE, headSha: HEAD, mergeBase: MB });
    expect(diffCalls()).toHaveLength(1);
    expect(diffCalls()[0]).toContain(`repos/acme/widgets/compare/${BASE}...${HEAD}`);
    expect(calls.some((c) => c.includes("Accept: application/vnd.github.v3.diff") && c.some((a) => a.includes("/pulls/")))).toBe(false);
    expect(readDiff(key, 1, root)).toBe(diffOf("github"));
  });

  it("stores the local source's diff and never asks GitHub for one", async () => {
    const seen: string[][] = [];
    const localDiff: LocalDiffSource = async (k, mergeBase, head) => {
      seen.push([`${k.owner}/${k.repo}#${k.number}`, mergeBase, head]);
      return diffOf("local");
    };
    await initPrAsync(key, root, { localDiff });
    expect(seen).toEqual([["acme/widgets#7", MB, HEAD]]);
    expect(diffCalls()).toHaveLength(0);
    expect(readDiff(key, 1, root)).toBe(diffOf("local"));
  });

  it("the synchronous refresh takes a synchronous source", () => {
    initPr(key, root, { localDiff: () => diffOf("local") });
    expect(diffCalls()).toHaveLength(0);
    expect(readDiff(key, 1, root)).toBe(diffOf("local"));
  });

  it.each([
    ["returns null", (async () => null) as LocalDiffSource],
    ["throws", (() => {
      throw new Error("git exploded");
    }) as LocalDiffSource],
    ["rejects", (async () => {
      throw new Error("git exploded");
    }) as LocalDiffSource],
  ])("falls back to compare when the local source %s", async (_label, localDiff) => {
    await initPrAsync(key, root, { localDiff });
    expect(diffCalls()).toHaveLength(1);
    expect(readDiff(key, 1, root)).toBe(diffOf("github"));
  });

  it("says plainly that GitHub could not render the diff when both fail", async () => {
    await initPrAsync(key, root);
    compareDiff = new Error("gh api repos/acme/widgets/compare/x...y failed: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).");
    head = "d".repeat(40); // a new head, so the refresh needs a new diff
    const err = await refreshPrAsync(key, root, { localDiff: async () => null }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("DiffUnavailableError");
    expect((err as Error).message).toMatch(/^GitHub could not render the diff of acme\/widgets#7\./);
    expect((err as Error).message).not.toContain("gh api");
    expect(((err as Error).cause as Error).message).toContain("HTTP 406");
  });
});
