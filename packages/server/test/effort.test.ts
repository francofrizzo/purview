import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendEvent,
  writeMeta,
  writeRevision,
  type Hunk,
  type PrKey,
  type ReviewUnit,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { clearEffortCache, reviewEffort } from "../src/effort.js";

const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };

/** A synthetic hunk with exactly `lines` changed lines (all additions). */
function hunk(id: string, lines: number): Hunk {
  return {
    id,
    file: "src/foo.ts",
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: lines,
    header: "",
    addedLines: Array.from({ length: lines }, (_, i) => `line${i}`),
    removedLines: [],
    text: "",
  };
}

function unit(patch: Partial<ReviewUnit> & { id: string; hunkIds: string[] }): ReviewUnit {
  return {
    title: "unit",
    summary: "",
    kind: "core-logic",
    attention: "must-read",
    attentionWhy: "",
    riskFlags: [],
    order: 0,
    ...patch,
  };
}

/**
 * Builds a one-revision PR with the given hunks and units directly through
 * core's store functions — no diff parsing needed since hunk identity here is
 * just the id string, not content-derived.
 */
function build(root: string, hunks: Hunk[], units: ReviewUnit[]) {
  writeMeta(
    key,
    {
      host: key.host,
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
      title: "Add widgets",
      createdAt: new Date().toISOString(),
    },
    root,
  );
  const file = { path: "src/foo.ts", status: "modified" as const, binary: false, hunks };
  writeRevision(key, 1, "", [file], { baseSha: "b1", headSha: "h1", mergeBase: "mb1" }, root);
  appendEvent(
    key,
    {
      type: "revision-added",
      revision: 1,
      baseSha: "b1",
      headSha: "h1",
      mergeBase: "mb1",
      baseOnly: false,
      files: [
        {
          path: "src/foo.ts",
          status: "modified",
          hunkIds: hunks.map((h) => h.id),
        },
      ],
    },
    root,
  );
  if (units.length > 0) {
    appendEvent(
      key,
      { type: "analysis-set", revision: 1, summary: "s", units, unassigned: [] },
      root,
    );
  }
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-effort-test-"));
  clearEffortCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("reviewEffort", () => {
  it("returns null when there is no analysis", () => {
    build(root, [hunk("h1", 100)], []);
    expect(reviewEffort(key, root)).toBeNull();
  });

  it("badges a small, low-risk, few-unit PR as fast", () => {
    build(
      root,
      [hunk("h1", 60), hunk("h2", 40)],
      [unit({ id: "u1", attention: "must-read", riskFlags: [], hunkIds: ["h1", "h2"] })],
    );
    const effort = reviewEffort(key, root);
    expect(effort).toEqual({
      mustReadLines: 100,
      weightedMustReadLines: 100,
      mustReadUnits: 1,
      riskCount: 0,
      badge: "fast",
    });
  });

  it("badges heavy purely on line count", () => {
    build(
      root,
      [hunk("h1", 1600)],
      [unit({ id: "u1", attention: "must-read", riskFlags: [], hunkIds: ["h1"] })],
    );
    const effort = reviewEffort(key, root);
    expect(effort?.badge).toBe("heavy");
    expect(effort?.mustReadLines).toBe(1600);
  });

  it("badges heavy on a moderate line count combined with enough risk flags", () => {
    build(
      root,
      [hunk("h1", 1250)],
      [
        unit({
          id: "u1",
          attention: "must-read",
          riskFlags: ["auth", "migration", "money", "security"],
          hunkIds: ["h1"],
        }),
      ],
    );
    const effort = reviewEffort(key, root);
    expect(effort?.badge).toBe("heavy");
    expect(effort?.riskCount).toBe(4);
  });

  it("does not badge a moderate line count without enough risk", () => {
    build(
      root,
      [hunk("h1", 1100)],
      [
        unit({
          id: "u1",
          attention: "must-read",
          riskFlags: ["auth"],
          hunkIds: ["h1"],
        }),
      ],
    );
    expect(reviewEffort(key, root)?.badge).toBeNull();
  });

  it("badges neither extreme in the middle of the distribution", () => {
    build(
      root,
      [hunk("h1", 700)],
      [unit({ id: "u1", attention: "must-read", riskFlags: ["auth"], hunkIds: ["h1"] })],
    );
    expect(reviewEffort(key, root)?.badge).toBeNull();
  });

  it("only counts must-read hunks, deduped across the union of units", () => {
    build(
      root,
      [hunk("h1", 50), hunk("h2", 20), hunk("h3", 500)],
      [
        unit({ id: "u1", attention: "must-read", riskFlags: [], hunkIds: ["h1", "h2"] }),
        // shares h2 with u1 — must not be double-counted
        unit({ id: "u2", attention: "must-read", riskFlags: [], hunkIds: ["h2"] }),
        unit({ id: "u3", attention: "skim", riskFlags: [], hunkIds: ["h3"] }),
      ],
    );
    const effort = reviewEffort(key, root);
    expect(effort?.mustReadLines).toBe(70);
    expect(effort?.weightedMustReadLines).toBe(70);
    expect(effort?.mustReadUnits).toBe(2);
  });

  it("discounts non-core kinds in the weighted count, and the badge follows it", () => {
    // 8327's shape in miniature: enough raw must-read lines to look heavy,
    // but a big slice of them is connective tissue.
    build(
      root,
      [hunk("h1", 900), hunk("h2", 700)],
      [
        unit({ id: "u1", attention: "must-read", riskFlags: [], hunkIds: ["h1"] }),
        unit({
          id: "u2",
          kind: "connective-tissue",
          attention: "must-read",
          riskFlags: [],
          hunkIds: ["h2"],
        }),
      ],
    );
    const effort = reviewEffort(key, root);
    expect(effort?.mustReadLines).toBe(1600);
    expect(effort?.weightedMustReadLines).toBe(900 + 700 * 0.4);
    expect(effort?.badge).toBeNull(); // raw 1600 would have been heavy
  });

  it("counts a shared hunk once, at the highest claiming kind weight", () => {
    build(
      root,
      [hunk("h1", 100)],
      [
        unit({ id: "u1", kind: "connective-tissue", attention: "must-read", riskFlags: [], hunkIds: ["h1"] }),
        unit({ id: "u2", attention: "must-read", riskFlags: [], hunkIds: ["h1"] }),
      ],
    );
    expect(reviewEffort(key, root)?.weightedMustReadLines).toBe(100);
  });

  it("counts distinct risk flags across every unit, not just must-read ones", () => {
    build(
      root,
      [hunk("h1", 50), hunk("h2", 10)],
      [
        unit({ id: "u1", attention: "must-read", riskFlags: ["auth"], hunkIds: ["h1"] }),
        unit({ id: "u2", attention: "skip", riskFlags: ["auth", "money"], hunkIds: ["h2"] }),
      ],
    );
    expect(reviewEffort(key, root)?.riskCount).toBe(2);
  });

  it("tolerates a unit hunk id absent from files.json, contributing 0 lines", () => {
    build(
      root,
      [hunk("h1", 50)],
      [unit({ id: "u1", attention: "must-read", riskFlags: [], hunkIds: ["h1", "ghost"] })],
    );
    expect(() => reviewEffort(key, root)).not.toThrow();
    expect(reviewEffort(key, root)?.mustReadLines).toBe(50);
  });

  it("caches by key + analysis revision", () => {
    build(
      root,
      [hunk("h1", 50)],
      [unit({ id: "u1", attention: "must-read", riskFlags: [], hunkIds: ["h1"] })],
    );
    const first = reviewEffort(key, root);
    const second = reviewEffort(key, root);
    expect(second).toBe(first);
    clearEffortCache();
    expect(reviewEffort(key, root)).not.toBe(first);
  });
});

describe("GET /api/prs effort field", () => {
  it("includes the badge on the list entry", async () => {
    build(
      root,
      [hunk("h1", 50)],
      [unit({ id: "u1", attention: "must-read", riskFlags: [], hunkIds: ["h1"] })],
    );
    const app = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      autoAnalyze: false,
    });
    const res = await app.request("/api/prs");
    const body = await res.json();
    expect(body.prs).toHaveLength(1);
    expect(body.prs[0].effort).toEqual({
      mustReadLines: 50,
      weightedMustReadLines: 50,
      mustReadUnits: 1,
      riskCount: 0,
      badge: "fast",
    });
  });

  it("reports null for a PR without analysis", async () => {
    build(root, [hunk("h1", 50)], []);
    const app = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      autoAnalyze: false,
    });
    const res = await app.request("/api/prs");
    const body = await res.json();
    expect(body.prs[0].effort).toBeNull();
  });
});
