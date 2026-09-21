import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvent, listPrs, listRepos, loadState, writeRevision } from "../src/store.js";
import { statePath, triagePath } from "../src/paths.js";
import { STATE_SHAPE_VERSION } from "../src/schemas.js";
import { computeHunkId } from "../src/hunk-id.js";
import type { FileDiff, Hunk, PrKey } from "../src/schemas.js";

const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 1 };

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-store-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkHunk(file: string, added: string[], removed: string[]): Hunk {
  return {
    id: computeHunkId(file, added, removed),
    file,
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    header: "func example()",
    addedLines: added,
    removedLines: removed,
    text: [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n"),
  };
}

describe("writeRevision", () => {
  it("writes revisions/<n>/triage.txt alongside files.json", () => {
    const hunk = mkHunk("src/a.ts", ["x"], ["y"]);
    const files: FileDiff[] = [
      { path: "src/a.ts", status: "modified", binary: false, hunks: [hunk] },
    ];
    writeRevision(key, 1, "diff --git a/src/a.ts b/src/a.ts", files, {}, tmp);

    const file = triagePath(key, 1, tmp);
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("revision 1");
    expect(content).toContain("src/a.ts");
    expect(content).toContain(hunk.id);
  });
});

describe("listPrs / listRepos and checkouts/", () => {
  it("never walk into the managed checkouts tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-store-co-"));
    try {
      // Shaped exactly like a PR dir (host/owner/repo/<digits>/meta.json), so
      // only the explicit skip keeps it out.
      const decoy = path.join(root, "checkouts", "h", "o", "1");
      fs.mkdirSync(decoy, { recursive: true });
      fs.writeFileSync(path.join(decoy, "meta.json"), "{}");
      expect(listPrs(root)).toEqual([]);
      expect(listRepos(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadState", () => {
  it("re-folds a state.json written by an older reducer (no or stale shapeVersion)", () => {
    appendEvent(
      key,
      { type: "pr-initialized", host: key.host, owner: key.owner, repo: key.repo, number: 1, url: "u" },
      tmp,
    );
    const file = statePath(key, tmp);
    const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(fresh.shapeVersion).toBe(STATE_SHAPE_VERSION);

    // Simulate a snapshot from before shapeVersion, carrying a value the log
    // does not support: loading must discard it and re-fold from events.
    const { shapeVersion: _drop, ...old } = fresh;
    fs.writeFileSync(file, JSON.stringify({ ...old, summary: "stale" }));
    const loaded = loadState(key, tmp);
    expect(loaded.summary).toBe("");
    expect(loaded.shapeVersion).toBe(STATE_SHAPE_VERSION);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).shapeVersion).toBe(STATE_SHAPE_VERSION);
  });

  it("trusts a current-shape snapshot as is", () => {
    appendEvent(
      key,
      { type: "pr-initialized", host: key.host, owner: key.owner, repo: key.repo, number: 1, url: "u" },
      tmp,
    );
    const file = statePath(key, tmp);
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...cur, summary: "kept" }));
    expect(loadState(key, tmp).summary).toBe("kept");
  });
});
