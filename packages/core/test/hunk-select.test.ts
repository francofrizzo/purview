import { describe, expect, it } from "vitest";
import { computeHunkId } from "../src/hunk-id.js";
import { allSelectedHunks, globToRegExp, renderShowHunk, selectHunks } from "../src/hunk-select.js";
import type { FileDiff, FilesJson, Hunk } from "../src/schemas.js";

function mkHunk(file: string, added: string[], removed: string[]): Hunk {
  return {
    id: computeHunkId(file, added, removed),
    file,
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    header: "h",
    addedLines: added,
    removedLines: removed,
    text: "t",
  };
}

const h1 = mkHunk("src/a.ts", ["x"], []);
const h2 = mkHunk("src/b.ts", ["y"], []);
const h3 = mkHunk("src/nested/c.ts", ["z"], []);

const fj: FilesJson = {
  revision: 1,
  files: [
    { path: "src/a.ts", status: "modified", binary: false, hunks: [h1] },
    { path: "src/b.ts", status: "modified", binary: false, hunks: [h2] },
    { path: "src/nested/c.ts", status: "modified", binary: false, hunks: [h3] },
  ],
};

describe("selectHunks", () => {
  it("matches an exact hunk id", () => {
    const { hunks, unknown } = selectHunks(fj, [h1.id]);
    expect(hunks.map((sh) => sh.hunk.id)).toEqual([h1.id]);
    expect(unknown).toEqual([]);
  });

  it("matches a unique id prefix of >= 6 chars", () => {
    const prefix = h2.id.slice(0, 6);
    const { hunks, unknown } = selectHunks(fj, [prefix]);
    expect(hunks.map((sh) => sh.hunk.id)).toEqual([h2.id]);
    expect(unknown).toEqual([]);
  });

  it("treats a short (<6 char) unmatched string as unknown rather than a prefix", () => {
    const shortPrefix = h1.id.slice(0, 4);
    const { hunks, unknown } = selectHunks(fj, [shortPrefix]);
    expect(hunks).toEqual([]);
    expect(unknown).toEqual([shortPrefix]);
  });

  it("matches an exact file path (all its hunks)", () => {
    const { hunks, unknown } = selectHunks(fj, ["src/a.ts"]);
    expect(hunks.map((sh) => sh.hunk.id)).toEqual([h1.id]);
    expect(unknown).toEqual([]);
  });

  it("matches a glob over file paths", () => {
    const { hunks, unknown } = selectHunks(fj, ["src/*.ts"]);
    expect(hunks.map((sh) => sh.hunk.id).sort()).toEqual([h1.id, h2.id].sort());
    expect(unknown).toEqual([]);
    expect(hunks.some((sh) => sh.hunk.id === h3.id)).toBe(false); // ** needed for nested
  });

  it("`**` glob crosses directories (single `*` does not)", () => {
    const { hunks } = selectHunks(fj, ["src/**"]);
    expect(hunks.map((sh) => sh.hunk.id).sort()).toEqual([h1.id, h2.id, h3.id].sort());
  });

  it("reports an unknown selector while still returning what matched", () => {
    const { hunks, unknown } = selectHunks(fj, [h1.id, "no/such/file.ts"]);
    expect(hunks.map((sh) => sh.hunk.id)).toEqual([h1.id]);
    expect(unknown).toEqual(["no/such/file.ts"]);
  });

  it("dedupes a hunk matched by several selectors and preserves files.json order", () => {
    const { hunks } = selectHunks(fj, [h2.id, "src/a.ts", h1.id]);
    expect(hunks.map((sh) => sh.hunk.id)).toEqual([h1.id, h2.id]);
  });

  it("--all equivalent returns every hunk in files.json order", () => {
    expect(allSelectedHunks(fj).map((sh) => sh.hunk.id)).toEqual([h1.id, h2.id, h3.id]);
  });
});

describe("globToRegExp", () => {
  it("lets `**/` match zero directories as well as many", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/x/y/a.ts")).toBe(true);
    expect(re.test("src/a.go")).toBe(false);
    expect(re.test("other/src/a.ts")).toBe(false);
    expect(globToRegExp("**/*_test.go").test("a_test.go")).toBe(true);
    expect(globToRegExp("src/**").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
  });
});

describe("renderShowHunk", () => {
  it("prefixes every body line with its old/new source line numbers", () => {
    const hunk: Hunk = {
      ...mkHunk("src/a.go", ["b2", "b3"], ["a2"]),
      oldStart: 98,
      oldLines: 4,
      newStart: 98,
      newLines: 5,
      header: " func F()",
      text: [" ctx1", "-a2", "+b2", "+b3", " ctx2", "", "\\ No newline at end of file"].join("\n"),
    };
    const file: FileDiff = { path: "src/a.go", status: "modified", binary: false, hunks: [hunk] };
    expect(renderShowHunk({ file, hunk })).toBe(
      [
        `=== src/a.go   ${hunk.id}   +2 -1   @@ func F()@@`,
        " 98  98 │ ctx1",
        " 99     │-a2",
        "     99 │+b2",
        "    100 │+b3",
        "100 101 │ ctx2",
        "101 102 │",
        "        │\\ No newline at end of file",
        "",
        "",
      ].join("\n"),
    );
  });

  it("numbers an added file's lines from its new side only", () => {
    const hunk: Hunk = {
      ...mkHunk("src/new.ts", ["x", "y"], []),
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      text: "+x\n+y",
    };
    const file: FileDiff = { path: "src/new.ts", status: "added", binary: false, hunks: [hunk] };
    const body = renderShowHunk({ file, hunk }).split("\n").slice(1, 3);
    expect(body).toEqual(["  1 │+x", "  2 │+y"]);
  });
});
