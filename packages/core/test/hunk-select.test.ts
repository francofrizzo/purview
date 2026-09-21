import { describe, expect, it } from "vitest";
import { computeHunkId } from "../src/hunk-id.js";
import { allSelectedHunks, globToRegExp, selectHunks } from "../src/hunk-select.js";
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
