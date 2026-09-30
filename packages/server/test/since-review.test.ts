import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeHunkId, writeRevision, type FileDiff, type Hunk } from "@reviewer/core";
import { sinceLastReview } from "../src/since-review.js";

const key = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };
const shas = { baseSha: "b", headSha: "h", mergeBase: "b" };
let root: string;

const hunk = (file: string, added: string[]): Hunk => ({
  id: computeHunkId(file, added, []),
  file,
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: added.length,
  header: "",
  addedLines: added,
  removedLines: [],
  text: added.map((l) => `+${l}`).join("\n"),
});
const file = (p: string, hunks: Hunk[]): FileDiff => ({ path: p, status: "modified", binary: false, hunks });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "since-review-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("sinceLastReview", () => {
  const kept = hunk("a.ts", ["same"]);
  const before = hunk("b.ts", ["old"]);
  const after = hunk("b.ts", ["new"]);
  const added = hunk("c.ts", ["brand new"]);
  const submission = (revision: number) => ({ event: "APPROVE" as const, commentCount: 0, ts: "2026-09-30T00:00:00Z", revision });

  it("lists the current hunks the reviewed revision did not have", () => {
    writeRevision(key, 1, "", [file("a.ts", [kept]), file("b.ts", [before])], shas, root);
    const current = [file("a.ts", [kept]), file("b.ts", [after]), file("c.ts", [added])];
    const res = sinceLastReview(key, { currentRevision: 2, reviewSubmissions: [submission(1)] }, current, root);
    expect(res?.revision).toBe(1);
    expect(res?.changedHunkIds).toEqual([after.id, added.id]);
  });

  it("is null with no review, no movement since, or the reviewed revision gone", () => {
    const current = [file("a.ts", [kept])];
    expect(sinceLastReview(key, { currentRevision: 2, reviewSubmissions: [] }, current, root)).toBeNull();
    expect(sinceLastReview(key, { currentRevision: 2, reviewSubmissions: [submission(2)] }, current, root)).toBeNull();
    expect(sinceLastReview(key, { currentRevision: 3, reviewSubmissions: [submission(1)] }, current, root)).toBeNull();
  });
});
