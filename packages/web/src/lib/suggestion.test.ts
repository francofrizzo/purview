import { describe, expect, it } from "vitest";
import type { FilesJson, Hunk } from "../api/types";
import type { TextEdit } from "./composerFormat";
import { anchoredLines, insertSuggestion, suggestionBlock, suggestionSource } from "./suggestion";

/** The edit, with the selection drawn in as «…» so a test reads like the screen. */
const shown = (e: TextEdit) => `${e.text.slice(0, e.start)}«${e.text.slice(e.start, e.end)}»${e.text.slice(e.end)}`;

describe("suggestionBlock", () => {
  it("fences the lines as a suggestion, verbatim", () => {
    expect(suggestionBlock(["  const a = 1;", "\treturn a;"])).toBe("```suggestion\n  const a = 1;\n\treturn a;\n```");
  });

  it("keeps an empty line as an empty block body", () => {
    expect(suggestionBlock([""])).toBe("```suggestion\n\n```");
  });

  it("uses a longer fence when a line holds triple backticks", () => {
    expect(suggestionBlock(["const md = '```ts';"])).toBe("````suggestion\nconst md = '```ts';\n````");
    expect(suggestionBlock(["a ````` b"])).toBe("``````suggestion\na ````` b\n``````");
  });

  it("is happy with a short backtick run inside", () => {
    expect(suggestionBlock(["use `x` here"])).toBe("```suggestion\nuse `x` here\n```");
  });
});

describe("insertSuggestion", () => {
  it("goes in at the caret with the code selected, on its own lines", () => {
    expect(shown(insertSuggestion("", { start: 0, end: 0 }, ["x"]))).toBe("```suggestion\n«x»\n```\n");
    expect(shown(insertSuggestion("Try this:", { start: 9, end: 9 }, ["x"]))).toBe("Try this:\n```suggestion\n«x»\n```\n");
  });

  it("adds no extra break when the caret already sits at a line start or before one", () => {
    expect(shown(insertSuggestion("a\n\nb", { start: 2, end: 2 }, ["x"]))).toBe("a\n```suggestion\n«x»\n```\nb");
    expect(shown(insertSuggestion("a\nb", { start: 1, end: 1 }, ["x"]))).toBe("a\n```suggestion\n«x»\n```\nb");
  });

  it("replaces a selection, and selects a multi-line body whole", () => {
    const e = insertSuggestion("keep DROP keep", { start: 5, end: 9 }, ["one", "two"]);
    expect(shown(e)).toBe("keep \n```suggestion\n«one\ntwo»\n```\n keep");
  });

  it("lets a second block follow the first", () => {
    const first = insertSuggestion("", { start: 0, end: 0 }, ["x"]);
    const at = first.text.length;
    expect(shown(insertSuggestion(first.text, { start: at, end: at }, ["x"]))).toBe(
      "```suggestion\nx\n```\n```suggestion\n«x»\n```\n",
    );
  });
});

function hunk(lines: string[], over: Partial<Hunk> = {}): Hunk {
  return {
    id: "h1",
    file: "a.ts",
    oldStart: 10,
    oldLines: lines.filter((l) => !l.startsWith("+")).length,
    newStart: 20,
    newLines: lines.filter((l) => !l.startsWith("-")).length,
    header: "",
    lines,
    ...over,
  } as Hunk;
}

const files = (...hunks: Hunk[]): FilesJson => ({ files: [{ path: "a.ts", hunks }] }) as unknown as FilesJson;

// new 20: ctx, 21: added, 22: added, (old 12 removed), 23: ctx
const h = hunk([" ctx", "+\tadded one", "+added two", "-gone", " after"]);

describe("anchoredLines", () => {
  it("reads one line, tabs and all, without its marker", () => {
    expect(anchoredLines(files(h), { file: "a.ts", line: 21, side: "RIGHT" })).toEqual(["\tadded one"]);
    expect(anchoredLines(files(h), { file: "a.ts", line: 20, side: "RIGHT" })).toEqual(["ctx"]);
  });

  it("reads a range, skipping the other side's lines in between", () => {
    expect(anchoredLines(files(h), { file: "a.ts", line: 23, side: "RIGHT", startLine: 21 })).toEqual([
      "\tadded one",
      "added two",
      "after",
    ]);
  });

  it("follows the old side's numbering for a LEFT comment", () => {
    expect(anchoredLines(files(h), { file: "a.ts", line: 12, side: "LEFT", startLine: 11 })).toEqual(["gone", "after"]);
  });

  it("is null off the diff, on an unknown file, or for a file-level comment", () => {
    expect(anchoredLines(files(h), { file: "a.ts", line: 99, side: "RIGHT" })).toBeNull();
    expect(anchoredLines(files(h), { file: "b.ts", line: 21, side: "RIGHT" })).toBeNull();
    expect(anchoredLines(files(h), { file: "a.ts", line: null, side: null, subjectType: "file" })).toBeNull();
  });

  it("is null when the range straddles two hunks", () => {
    const h2 = hunk([" far"], { id: "h2", oldStart: 50, newStart: 60 });
    expect(anchoredLines(files(h, h2), { file: "a.ts", line: 60, side: "RIGHT", startLine: 23 })).toBeNull();
  });
});

describe("suggestionSource", () => {
  it("offers the covered lines on the new side", () => {
    expect(suggestionSource(files(h), { file: "a.ts", line: 22, side: "RIGHT", startLine: 21 })).toEqual({
      lines: ["\tadded one", "added two"],
      reason: null,
    });
  });

  it("explains why not: old side, whole file, or lines the diff no longer shows", () => {
    expect(suggestionSource(files(h), { file: "a.ts", line: 11, side: "LEFT" }).reason).toMatch(/new side/);
    expect(suggestionSource(files(h), { file: "a.ts", line: null, side: null, subjectType: "file" }).reason).toMatch(/whole file/);
    expect(suggestionSource(files(h), { file: "a.ts", line: 99, side: "RIGHT" }).reason).toMatch(/not in the current diff/);
    expect(suggestionSource(undefined, { file: "a.ts", line: 21, side: "RIGHT" }).lines).toBeNull();
  });
});
