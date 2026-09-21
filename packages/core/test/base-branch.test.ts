import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BRANCH_TTL_MS,
  cachedDefaultBranch,
  clearDefaultBranchCache,
  fetchDefaultBranch,
  findOpenPrByHead,
  setGhRunner,
} from "../src/github.js";
import { repoGithubCachePath, type PrKey } from "../src/paths.js";
import { findTrackedPrByHead, initPr, refreshPr } from "../src/service.js";
import { readMeta, updateMeta } from "../src/store.js";

const DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`;

const repo = { host: "github.com", owner: "acme", repo: "widgets" };
const key: PrKey = { ...repo, number: 8505 };

interface Remote {
  baseRef: string;
  defaultBranch: string | null;
  /** head branch -> open PRs `gh pr list --head` would return */
  openByHead: Record<string, { number: number; title: string; url: string }[]>;
  /** per-PR head branches (for PRs initialized in a test) */
  heads: Record<number, string>;
  failPrList: boolean;
}

let root: string;
let remote: Remote;
let calls: string[][];

const prListCalls = () => calls.filter((c) => c[0] === "pr" && c[1] === "list");
const repoCalls = () => calls.filter((c) => c[0] === "api" && c[1] === "repos/acme/widgets");

function installGh() {
  setGhRunner((args) => {
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "list") {
      if (remote.failPrList) throw new Error("gh pr list failed: boom");
      const head = args[args.indexOf("--head") + 1];
      return JSON.stringify((remote.openByHead[head] ?? []).slice(0, 1));
    }
    if (args[0] !== "api") throw new Error(`unexpected gh ${args.join(" ")}`);
    if (args[1] === "graphql") throw new Error("no graphql here");
    if (args.includes("-H")) return DIFF;
    const endpoint = args[1];
    if (endpoint === "repos/acme/widgets") {
      if (remote.defaultBranch === null) throw new Error("gh api failed: HTTP 502");
      return JSON.stringify({ default_branch: remote.defaultBranch });
    }
    if (endpoint.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb" } });
    const m = endpoint.match(/\/pulls\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      return JSON.stringify({
        node_id: `PR_${n}`,
        number: n,
        title: `PR ${n}`,
        html_url: `https://github.com/acme/widgets/pull/${n}`,
        state: "open",
        base: { ref: n === key.number ? remote.baseRef : "main", sha: "base" },
        head: { ref: remote.heads[n] ?? `feature-${n}`, sha: "head" },
      });
    }
    throw new Error(`unexpected gh api ${endpoint}`);
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-base-"));
  remote = { baseRef: "main", defaultBranch: "main", openByHead: {}, heads: {}, failPrList: false };
  calls = [];
  clearDefaultBranchCache();
  installGh();
});

