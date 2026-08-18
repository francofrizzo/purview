import { describe, expect, it } from "vitest";
import type { FileEntry, FilesJson, Hunk } from "../api/types";
import {
  blockquote,
  formatBundle,
  formatComment,
  repoLabel,
  selectForBundle,
  snippetFor,
  sortComments,
  STALE_NOTE,
  type DiffContext,
  type ExportableComment,
} from "./agentExport";

// buildRows caches by hunk id, so every fixture hunk needs its own.
let seq = 0;

function hunk(file: string, newStart: number, lines: string[]): Hunk {
  const oldLines = lines.filter((l) => !l.startsWith("+")).length;
  const newLines = lines.filter((l) => !l.startsWith("-")).length;
  return {
    id: `ae-${seq++}`,
    file,
    header: "",
    oldStart: newStart,
    oldLines,
    newStart,
    newLines,
    lines,
  };
}

function ctxOf(...entries: FileEntry[]): DiffContext {
  const files: FilesJson = { files: entries };
  return { files, diff: "" };
}

function file(path: string, hunks: Hunk[]): FileEntry {
  return { path, hunks };
}

const comment = (over: Partial<ExportableComment> = {}): ExportableComment => ({
  file: "src/a.ts",
  line: 3,
  side: "RIGHT",
  body: "why?",
  ...over,
});

describe("formatComment", () => {
  it("renders heading, fenced snippet and blockquoted body", () => {
    const ctx = ctxOf(
      file("src/a.ts", [
        hunk("src/a.ts", 1, [" one", " two", "-old", "+new", " four", " five"]),
      ]),
    );
    // rows: one(1) two(2) -old +new(3) four(4) five(5); the anchor is the
    // added row, so ±2 rows drops "one" and keeps the paired deletion.
    expect(formatComment(comment({ line: 3 }), ctx)).toBe(
      [
        "### `src/a.ts:3` (new side)",
        "```typescript",
        "two",
        "-old",
        "+new",
        "four",
        "five",
        "```",
        "> why?",
      ].join("\n"),
    );
  });

  it("keeps +/- on changed lines and strips the marker from context", () => {
    const ctx = ctxOf(file("src/a.ts", [hunk("src/a.ts", 1, [" ctx", "+added", " tail"])]));
    const out = formatComment(comment({ line: 2 }), ctx);
    expect(out).toContain("\nctx\n");
    expect(out).toContain("\n+added\n");
  });

  it("anchors on the old side for LEFT comments", () => {
    const ctx = ctxOf(
      file("src/a.ts", [hunk("src/a.ts", 1, [" a", "-gone", "+kept", " b"])]),
    );
    const out = formatComment(comment({ line: 2, side: "LEFT" }), ctx);
    expect(out.startsWith("### `src/a.ts:2` (old side)")).toBe(true);
    expect(out).toContain("-gone");
  });

  it("quotes every line of a multi-line body, blanks included", () => {
    const ctx = ctxOf(file("src/a.ts", [hunk("src/a.ts", 1, [" a"])]));
    const out = formatComment(comment({ line: 1, body: "first\n\nsecond" }), ctx);
    expect(out.endsWith("> first\n>\n> second")).toBe(true);
  });

  it("numbers the heading when an index is given", () => {
    const ctx = ctxOf(file("src/a.ts", [hunk("src/a.ts", 1, [" a"])]));
    expect(formatComment(comment({ line: 1 }), ctx, 4)).toContain("### 4. `src/a.ts:1`");
  });
});

describe("context slicing", () => {
  const lines = [" l1", " l2", " l3", " l4", " l5", " l6", " l7"];

  it("takes two lines either side of the anchor", () => {
    const ctx = ctxOf(file("src/a.ts", [hunk("src/a.ts", 1, lines)]));
    expect(snippetFor(comment({ line: 4 }), ctx)?.lines).toEqual([
      "l2",
      "l3",
      "l4",
      "l5",
      "l6",
    ]);
  });

  it("clamps at the start of the hunk instead of padding", () => {
    const ctx = ctxOf(file("src/a.ts", [hunk("src/a.ts", 1, lines)]));
    expect(snippetFor(comment({ line: 1 }), ctx)?.lines).toEqual(["l1", "l2", "l3"]);
  });

  it("clamps at the end of the hunk", () => {
    const ctx = ctxOf(file("src/a.ts", [hunk("src/a.ts", 1, lines)]));
    expect(snippetFor(comment({ line: 7 }), ctx)?.lines).toEqual(["l5", "l6", "l7"]);
  });

  it("picks the hunk that actually contains the line", () => {
    const ctx = ctxOf(
      file("src/a.ts", [
        hunk("src/a.ts", 1, [" a", " b"]),
        hunk("src/a.ts", 40, [" x", " y", " z"]),
      ]),
    );
    expect(snippetFor(comment({ line: 41 }), ctx)?.lines).toEqual(["x", "y", "z"]);
  });
});

