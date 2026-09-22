import { describe, expect, it } from "vitest";
import type { CommentStatus, DeletedComment, DraftComment, FilesJson } from "../api/types";
import {
  bubbleTitle,
  canUndoClaudeEdit,
  claudeDeletedDrafts,
  isByClaude,
  isCommentWriteTool,
  compareCommentOrder,
  groupComments,
  isCommentAnchored,
  lineAnchor,
  mostAdvancedStatus,
  statusColors,
} from "./comments";

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

describe("compareCommentOrder", () => {
  it("orders by file path first", () => {
    const z = c({ file: "src/z.ts", line: 1, body: "z" });
    const a = c({ file: "src/a.ts", line: 1, body: "a" });
    expect([z, a].sort(compareCommentOrder).map((x) => x.body)).toEqual(["a", "z"]);
  });

  it("puts a file-level comment ahead of every line comment in the same file", () => {
    const line = c({ file: "src/a.ts", line: 2, subjectType: "line", body: "line" });
    const fileLevel = c({ file: "src/a.ts", line: null, side: null, subjectType: "file", body: "file" });
    expect([line, fileLevel].sort(compareCommentOrder).map((x) => x.body)).toEqual(["file", "line"]);
  });

  it("orders line comments within a file by line number", () => {
    const nine = c({ file: "src/a.ts", line: 9, body: "9" });
    const two = c({ file: "src/a.ts", line: 2, body: "2" });
    expect([nine, two].sort(compareCommentOrder).map((x) => x.body)).toEqual(["2", "9"]);
  });

  it("breaks a line tie with LEFT before RIGHT", () => {
    const right = c({ file: "src/a.ts", line: 5, side: "RIGHT", body: "right" });
    const left = c({ file: "src/a.ts", line: 5, side: "LEFT", body: "left" });
    expect([right, left].sort(compareCommentOrder).map((x) => x.body)).toEqual(["left", "right"]);
  });

  it("is stable: comments tying on every key keep their incoming order", () => {
    const first = c({ file: "src/a.ts", line: 5, body: "first" });
    const second = c({ file: "src/a.ts", line: 5, body: "second" });
    const third = c({ file: "src/a.ts", line: 5, body: "third" });
    expect([first, second, third].sort(compareCommentOrder).map((x) => x.body)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("puts a whole diff's worth of comments in file-level-then-line, path, then line order", () => {
    const set = [
      c({ file: "src/z.ts", line: 1, body: "z1" }),
      c({ file: "src/a.ts", line: 9, body: "a9" }),
      c({ file: "src/z.ts", line: null, side: null, subjectType: "file", body: "zFile" }),
      c({ file: "src/a.ts", line: 2, body: "a2" }),
      c({ file: "src/a.ts", line: null, side: null, subjectType: "file", body: "aFile" }),
    ];
    expect(set.sort(compareCommentOrder).map((x) => x.body)).toEqual([
      "aFile",
      "a2",
      "a9",
      "zFile",
      "z1",
    ]);
  });
});

describe("isCommentAnchored", () => {
  const files: FilesJson = {
    files: [
      {
        path: "src/a.ts",
        hunks: [
          { id: "h1", file: "src/a.ts", oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, header: "" },
        ],
      },
    ],
  };

  it("is anchored when the RIGHT line falls inside a hunk's new range", () => {
    expect(isCommentAnchored(files, c({ file: "src/a.ts", line: 11, side: "RIGHT" }))).toBe(true);
  });

  it("is not anchored when the line falls outside every hunk", () => {
    expect(isCommentAnchored(files, c({ file: "src/a.ts", line: 999, side: "RIGHT" }))).toBe(false);
  });

  it("checks the LEFT side against oldStart/oldLines", () => {
    expect(isCommentAnchored(files, c({ file: "src/a.ts", line: 11, side: "LEFT" }))).toBe(true);
    expect(isCommentAnchored(files, c({ file: "src/a.ts", line: 999, side: "LEFT" }))).toBe(false);
  });

  it("is not anchored when the file isn't in the diff at all", () => {
    expect(isCommentAnchored(files, c({ file: "src/gone.ts", line: 11 }))).toBe(false);
  });

  it("treats a file-level comment as always anchored", () => {
    expect(
      isCommentAnchored(files, c({ file: "src/a.ts", line: null, side: null, subjectType: "file" })),
    ).toBe(true);
  });

  it("defaults a missing side to RIGHT, like the server does", () => {
    const { side: _side, ...rest } = c({ file: "src/a.ts", line: 11 });
    expect(isCommentAnchored(files, rest as DraftComment)).toBe(true);
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

describe("comments the chat wrote", () => {
  const hist = [{ body: "before", replacedAt: "2026-01-01T00:00:00Z", replacedBy: "claude" as const }];

  it("marks only Claude-authored comments", () => {
    expect(isByClaude(c({ author: "claude" }))).toBe(true);
    expect(isByClaude(c({ author: "you" }))).toBe(false);
    expect(isByClaude(c())).toBe(false);
  });

  it("offers undo only while Claude's edit to a draft is the latest one", () => {
    expect(canUndoClaudeEdit(c({ lastEditedBy: "claude", history: hist }))).toBe(true);
    expect(canUndoClaudeEdit(c({ lastEditedBy: "you", history: hist }))).toBe(false);
    expect(canUndoClaudeEdit(c({ lastEditedBy: "claude", history: [] }))).toBe(false);
    expect(canUndoClaudeEdit(c({ lastEditedBy: "claude", history: hist, status: "pushed" }))).toBe(false);
  });

  it("lists Claude's deletions newest first, minus the dismissed ones", () => {
    const d = (id: string, deletedAt: string, deletedBy: "you" | "claude"): DeletedComment => ({
      ...c({ id }),
      deletedAt,
      deletedBy,
    });
    const deleted = [
      d("a", "2026-01-01T00:00:00Z", "claude"),
      d("b", "2026-01-02T00:00:00Z", "claude"),
      d("mine", "2026-01-03T00:00:00Z", "you"),
    ];
    expect(claudeDeletedDrafts(deleted).map((x) => x.id)).toEqual(["b", "a"]);
    expect(claudeDeletedDrafts(deleted, new Set(["b"])).map((x) => x.id)).toEqual(["a"]);
  });

  it("recognises the chat's comment-writing tool calls", () => {
    const cli = "/usr/bin/node /x/core/dist/cli.js";
    expect(isCommentWriteTool({ name: "Bash", detail: `${cli} comment add github.com/a/b/1 --file x --line 2 --body 'hi'` })).toBe(true);
    expect(isCommentWriteTool({ name: "Bash", detail: `${cli} comment edit github.com/a/b/1 id --body 'x'` })).toBe(true);
    expect(isCommentWriteTool({ name: "Bash", detail: `${cli} comment delete github.com/a/b/1 id` })).toBe(true);
    expect(isCommentWriteTool({ name: "Bash", detail: `${cli} comment list github.com/a/b/1` })).toBe(false);
    expect(isCommentWriteTool({ name: "Bash", detail: `${cli} show github.com/a/b/1 x` })).toBe(false);
    expect(isCommentWriteTool({ name: "Read", detail: "comment add" })).toBe(false);
  });
});
