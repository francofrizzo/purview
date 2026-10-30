import { describe, expect, it } from "vitest";
import { revisionFileChanges, revisionNoticeText } from "./revisionNotice";

const report = {
  revision: 2,
  counts: { carried: 41, fuzzy: 2, renamed: 0, archived: 1, new: 3 },
  fuzzy: [
    { hunkId: "f1", file: "manager.go" },
    { hunkId: "f2", file: "manager.go" },
  ],
  archived: [{ hunkId: "a1", file: "suite_test.go" }],
  new: [
    { hunkId: "n1", file: "suite_test.go" },
    { hunkId: "n2", file: "suite_test.go" },
    { hunkId: "n3", file: "helpers_test.go" },
  ],
};

describe("revisionNoticeText", () => {
  it("says what the revision brought, without the engine's words", () => {
    expect(revisionNoticeText(report)).toBe("Revision 2: 3 new hunks, 2 changed, 1 gone.");
  });

  it("covers no change, a base-only move and a revision that touched nothing read", () => {
    expect(revisionNoticeText({ noChange: true })).toBe("Already up to date.");
    expect(revisionNoticeText({ revision: 3, baseOnly: true })).toBe(
      "Revision 3: only the base branch moved, nothing to read again.",
    );
    expect(revisionNoticeText({ revision: 4, counts: { carried: 9 } })).toBe("Revision 4: nothing you read changed.");
  });
});

describe("revisionFileChanges", () => {
  it("counts per file, busiest first, and never mentions hunk ids", () => {
    expect(revisionFileChanges(report)).toEqual([
      { file: "suite_test.go", added: 2, changed: 0, gone: 1, moved: 0 },
      { file: "manager.go", added: 0, changed: 2, gone: 0, moved: 0 },
      { file: "helpers_test.go", added: 1, changed: 0, gone: 0, moved: 0 },
    ]);
  });
});
