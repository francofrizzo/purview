import { describe, expect, it } from "vitest";
import type { FilesJson, Hunk, ReviewUnit } from "../api/types";
import {
  buildSearchIndex,
  countsByFile,
  countsByUnit,
  matchRangesByLine,
  searchDiff,
  unitForHunk,
} from "./diffSearch";

let seq = 0;
function hunk(lines: string[], file = "a.ts"): Hunk {
  return {
    id: `h${seq++}`,
    file,
    oldStart: 1,
    oldLines: lines.filter((l) => !l.startsWith("+")).length,
    newStart: 1,
    newLines: lines.filter((l) => !l.startsWith("-")).length,
    header: "",
    lines,
  } as Hunk;
}

function files(entries: { path: string; hunks: Hunk[] }[]): FilesJson {
  return { files: entries.map((e) => ({ path: e.path, hunks: e.hunks })) } as FilesJson;
}

describe("buildSearchIndex", () => {
  it("indexes every row with its file, side and line number", () => {
    const h = hunk(["-const a = 1;", "+const b = 2;", " untouched"]);
    const index = buildSearchIndex(files([{ path: "a.ts", hunks: [h] }]), "");
    expect(index.lines).toHaveLength(3);
    expect(index.lines[0]).toMatchObject({
      path: "a.ts",
      hunkId: h.id,
      lineIdx: 0,
      type: "del",
      side: "old",
      line: 1,
      content: "const a = 1;",
    });
    expect(index.lines[1]).toMatchObject({ type: "add", side: "new", line: 1 });
    expect(index.lines[2]).toMatchObject({ type: "context", side: "new", line: 2 });
  });
});

describe("searchDiff", () => {
  const h1 = hunk(["-const Alpha = 1;", "+const alpha = 2;", " alpha context"], "a.ts");
  const h2 = hunk(["+// alpha alpha", " noise"], "b.ts");
  const index = buildSearchIndex(
    files([
      { path: "a.ts", hunks: [h1] },
      { path: "b.ts", hunks: [h2] },
    ]),
    "",
  );

  it("returns match positions inside the row content", () => {
    const matches = searchDiff(index, "alpha");
    // content has the +/- marker stripped, so offsets are into the code itself
    expect(matches[0]).toMatchObject({ path: "a.ts", lineIdx: 0, start: 6, end: 11, side: "old" });
    expect(matches[1]).toMatchObject({ path: "a.ts", lineIdx: 1, start: 6, end: 11, side: "new" });
  });

  it("defaults to changed lines only, and widens to context on request", () => {
    expect(searchDiff(index, "alpha").map((m) => m.lineIdx)).toEqual([0, 1, 0, 0]);
    const all = searchDiff(index, "alpha", { changedOnly: false });
    // the context line of a.ts joins, in diff order
    expect(all).toHaveLength(5);
    expect(all[2]).toMatchObject({ path: "a.ts", lineIdx: 2, side: "new" });
  });

  it("is case-insensitive by default and exact with the toggle on", () => {
    expect(searchDiff(index, "ALPHA")).toHaveLength(4);
    expect(searchDiff(index, "Alpha", { caseSensitive: true })).toHaveLength(1);
    expect(searchDiff(index, "alpha", { caseSensitive: true })).toHaveLength(3);
  });

  it("reports repeated hits on one line, left to right, without overlap", () => {
    const hits = searchDiff(index, "alpha").filter((m) => m.path === "b.ts");
    expect(hits.map((m) => m.start)).toEqual([3, 9]);
    const aa = buildSearchIndex(files([{ path: "c.ts", hunks: [hunk(["+aaaa"])] }]), "");
    expect(searchDiff(aa, "aa").map((m) => m.start)).toEqual([0, 2]);
  });

  it("sorts in diff order: file, then hunk, then row", () => {
    expect(searchDiff(index, "alpha").map((m) => `${m.path}:${m.lineIdx}`)).toEqual([
      "a.ts:0",
      "a.ts:1",
      "b.ts:0",
      "b.ts:0",
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchDiff(index, "")).toEqual([]);
  });
});

describe("grouping helpers", () => {
  const h1 = hunk(["+alpha", "+alpha alpha"], "a.ts");
  const h2 = hunk(["+alpha"], "b.ts");
  const index = buildSearchIndex(
    files([
      { path: "a.ts", hunks: [h1] },
      { path: "b.ts", hunks: [h2] },
    ]),
    "",
  );
  const matches = searchDiff(index, "alpha");

  it("groups ranges per rendered row", () => {
    const byLine = matchRangesByLine(matches);
    expect(byLine.get(`${h1.id}:1`)).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ]);
    expect(byLine.get(`${h2.id}:0`)).toEqual([{ start: 0, end: 5 }]);
  });

  it("counts per file and per unit", () => {
    expect([...countsByFile(matches)]).toEqual([
      ["a.ts", 3],
      ["b.ts", 1],
    ]);
    const units: ReviewUnit[] = [
      { id: "u1", hunkIds: [h1.id] } as ReviewUnit,
      { id: "u2", hunkIds: [h2.id] } as ReviewUnit,
      { id: "u3", hunkIds: [] } as unknown as ReviewUnit,
    ];
    const perUnit = countsByUnit(matches, units);
    expect(perUnit.get("u1")).toBe(3);
    expect(perUnit.get("u2")).toBe(1);
    // zero-match units are simply absent, so a row can render unchanged
    expect(perUnit.has("u3")).toBe(false);
    expect(unitForHunk(units, h2.id)?.id).toBe("u2");
    expect(unitForHunk(units, "nope")).toBeNull();
  });
});
