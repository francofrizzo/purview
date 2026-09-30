import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initPr,
  readMeta,
  setGhRunner,
  updateMeta,
  writeRepoConfig,
  type GhRunner,
  type PrKey,
} from "@reviewer/core";
import { statusPatch, sweepPrStatuses, sweepTargets } from "../src/status-sweep.js";

const pr = (repo: string, number: number): PrKey => ({
  host: "github.com",
  owner: "acme",
  repo,
  number,
});

let root: string;

/** Enough of `gh` for `initPr` to create state. */
const initGh: GhRunner = (args) => {
  const joined = args.join(" ");
  if (args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
  if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
  if (joined.includes("v3.diff")) return "";
  const m = /pulls\/(\d+)$/.exec(args[args.length - 1] ?? "");
  if (m) {
    const number = Number(m[1]);
    return JSON.stringify({
      node_id: `PR_${number}`,
      number,
      title: `PR ${number}`,
      html_url: `https://github.com/acme/x/pull/${number}`,
      state: "open",
      draft: false,
      merged: false,
      base: { ref: "main", sha: "base1" },
      head: { ref: `feature-${number}`, sha: `head${number}` },
    });
  }
  return "{}";
};

/** A `gh` that answers the batched status query from `byRepo[repo][number]`. */
function statusGh(
  byRepo: Record<string, Record<number, Record<string, unknown> | null>>,
  calls: string[][] = [],
): GhRunner {
  return (args) => {
    calls.push([...args]);
    if (args[1] !== "graphql") throw new Error(`unexpected gh ${args.join(" ")}`);
    const repo = args[args.indexOf("-F", args.indexOf("-F") + 1) + 1]!.slice("repo=".length);
    if (!(repo in byRepo)) throw new Error("boom");
    const out: Record<string, unknown> = {};
    for (const [n, v] of Object.entries(byRepo[repo]!)) out[`pr${n}`] = v;
    return JSON.stringify({ data: { repository: out } });
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-status-sweep-"));
  setGhRunner(initGh);
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("statusPatch", () => {
  it("patches only what moved", () => {
    expect(
      statusPatch(
        { prState: "open", reviewDecision: "review_required", title: "T" },
        { prState: "merged", reviewDecision: "approved", title: "T" },
      ),
    ).toEqual({ prState: "merged", reviewDecision: "approved" });
    expect(
      statusPatch(
        { prState: "open", reviewDecision: null, title: "T" },
        { prState: "open", reviewDecision: null, title: "T" },
      ),
    ).toBeNull();
  });

  it("never clears a decision on a null upstream", () => {
    expect(
      statusPatch(
        { prState: "open", reviewDecision: "approved", title: "T" },
        { prState: "open", reviewDecision: null, title: "T" },
      ),
    ).toBeNull();
  });
});

describe("sweepPrStatuses", () => {
  it("updates state, decision and title for every tracked PR, one query per repo", async () => {
    initPr(pr("widgets", 1), root);
    initPr(pr("widgets", 2), root);
    initPr(pr("gadgets", 3), root);
    const calls: string[][] = [];
    setGhRunner(
      statusGh(
        {
          widgets: {
            1: { state: "MERGED", isDraft: false, reviewDecision: "APPROVED", title: "PR 1", headRefOid: "h" },
            2: { state: "OPEN", isDraft: true, reviewDecision: null, title: "Renamed", headRefOid: "h" },
          },
          gadgets: {
            3: { state: "OPEN", isDraft: false, reviewDecision: "CHANGES_REQUESTED", title: "PR 3", headRefOid: "h" },
          },
        },
        calls,
      ),
    );

    const result = await sweepPrStatuses(root);

    expect(calls).toHaveLength(2);
    expect(result.errors).toEqual({});
    expect(result.updated.sort()).toEqual([
      "github.com/acme/gadgets#3",
      "github.com/acme/widgets#1",
      "github.com/acme/widgets#2",
    ].sort());
    expect(readMeta(pr("widgets", 1), root)).toMatchObject({ prState: "merged", reviewDecision: "approved" });
    expect(readMeta(pr("widgets", 2), root)).toMatchObject({ prState: "draft", title: "Renamed" });
    expect(readMeta(pr("gadgets", 3), root)).toMatchObject({ reviewDecision: "changes_requested" });
  });

  it("skips merged and archived PRs, and archived repos", async () => {
    initPr(pr("widgets", 1), root);
    initPr(pr("widgets", 2), root);
    initPr(pr("widgets", 3), root);
    initPr(pr("gadgets", 4), root);
    updateMeta(pr("widgets", 1), { prState: "merged" }, root);
    updateMeta(pr("widgets", 2), { archived: true }, root);
    writeRepoConfig({ host: "github.com", owner: "acme", repo: "gadgets" }, { archived: true }, root);

    const targets = sweepTargets(root);
    expect([...targets.keys()]).toEqual(["github.com/acme/widgets"]);
    expect(targets.get("github.com/acme/widgets")!.map((k) => k.number)).toEqual([3]);
  });

  it("keeps sweeping the other repos when one fails", async () => {
    initPr(pr("widgets", 1), root);
    initPr(pr("gadgets", 2), root);
    setGhRunner(
      statusGh({
        gadgets: { 2: { state: "CLOSED", isDraft: false, reviewDecision: null, title: "PR 2", headRefOid: "h" } },
      }),
    );

    const result = await sweepPrStatuses(root);

    expect(Object.keys(result.errors)).toEqual(["github.com/acme/widgets"]);
    expect(readMeta(pr("gadgets", 2), root).prState).toBe("closed");
  });
});