afterEach(() => {
  setGhRunner(null);
  clearDefaultBranchCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("meta.baseRef / basePr", () => {
  it("a PR on the default branch gets baseRef and basePr: null on init", () => {
    initPr(key, root);
    const meta = readMeta(key, root);
    expect(meta.baseRef).toBe("main");
    expect(meta.basePr).toBeNull();
    expect(prListCalls()).toHaveLength(0);
  });

  it("a stacked PR records the open PR heading its base (via gh)", () => {
    remote.baseRef = "codex/deuda";
    remote.openByHead["codex/deuda"] = [
      { number: 8501, title: "Deuda", url: "https://github.com/acme/widgets/pull/8501" },
    ];
    initPr(key, root);
    const meta = readMeta(key, root);
    expect(meta.baseRef).toBe("codex/deuda");
    expect(meta.basePr).toEqual({
      number: 8501,
      title: "Deuda",
      url: "https://github.com/acme/widgets/pull/8501",
    });
    const [call] = prListCalls();
    expect(call).toEqual([
      "pr", "list", "--repo", "acme/widgets", "--head", "codex/deuda",
      "--state", "open", "--json", "number,title,url", "--limit", "1",
    ]);
  });

  it("stacked on a branch no open PR heads: basePr null", () => {
    remote.baseRef = "release/2";
    initPr(key, root);
    expect(readMeta(key, root).basePr).toBeNull();
  });

  it("refresh follows a retarget and backfills old meta without baseRef", () => {
    initPr(key, root);
    // Simulate state written before the fields existed.
    const raw = JSON.parse(fs.readFileSync(path.join(root, "github.com/acme/widgets/8505/meta.json"), "utf8"));
    delete raw.baseRef;
    delete raw.basePr;
    fs.writeFileSync(path.join(root, "github.com/acme/widgets/8505/meta.json"), JSON.stringify(raw));
    expect(readMeta(key, root).baseRef).toBeUndefined();

    remote.baseRef = "codex/deuda";
    remote.openByHead["codex/deuda"] = [{ number: 8501, title: "Deuda", url: "u8501" }];
    refreshPr(key, root);
    expect(readMeta(key, root)).toMatchObject({
      baseRef: "codex/deuda",
      basePr: { number: 8501, title: "Deuda", url: "u8501" },
    });

    // Base PR merged; GitHub retargets this one to main.
    remote.baseRef = "main";
    refreshPr(key, root);
    expect(readMeta(key, root)).toMatchObject({ baseRef: "main", basePr: null });
  });

  it("a failed base-PR lookup keeps the previous value", () => {
    remote.baseRef = "codex/deuda";
    remote.openByHead["codex/deuda"] = [{ number: 8501, title: "Deuda", url: "u8501" }];
    initPr(key, root);
    remote.failPrList = true;
    refreshPr(key, root);
    expect(readMeta(key, root).basePr).toEqual({ number: 8501, title: "Deuda", url: "u8501" });
  });

  it("an unknown default branch leaves basePr unresolved and never throws", () => {
    remote.defaultBranch = null;
    remote.baseRef = "codex/deuda";
    initPr(key, root);
    const meta = readMeta(key, root);
    expect(meta.baseRef).toBe("codex/deuda");
    expect(meta.basePr).toBeUndefined();
  });

  it("prefers a locally tracked PR over asking gh", () => {
    remote.heads[8501] = "codex/deuda";
    initPr({ ...repo, number: 8501 }, root);
    updateMeta({ ...repo, number: 8501 }, { title: "Deuda (local)" }, root);
    remote.baseRef = "codex/deuda";
    remote.openByHead["codex/deuda"] = [{ number: 9999, title: "wrong", url: "x" }];
    calls = [];
    initPr(key, root);
    expect(readMeta(key, root).basePr).toEqual({
      number: 8501,
      title: "Deuda (local)",
      url: "https://github.com/acme/widgets/pull/8501",
    });
    expect(prListCalls()).toHaveLength(0);
  });

  it("findTrackedPrByHead skips merged/closed PRs and other repos", () => {
    remote.heads[8501] = "codex/deuda";
    initPr({ ...repo, number: 8501 }, root);
    expect(findTrackedPrByHead(key, "codex/deuda", root)?.number).toBe(8501);
    expect(findTrackedPrByHead({ ...key, repo: "other" }, "codex/deuda", root)).toBeNull();
    updateMeta({ ...repo, number: 8501 }, { prState: "merged" }, root);
    expect(findTrackedPrByHead(key, "codex/deuda", root)).toBeNull();
  });
});

describe("default branch cache", () => {
  it("caches in memory and on disk, and refetches after the TTL", () => {
    const t0 = 1_000_000;
    expect(fetchDefaultBranch(repo, root, t0)).toBe("main");
    expect(fetchDefaultBranch(repo, root, t0 + 1000)).toBe("main");
    expect(repoCalls()).toHaveLength(1);
    const onDisk = JSON.parse(fs.readFileSync(repoGithubCachePath(repo, root), "utf8"));
    expect(onDisk.defaultBranch).toBe("main");

    // A fresh process (empty memory) is served from disk.
    clearDefaultBranchCache();
    expect(fetchDefaultBranch(repo, root, t0 + 2000)).toBe("main");
    expect(repoCalls()).toHaveLength(1);

    remote.defaultBranch = "trunk";
    expect(fetchDefaultBranch(repo, root, t0 + DEFAULT_BRANCH_TTL_MS + 1)).toBe("trunk");
    expect(repoCalls()).toHaveLength(2);
  });

  it("degrades to unknown, or to the stale value, on failure — never throws", () => {
    remote.defaultBranch = null;
    expect(fetchDefaultBranch(repo, root, 0)).toBeNull();
    // The failure is remembered briefly: no retry storm.
    expect(fetchDefaultBranch(repo, root, 1000)).toBeNull();
    expect(repoCalls()).toHaveLength(1);

    remote.defaultBranch = "main";
    const later = 10 * 60_000;
    expect(fetchDefaultBranch(repo, root, later)).toBe("main");
    remote.defaultBranch = null;
    expect(fetchDefaultBranch(repo, root, later + DEFAULT_BRANCH_TTL_MS + 1)).toBe("main");
  });

  it("cachedDefaultBranch never calls gh", () => {
    expect(cachedDefaultBranch(repo, root)).toBeNull();
    expect(calls).toHaveLength(0);
    fetchDefaultBranch(repo, root);
    clearDefaultBranchCache();
    calls = [];
    expect(cachedDefaultBranch(repo, root)).toBe("main");
    expect(calls).toHaveLength(0);
  });

  it("findOpenPrByHead: null for none, undefined on failure", () => {
    expect(findOpenPrByHead(repo, "nope")).toBeNull();
    remote.failPrList = true;
    expect(findOpenPrByHead(repo, "nope")).toBeUndefined();
  });
});
