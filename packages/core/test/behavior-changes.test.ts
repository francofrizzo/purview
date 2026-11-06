import { describe, expect, it } from "vitest";
import { fold } from "../src/reducer.js";
import { BehaviorChangesSchema, type ReviewerEvent } from "../src/schemas.js";

const ts = "2026-01-01T00:00:00.000Z";
const rev: ReviewerEvent = {
  ts, type: "revision-added", revision: 1, baseSha: "b", headSha: "h", mergeBase: "m", baseOnly: false,
  files: [{ path: "a.ts", hunkIds: ["h1"] }],
} as ReviewerEvent;
const analysis = (behaviorChanges?: unknown): ReviewerEvent =>
  ({ ts, type: "analysis-set", revision: 1, summary: "s", units: [], unassigned: ["h1"], ...(behaviorChanges ? { behaviorChanges } : {}) }) as ReviewerEvent;

describe("behavior changes", () => {
  it("an empty list is the analysis saying nothing changes, kept apart from never written", () => {
    expect(BehaviorChangesSchema.parse([])).toEqual([]);
    expect(fold([rev, analysis([])]).behaviorChanges).toEqual([]);
    expect(fold([rev, analysis()]).behaviorChanges).toBeUndefined();
  });
});
