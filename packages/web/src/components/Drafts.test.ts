import { describe, expect, it } from "vitest";
import { refKey } from "../lib/chatRefs";
import { targetRef } from "./Drafts";

describe("targetRef", () => {
  it("points a line comment box at its one line, on its side", () => {
    expect(targetRef({ subjectType: "line", file: "a.go", line: 23, side: "RIGHT" })).toEqual({
      kind: "line-range",
      path: "a.go",
      side: "new",
      start: 23,
      end: 23,
    });
    expect(targetRef({ subjectType: "line", file: "a.go", line: 4, side: "LEFT" }).side).toBe("old");
  });

  it("points a file comment box at the file", () => {
    const ref = targetRef({ subjectType: "file", file: "a.go" });
    expect(ref).toEqual({ kind: "file", path: "a.go" });
    expect(refKey(ref)).toBeTruthy();
  });
});

describe("multi-line targets", async () => {
  const { commentAnchorLabel, commentRef, targetKey, targetToInput } = await import("./Drafts");
  const range = { subjectType: "line" as const, file: "a.go", line: 18, side: "RIGHT" as const, startLine: 12 };

  it("quotes the whole range into chat", () => {
    expect(targetRef(range)).toEqual({ kind: "line-range", path: "a.go", side: "new", start: 12, end: 18 });
  });

  it("keys a range apart from the single line it ends on", () => {
    expect(targetKey(range)).not.toBe(targetKey({ ...range, startLine: undefined }));
  });

  it("posts startLine/startSide, and drops a one-line 'range'", () => {
    expect(targetToInput(range, "x")).toEqual({
      subjectType: "line",
      file: "a.go",
      line: 18,
      side: "RIGHT",
      startLine: 12,
      startSide: "RIGHT",
      body: "x",
    });
    expect(targetToInput({ ...range, startLine: 18 }, "x")).not.toHaveProperty("startLine");
  });

  it("labels and refs a range comment with its lines", () => {
    const c = { id: "c", file: "src/a.go", line: 18, startLine: 12, side: "LEFT" as const, body: "b" };
    expect(commentAnchorLabel(c)).toBe("src/a.go:12–18 (old)");
    expect(commentAnchorLabel({ ...c, startLine: null })).toBe("src/a.go:18 (old)");
    expect(commentRef(c)).toEqual({ kind: "comment", id: "c", path: "src/a.go", start: 12, end: 18, side: "old" });
    expect(commentRef({ ...c, startLine: undefined })).toEqual({ kind: "comment", id: "c", path: "src/a.go", start: 18, side: "old" });
  });
});
