import { describe, expect, it } from "vitest";
import { diffOfDiffs } from "../src/diff-of-diffs.js";

describe("diffOfDiffs", () => {
  it("reports no change for identical hunks", () => {
    const d = diffOfDiffs("+a\n b\n", "+a\n b\n");
    expect(d.changed).toBe(false);
    expect(d.lines.every((l) => l.type === "unchanged")).toBe(true);
  });

  it("produces word-level parts for an edited line", () => {
    const d = diffOfDiffs(
      ' const token = makeToken(user);\n+  audit(user, "logout", Date.now());\n',
      ' const token = makeToken(user);\n+  audit(user, "logout", clock.now());\n',
    );
    expect(d.changed).toBe(true);
    const modified = d.lines.find((l) => l.type === "modified")!;
    expect(modified.parts!.some((p) => p.type === "removed" && p.value.includes("Date"))).toBe(true);
    expect(modified.parts!.some((p) => p.type === "added" && p.value.includes("clock"))).toBe(true);
    expect(modified.parts!.some((p) => p.type === "same" && p.value.includes("audit"))).toBe(true);
  });

  it("reports pure insertions and deletions", () => {
    const d = diffOfDiffs(" a\n b\n", " a\n b\n+c\n");
    expect(d.lines.filter((l) => l.type === "added").map((l) => l.newLine)).toEqual(["+c"]);

    const d2 = diffOfDiffs(" a\n b\n", " a\n");
    expect(d2.lines.filter((l) => l.type === "removed").map((l) => l.oldLine)).toEqual([" b"]);
  });
});
