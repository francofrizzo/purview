import { describe, expect, it } from "vitest";
import { sumDiffSize } from "../src/diff-size.js";

describe("sumDiffSize", () => {
  it("prefers GitHub's per-file counts and falls back to the hunks' line arrays", () => {
    expect(
      sumDiffSize([
        { additions: 34, deletions: 3, hunks: [{ addedLines: ["x"], removedLines: [] }] },
        { additions: null, deletions: null, hunks: [{ addedLines: ["a", "b"], removedLines: ["c"] }, { addedLines: ["d"] }] },
        { /* binary */ },
      ]),
    ).toEqual({ files: 3, additions: 37, deletions: 4 });
    expect(sumDiffSize([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});
