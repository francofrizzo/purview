import { describe, expect, it } from "vitest";
import { sumDiffSize, withGenerated } from "../src/diff-size.js";

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

describe("withGenerated", () => {
  it("attaches the generated files' share, and leaves a size without any as it was", () => {
    const size = { files: 3, additions: 50, deletions: 10 };
    expect(withGenerated(size, [{ added: 30, removed: 4 }, { added: 2, removed: 0 }])).toEqual({
      ...size,
      generated: { files: 2, additions: 32, deletions: 4 },
    });
    expect(withGenerated(size, [])).toBe(size);
    expect(withGenerated(null, [{ added: 1, removed: 1 }])).toBeNull();
  });
});