describe("stale comments", () => {
  it("notes the missing line instead of emitting an empty fence", () => {
    const ctx = ctxOf(file("src/a.ts", [hunk("src/a.ts", 1, [" a", " b"])]));
    const out = formatComment(comment({ line: 900 }), ctx);
    expect(out).toBe(
      ["### `src/a.ts:900` (new side)", STALE_NOTE, "> why?"].join("\n"),
    );
    expect(out).not.toContain("```");
  });

  it("is stale when the file itself is gone from the revision", () => {
    const ctx = ctxOf(file("src/other.ts", [hunk("src/other.ts", 1, [" a"])]));
    expect(snippetFor(comment({ line: 1 }), ctx)).toBeNull();
  });
});

describe("language inference", () => {
  const cases: [string, string][] = [
    ["src/a.ts", "typescript"],
    ["src/a.tsx", "tsx"],
    ["migrations/0042.sql", "sql"],
    ["docs/readme.md", "markdown"],
    ["cmd/main.go", "go"],
    ["Makefile", ""],
    ["data.weirdext", ""],
  ];

  it.each(cases)("infers the fence tag for %s", (path, lang) => {
    const ctx = ctxOf(file(path, [hunk(path, 1, [" a"])]));
    expect(snippetFor(comment({ file: path, line: 1 }), ctx)?.lang).toBe(lang);
  });

  it("uses a plain fence when the language is unknown", () => {
    const ctx = ctxOf(file("Makefile", [hunk("Makefile", 1, [" all:"])]));
    expect(formatComment(comment({ file: "Makefile", line: 1 }), ctx)).toContain("\n```\nall:\n```");
  });
});

describe("ordering and filtering", () => {
  const set: ExportableComment[] = [
    comment({ file: "src/z.ts", line: 2, body: "z2" }),
    comment({ file: "src/a.ts", line: 9, body: "a9" }),
    comment({ file: "src/a.ts", line: 2, body: "a2" }),
  ];

  it("orders by file path then line", () => {
    expect(sortComments(set).map((c) => c.body)).toEqual(["a2", "a9", "z2"]);
  });

  it("keeps draft and pushed, drops submitted by default", () => {
    const mixed = [
      comment({ file: "a", line: 1, status: "submitted", body: "s" }),
      comment({ file: "b", line: 1, status: "pushed", body: "p" }),
      comment({ file: "c", line: 1, status: "draft", body: "d" }),
      comment({ file: "d", line: 1, body: "u" }), // no status → draft
    ];
    expect(selectForBundle(mixed).map((c) => c.body)).toEqual(["p", "d", "u"]);
    expect(selectForBundle(mixed, true).map((c) => c.body)).toEqual(["s", "p", "d", "u"]);
  });
});

describe("formatBundle", () => {
  const ctx = ctxOf(
    file("src/a.ts", [hunk("src/a.ts", 1, [" a1", " a2", " a3"])]),
    file("src/z.ts", [hunk("src/z.ts", 1, [" z1", " z2"])]),
  );
  const comments: ExportableComment[] = [
    comment({ file: "src/z.ts", line: 1, body: "second" }),
    comment({ file: "src/a.ts", line: 2, body: "first" }),
    comment({ file: "src/a.ts", line: 3, status: "submitted", body: "public" }),
  ];

  it("heads the bundle with the repo and revision, and numbers in file order", () => {
    const out = formatBundle(comments, ctx, { repoLabel: "acme/billing#482", revision: 3 });
    expect(out.startsWith("## Review feedback for acme/billing#482 (rev 3)\n")).toBe(true);
    expect(out).toContain("### 1. `src/a.ts:2` (new side)");
    expect(out).toContain("### 2. `src/z.ts:1` (new side)");
    expect(out).not.toContain("public");
  });

  it("renumbers when submitted comments are included", () => {
    const out = formatBundle(comments, ctx, {
      repoLabel: "acme/billing#482",
      revision: 3,
      includeSubmitted: true,
    });
    expect(out).toContain("### 1. `src/a.ts:2`");
    expect(out).toContain("### 2. `src/a.ts:3`");
    expect(out).toContain("### 3. `src/z.ts:1`");
  });

  it("puts a non-empty review body in as a plain preamble", () => {
    const out = formatBundle(comments, ctx, { repoLabel: "r#1", reviewBody: "  Looks close.  " });
    expect(out).toContain("## Review feedback for r#1\n\nLooks close.\n\n### 1.");
  });

  it("omits the preamble entirely when the review body is blank", () => {
    const out = formatBundle(comments, ctx, { repoLabel: "r#1", reviewBody: "   \n " });
    expect(out).toContain("## Review feedback for r#1\n\n### 1.");
  });

  it("returns empty text when nothing is selected", () => {
    const onlySubmitted = [comment({ status: "submitted" })];
    expect(formatBundle(onlySubmitted, ctx)).toBe("");
    expect(formatBundle([], ctx)).toBe("");
  });
});

describe("helpers", () => {
  it("builds the repo label from PR meta", () => {
    expect(repoLabel({ owner: "acme", repo: "billing", number: 482 })).toBe("acme/billing#482");
  });

  it("trims trailing whitespace off a quoted body", () => {
    expect(blockquote("a\n\n")).toBe("> a");
  });
});
