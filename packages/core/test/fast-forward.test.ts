import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setGhRunner } from "../src/github.js";
import { initPr, refreshPr, setHunkViewed } from "../src/service.js";
import { loadState, readEvents, readFilesJson, rebuildState } from "../src/store.js";
import type { PrKey } from "../src/paths.js";

const fixture = (name: string) =>
  fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const REV1 = fixture("rev1.patch");
const REV2 = fixture("rev2.patch");

const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 9 };

/** Stubbed `gh`: whatever `remote` says is on GitHub right now. */
const remote = { headSha: "head1", baseSha: "base1", diff: REV1 };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-ff-test-"));
  process.env.REVIEWER_STATE_DIR = root;
  Object.assign(remote, { headSha: "head1", baseSha: "base1", diff: REV1 });
  setGhRunner((args) => {
    if (args[0] !== "api") throw new Error(`unexpected gh ${args.join(" ")}`);
    if (args.includes("-H")) return remote.diff;
    const endpoint = args[1];
    if (endpoint.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    if (/\/pulls\/\d+$/.test(endpoint))
      return JSON.stringify({
        node_id: "PR_kwABC",
        number: key.number,
        title: "Add widgets",
        html_url: "https://github.com/acme/widgets/pull/9",
        state: "open",
        base: { ref: "main", sha: remote.baseSha },
        head: { ref: "feature", sha: remote.headSha },
      });
    throw new Error(`unexpected gh api ${endpoint}`);
  });
});

afterEach(() => {
  setGhRunner(null);
  delete process.env.REVIEWER_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a refresh whose diff is the current revision's", () => {
  it("moves the revision to the new commits instead of adding one, keeping what was read", () => {
    initPr(key, root);
    const hunk = readFilesJson(key, 1, root).files[0].hunks[0].id;
    setHunkViewed(key, hunk, true, root);

    Object.assign(remote, { headSha: "head2", baseSha: "base2" });
    const res = refreshPr(key, root);
    expect(res).toMatchObject({ revision: 1, added: false, advanced: true });
    const rev = res.state.revisions.find((r) => r.revision === 1)!;
    expect(rev).toMatchObject({ headSha: "head2", baseSha: "base2", advances: 1 });
    expect(rev.advancedAt).toBeDefined();
    expect(res.state.revisions).toHaveLength(1);
    expect(res.state.hunks[hunk].viewed).toBe(true);
    expect(readFilesJson(key, 1, root)).toMatchObject({ headSha: "head2", baseSha: "base2" });

    // The log alone folds to the same.
    expect(rebuildState(key, root).revisions).toEqual(res.state.revisions);
  });

  it("counts a diff that differs only in its index lines as the same", () => {
    initPr(key, root);
    remote.headSha = "head2";
    remote.diff = REV1.replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, "index 0000000..1111111");
    expect(remote.diff).not.toBe(REV1);
    const res = refreshPr(key, root);
    expect(res.advanced).toBe(true);
    remote.headSha = "head3";
    expect(refreshPr(key, root).state.revisions[0].advances).toBe(2);
  });

  it("adds a revision as always when a line differs", () => {
    initPr(key, root);
    Object.assign(remote, { headSha: "head2", diff: REV2 });
    const res = refreshPr(key, root);
    expect(res).toMatchObject({ revision: 2, added: true });
    expect(res.advanced).toBeUndefined();
    expect(readEvents(key, root).some((e) => e.type === "revision-advanced")).toBe(false);
    expect(loadState(key, root).revisions.map((r) => r.revision)).toEqual([1, 2]);
  });
});
