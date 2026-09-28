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
