import { describe, expect, it } from "vitest";
import type { ChatRef, DraftComment, PrDetail } from "../api/types";
import {
  addRef,
  baseName,
  lineRangeRef,
  refContext,
  refKey,
  refLabel,
  refTitle,
  removeRef,
} from "./chatRefs";

const unit: ChatRef = { kind: "unit", id: "idempotent-charge-path" };
const file: ChatRef = { kind: "file", path: "src/billing/charge.ts" };
const lines: ChatRef = { kind: "line-range", path: "src/billing/charge.ts", side: "new", start: 12, end: 40 };

const detail = {
  key: "github.com/acme/pay/42",
  meta: {} as PrDetail["meta"],
  diff: "",
  state: {
    revision: 1,
    units: [{ id: "idempotent-charge-path", title: "Idempotent charge path", hunkIds: [] }],
    hunks: {},
  },
  files: {
    files: [
      {
        path: "src/billing/charge.ts",
        hunks: [
          { id: "h1", file: "src/billing/charge.ts", oldStart: 8, oldLines: 4, newStart: 12, newLines: 29, header: "" },
        ],
      },
    ],
  },
} as unknown as PrDetail;

const comments: DraftComment[] = [
  { id: "draft-1", file: "src/billing/ledger.ts", line: 12, side: "RIGHT", body: "hmm" },
];

describe("refKey", () => {
  it("is stable per pointer and distinguishes kinds", () => {
    expect(refKey(unit)).toBe("unit:idempotent-charge-path");
    expect(refKey(file)).toBe("file:src/billing/charge.ts");
    expect(refKey(lines)).toBe("lines:src/billing/charge.ts:new:12-40");
    expect(refKey({ kind: "hunk", id: "h1" })).not.toBe(refKey({ kind: "unit", id: "h1" }));
  });

  it("separates the two sides of the same line range", () => {
    expect(refKey({ ...lines, side: "old" })).not.toBe(refKey(lines));
  });
});

describe("addRef / removeRef", () => {
  it("appends a new ref", () => {
    expect(addRef([unit], file)).toEqual([unit, file]);
  });

  it("is a no-op for a pointer already attached, keeping its position", () => {
    const refs = [unit, file];
    const next = addRef(refs, { kind: "unit", id: "idempotent-charge-path" });
    expect(next).toBe(refs);
  });

  it("treats an equal line range as the same ref regardless of object identity", () => {
    const refs = addRef([], lineRangeRef("a.ts", "new", 5, 9));
    expect(addRef(refs, lineRangeRef("a.ts", "new", 5, 9))).toBe(refs);
    expect(addRef(refs, lineRangeRef("a.ts", "new", 5, 10))).toHaveLength(2);
  });

  it("removes by key and leaves the array untouched when nothing matches", () => {
    const refs = [unit, file];
    expect(removeRef(refs, refKey(unit))).toEqual([file]);
    expect(removeRef(refs, "file:nope.ts")).toBe(refs);
  });
});

describe("lineRangeRef", () => {
  it("normalizes a range dragged upwards", () => {
    expect(lineRangeRef("a.ts", "new", 40, 12)).toEqual({
      kind: "line-range",
      path: "a.ts",
      side: "new",
      start: 12,
      end: 40,
    });
  });
});

describe("refLabel", () => {
  const ctx = refContext(detail, comments);

  it("shows a unit by its title", () => {
    expect(refLabel(unit, ctx)).toBe("Idempotent charge path");
  });

  it("falls back to a short id when the unit is unknown", () => {
    expect(refLabel({ kind: "unit", id: "abcdef123456" }, {})).toBe("unit abcdef12");
  });

  it("shows a file by basename", () => {
    expect(refLabel(file, ctx)).toBe("charge.ts");
  });

  it("shows a line range as file:start-end", () => {
    expect(refLabel(lines, ctx)).toBe("charge.ts:12-40");
  });

  it("collapses a single-line range and marks the old side", () => {
    expect(refLabel({ kind: "line-range", path: "a/b.go", side: "new", start: 7, end: 7 }, ctx)).toBe(
      "b.go:7",
    );
    expect(refLabel({ kind: "line-range", path: "a/b.go", side: "old", start: 7, end: 9 }, ctx)).toBe(
      "b.go:7-9 (old)",
    );
  });

  it("shows a hunk as its new-side range in the file", () => {
    expect(refLabel({ kind: "hunk", id: "h1" }, ctx)).toBe("charge.ts:12-40");
  });

  it("shows a comment by where it is anchored", () => {
    expect(refLabel({ kind: "comment", id: "draft-1" }, ctx)).toBe("comment @ ledger.ts:12");
  });

  it("uses the ref's own path when the comment is no longer loaded", () => {
    expect(refLabel({ kind: "comment", id: "gone", path: "x/y.ts", start: 4 }, ctx)).toBe(
      "comment @ y.ts:4",
    );
  });

  it("never renders an empty chip", () => {
    for (const ref of [
      { kind: "unit" } as ChatRef,
      { kind: "file" } as ChatRef,
      { kind: "hunk" } as ChatRef,
      { kind: "line-range" } as ChatRef,
      { kind: "comment" } as ChatRef,
    ]) {
      expect(refLabel(ref, {}).length).toBeGreaterThan(0);
    }
  });
});

describe("refTitle", () => {
  it("spells out the full path for a tooltip", () => {
    expect(refTitle(file)).toBe("File: src/billing/charge.ts");
    expect(refTitle(lines)).toBe("src/billing/charge.ts lines 12–40 (new side)");
  });
});

describe("baseName", () => {
  it("returns the last segment, and the whole string when there is none", () => {
    expect(baseName("a/b/c.go")).toBe("c.go");
    expect(baseName("c.go")).toBe("c.go");
    expect(baseName("")).toBe("");
  });
});
