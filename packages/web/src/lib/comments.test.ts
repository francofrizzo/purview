import { describe, expect, it } from "vitest";
import type { CommentStatus, DraftComment } from "../api/types";
import { bubbleTitle, groupComments, lineAnchor, mostAdvancedStatus, statusColors } from "./comments";

let seq = 0;
const c = (over: Partial<DraftComment> = {}): DraftComment => ({
  id: `c${seq++}`,
  file: "src/a.ts",
  line: 3,
  side: "RIGHT",
  body: "why?",
  status: "draft",
  subjectType: "line",
  ...over,
});

describe("groupComments", () => {
  it("buckets line comments under file:line:side", () => {
    const a = c({ line: 3 });
    const b = c({ line: 4 });
    const { byLine } = groupComments([a, b]);
    expect([...byLine.keys()]).toEqual(["src/a.ts:3:RIGHT", "src/a.ts:4:RIGHT"]);
    expect(byLine.get(lineAnchor("src/a.ts", 3, "RIGHT"))).toEqual([a]);
  });

  it("keeps several comments on one line in their incoming order", () => {
    const first = c({ line: 9, body: "one" });
    const second = c({ line: 9, body: "two" });
    const third = c({ line: 9, body: "three" });
    const { byLine } = groupComments([first, second, third]);
    expect(byLine.get("src/a.ts:9:RIGHT")?.map((x) => x.body)).toEqual(["one", "two", "three"]);
  });

  it("keeps the two sides of the same line number apart", () => {
    const left = c({ line: 5, side: "LEFT" });
    const right = c({ line: 5, side: "RIGHT" });
    const { byLine } = groupComments([left, right]);
    expect(byLine.get("src/a.ts:5:LEFT")).toEqual([left]);
    expect(byLine.get("src/a.ts:5:RIGHT")).toEqual([right]);
  });

  it("routes file-level comments to their own bucket, keyed by path", () => {
    const fileLevel = c({ subjectType: "file", line: null, side: null });
    const line = c({ line: 3 });
    const { byLine, byFile } = groupComments([fileLevel, line]);
    expect(byFile.get("src/a.ts")).toEqual([fileLevel]);
    expect(byLine.get("src/a.ts:3:RIGHT")).toEqual([line]);
    expect([...byLine.keys()]).toHaveLength(1);
  });

  it("treats a comment with a null line as file-level even without subjectType", () => {
    const legacy = { ...c(), subjectType: undefined, line: null } as DraftComment;
    const { byFile } = groupComments([legacy]);
    expect(byFile.get("src/a.ts")).toEqual([legacy]);
  });

  it("returns empty maps for an empty list", () => {
    const { byLine, byFile } = groupComments([]);
    expect(byLine.size).toBe(0);
    expect(byFile.size).toBe(0);
  });
});

describe("mostAdvancedStatus", () => {
  const cases: [CommentStatus[], CommentStatus][] = [
    [["draft"], "draft"],
    [["draft", "pushed"], "pushed"],
    [["submitted", "draft"], "submitted"],
    [["pushed", "submitted", "draft"], "submitted"],
    [["pushed", "pushed"], "pushed"],
  ];

  it.each(cases)("rolls %s up to %s", (statuses, expected) => {
    expect(mostAdvancedStatus(statuses.map((status) => ({ status })))).toBe(expected);
  });

  it("treats a missing status as a draft", () => {
    expect(mostAdvancedStatus([{}])).toBe("draft");
    expect(mostAdvancedStatus([{}, { status: "pushed" }])).toBe("pushed");
  });

  it("defaults to draft when there is nothing to roll up", () => {
    expect(mostAdvancedStatus([])).toBe("draft");
  });
});

describe("presentation helpers", () => {
  it("gives each status its own token pair", () => {
    const seen = new Set(
      (["draft", "pushed", "submitted"] as const).map((s) => statusColors(s).fg),
    );
    expect(seen.size).toBe(3);
  });

  it("counts and pluralises in the bubble tooltip", () => {
    expect(bubbleTitle([c()])).toContain("1 comment ");
    expect(bubbleTitle([c(), c({ status: "submitted" })])).toContain("2 comments");
    expect(bubbleTitle([c(), c({ status: "submitted" })])).toContain("submitted");
  });
});
