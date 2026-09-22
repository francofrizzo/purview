import { describe, expect, it } from "vitest";
import {
  MAX_INTRODUCED_LINES,
  alignBodies,
  computeRevisionLineChanges,
  hunkBodyLines,
} from "../src/line-changes.js";
import type { FileDiff, Hunk, MigrationEntry, MigrationReport } from "../src/schemas.js";

function hunk(id: string, file: string, body: string[]): Hunk {
  return {
    id,
    file,
    oldStart: 1,
    oldLines: body.filter((l) => !l.startsWith("+")).length,
    newStart: 1,
    newLines: body.filter((l) => !l.startsWith("-")).length,
    header: "",
    addedLines: body.filter((l) => l.startsWith("+")).map((l) => l.slice(1)),
    removedLines: body.filter((l) => l.startsWith("-")).map((l) => l.slice(1)),
    text: body.join("\n"),
  };
}

function files(...hunks: Hunk[]): FileDiff[] {
  const byPath = new Map<string, Hunk[]>();
  for (const h of hunks) byPath.set(h.file, [...(byPath.get(h.file) ?? []), h]);
  return [...byPath].map(([path, hs]) => ({ path, status: "modified" as const, hunks: hs }));
}

function report(revision: number, entries: MigrationEntry[]): MigrationReport {
  const counts = { identical: 0, fuzzy: 0, renamed: 0, archived: 0, new: 0 };
  for (const e of entries) counts[e.status]++;
  return { revision, previousRevision: revision - 1, baseOnly: false, counts, entries };
}

const same = (id: string, file = "a.ts"): MigrationEntry => ({
  status: "identical",
  hunkId: id,
  previousHunkId: id,
  file,
});
const fuzzy = (from: string, to: string, file = "a.ts"): MigrationEntry => ({
  status: "fuzzy",
  hunkId: to,
  previousHunkId: from,
  file,
});

// r1 -> r2: A1 reworked into A2, B unchanged, C new.
const A1 = hunk("A1", "a.ts", [" ctx", "-old", "+first", "+  }", " tail"]);
const A2 = hunk("A2", "a.ts", [" ctx", "-old", "+first", "+second", "+  }", "+  }", " tail"]);
const B = hunk("B", "b.ts", [" x", "+y"]);
const C = hunk("C", "c.ts", ["+new one", "+new two", " ctx"]);
const R2 = report(2, [fuzzy("A1", "A2"), same("B", "b.ts"), { status: "new", hunkId: "C", file: "c.ts" }]);


/** Run the pure core over a chain r1..rK of one hunk per revision, linked by `status`. */
function chain(
  bodies: string[][],
  statuses: ("fuzzy" | "identical")[] = [],
  opts: { revision?: number } = {},
) {
  const hs = bodies.map((b, i) => hunk(`H${i + 1}`, "a.ts", b));
  const revision = opts.revision ?? 2;
  // identical steps keep the id: give the next hunk the same id.
  statuses.forEach((s, i) => {
    if (s === "identical") hs[i + 1] = { ...hs[i + 1], id: hs[i].id };
  });
  const reports = hs.slice(1).map((h, i) =>
    report(i + 2, [
      statuses[i] === "identical"
        ? { status: "identical" as const, hunkId: h.id, previousHunkId: hs[i].id, file: "a.ts" }
        : fuzzy(hs[i].id, h.id),
    ]),
  );
  const filesOf = new Map(hs.map((h, i) => [i + 1, files(h)]));
  return computeRevisionLineChanges({
    revision,
    currentRevision: hs.length,
    report: reports[revision - 2],
    previousFiles: filesOf.get(revision - 1),
    revisionFiles: filesOf.get(revision)!,
    laterReports: reports.slice(revision - 1),
    filesAt: (r) => filesOf.get(r),
    currentFiles: filesOf.get(hs.length),
  });
}

describe("hunkBodyLines (the index space shared with the web)", () => {
  it("is the raw split of `text`, markers and empty lines included", () => {
    const text = [" a", "-b", "\\ No newline at end of file", "+b", "", "+c"].join("\n");
    expect(hunkBodyLines(text)).toEqual([" a", "-b", "\\ No newline at end of file", "+b", "", "+c"]);
    expect(hunkBodyLines("")).toEqual([]);
  });
});

describe("alignBodies", () => {
  it("groups non-equal runs into blocks with the index past them", () => {
    const a = alignBodies([" a", "+x", " b", "+y"], [" a", "+X", " b"]);
    expect(a.kept).toEqual(new Map([[0, 0], [2, 2]]));
    expect(a.blocks).toEqual([
      { removed: [1], added: [1], end: 2 },
      { removed: [3], added: [], end: 3 },
    ]);
  });
});

describe("computeRevisionLineChanges", () => {
  const r1 = [" ctx", "+if a {", "+\treturn", "+\t}", " tail"];
  const r2 = [" ctx", "+if a {", "+\treturn", "+\t}", "+if b {", "+\treturn err", "+\t}", " tail"];

  it("marks only the repeated line N added, not the one already there", () => {
    const out = chain([r1, r2]);
    expect(out.hunks).toHaveLength(1);
    expect(out.hunks[0]).toMatchObject({
      currentHunkId: "H2",
      status: "fuzzy",
      lines: [4, 5, 6],
      removedCount: 0,
      removedAt: [],
      rewrittenSince: 0,
      exactAtCurrent: true,
    });
  });

  it("follows the lines across a later fuzzy change that shifts them", () => {
    const r3 = [" ctx", "+// note", ...r2.slice(1)];
    const out = chain([r1, r2, r3]);
    expect(out.hunks[0]).toMatchObject({
      currentHunkId: "H3",
      originHunkId: "H2",
      lines: [5, 6, 7],
      rewrittenSince: 0,
      exactAtCurrent: false,
    });
  });

  it("drops a line a later revision rewrote and counts it", () => {
    const r3 = r2.map((l) => (l === "+\treturn err" ? "+\treturn wrap(err)" : l));
    const out = chain([r1, r2, r3]);
    expect(out.hunks[0]).toMatchObject({ lines: [4, 6], rewrittenSince: 1, exactAtCurrent: false });
  });

  it("says which later revision rewrote them", () => {
    const r3 = r2.map((l) => (l === "+\treturn err" ? "+\treturn wrap(err)" : l));
    const r4 = r3.map((l) => (l === "+if b {" ? "+if b != nil {" : l));
    const out = chain([r1, r2, r3, r4]);
    expect(out.hunks[0]).toMatchObject({
      lines: [6],
      rewrittenSince: 2,
      rewrittenBy: [
        { revision: 3, count: 1 },
        { revision: 4, count: 1 },
      ],
    });
    expect(chain([r1, r2]).hunks[0].rewrittenBy).toBeUndefined();
  });

  it("keeps positions through identical steps and stays exact", () => {
    const out = chain([r1, r2, r2, r2], ["fuzzy", "identical", "identical"]);
    expect(out.hunks[0]).toMatchObject({ currentHunkId: "H2", lines: [4, 5, 6], exactAtCurrent: true });
  });

  it("follows the body when an identical id's context lines moved", () => {
    const r3 = [" ctx0", ...r2];
    const out = chain([r1, r2, r3], ["fuzzy", "identical"]);
    expect(out.hunks[0]).toMatchObject({ currentHunkId: "H2", lines: [5, 6, 7], exactAtCurrent: false });
  });

  it("an edit (comment rewrap) marks the new lines and removes nothing", () => {
    const before = [" func f() {", "+\t// holder context is built", "+\t// from the manager", " }"];
    const after = [" func f() {", "+\t// holder context is built from", "+\t// the manager's state", " }"];
    const out = chain([before, after]);
    expect(out.hunks[0]).toMatchObject({ lines: [1, 2], removedCount: 0, removedAt: [] });
  });

  it("an edit with more removals than additions counts no surplus", () => {
    const out = chain([[" a", "+x", "+y", "+z", " b"], [" a", "+xyz", " b"]]);
    expect(out.hunks[0]).toMatchObject({ lines: [1], removedCount: 0, removedAt: [] });
  });

  it("a pure deletion reports its count and where it was", () => {
    const out = chain([[" a", "+x", "+y", "+z", " b"], [" a", "+x", " b"]]);
    expect(out.hunks[0]).toMatchObject({ lines: [], removedCount: 2, removedAt: [{ line: 2, count: 2 }] });
  });

  it("context lines leaving the body (the window shrinking) are not removals", () => {
    const out = chain([[" a", "+x", " b", " c", "+gone"], [" a", "+x", " b"]]);
    expect(out.hunks[0]).toMatchObject({ removedCount: 1, removedAt: [{ line: 3, count: 1 }] });
    const shrunk = chain([[" a", "+x", " b", " c"], [" a", "+X", " b"]]);
    expect(shrunk.hunks[0]).toMatchObject({ lines: [1], removedCount: 0, removedAt: [] });
  });

  it("context lines entering the body (the window growing) are never marked", () => {
    // N edits x and the hunk's window grows by two unchanged context lines.
    const out = chain([[" a", "+x", " b"], [" pre1", " pre2", " a", "+X", " b", " post"]]);
    expect(out.hunks[0]).toMatchObject({ lines: [3], removedCount: 0, removedAt: [] });
    // A block that trades a diff line for context only is a pure deletion.
    const traded = chain([[" a", "+gone", " b"], [" a", " new-ctx", " b"]]);
    expect(traded.hunks[0]).toMatchObject({ lines: [], removedCount: 1 });
  });

  it("a deletion at the end of the hunk anchors past the last line", () => {
    const out = chain([[" a", "+x", "+y"], [" a", "+x"]]);
    expect(out.hunks[0]).toMatchObject({ removedCount: 1, removedAt: [{ line: 2, count: 1 }] });
  });

  it("carries a deletion anchor forward, and drops it (keeping the count) once rewritten", () => {
    const r1d = [" a", "+x", "+y", "+z", " b", "+w"];
    const r2d = [" a", "+x", " b", "+w"];
    const shifted = chain([r1d, r2d, [" a", "+new", "+x", " b", "+w"]]);
    expect(shifted.hunks[0]).toMatchObject({ removedCount: 2, removedAt: [{ line: 3, count: 2 }] });
    const rewritten = chain([r1d, r2d, [" a", "+x", " b changed", "+w"]]);
    expect(rewritten.hunks[0]).toMatchObject({ removedCount: 2, removedAt: [] });
  });

  it("never reports a '\\ No newline' marker as introduced or removed", () => {
    const out = chain([
      [" a", "+x", "\\ No newline at end of file"],
      [" a", "+x", "+y", "\\ No newline at end of file"],
    ]);
    expect(out.hunks[0]).toMatchObject({ lines: [2], removedCount: 0 });
  });

  it("marks every '+' line of a new hunk, by position", () => {
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 2,
      report: R2,
      previousFiles: files(A1, B),
      revisionFiles: files(A2, B, C),
      laterReports: [],
      currentFiles: files(A2, B, C),
    });
    const byId = new Map(out.hunks.map((h) => [h.currentHunkId, h]));
    expect([...byId.keys()].sort()).toEqual(["A2", "C"]);
    expect(byId.get("C")).toMatchObject({ status: "new", lines: [0, 1], removedCount: 0, exactAtCurrent: true });
  });

  it("omits hunks archived later, counting them and naming the unit that held them", () => {
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 3,
      report: R2,
      previousFiles: files(A1, B),
      revisionFiles: files(A2, B, C),
      laterReports: [
        report(3, [same("A2"), same("B", "b.ts"), { status: "archived", hunkId: "C", file: "c.ts" }]),
      ],
      currentFiles: files(A2, B),
      archived: [{ hunkId: "C", file: "c.ts", archivedAtRevision: 3, wasViewed: false, unitId: "u1" }],
    });
    expect(out.hunks.map((h) => h.currentHunkId)).toEqual(["A2"]);
    expect(out.goneCount).toBe(1);
    expect(out.gone[0]).toMatchObject({ originHunkId: "C", lastHunkId: "C", goneAtRevision: 3, unitId: "u1" });
  });

  it("skips renamed hunks whose content did not change, keeps those that did", () => {
    const moved = hunk("M2", "new.ts", [" ctx", "+kept"]);
    const edited = hunk("E2", "new.ts", [" ctx", "+changed"]);
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 2,
      report: report(2, [
        { status: "renamed", hunkId: "M2", previousHunkId: "M1", file: "new.ts", previousFile: "old.ts" },
        { status: "renamed", hunkId: "E2", previousHunkId: "E1", file: "new.ts", previousFile: "old.ts" },
      ]),
      previousFiles: files(hunk("M1", "old.ts", [" ctx", "+kept"]), hunk("E1", "old.ts", [" ctx", "+before"])),
      revisionFiles: files(moved, edited),
      laterReports: [],
    });
    expect(out.hunks.map((h) => h.currentHunkId)).toEqual(["E2"]);
    expect(out.hunks[0]).toMatchObject({ status: "renamed", lines: [1], removedCount: 0 });
  });

  it("treats a missing later report whose bodies are unknown as an uncertain carry-over", () => {
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 3,
      report: R2,
      previousFiles: files(A1, B),
      revisionFiles: files(A2, B, C),
      laterReports: [null],
      currentFiles: undefined,
    });
    expect(out.hunks).toHaveLength(2);
    expect(out.hunks.every((h) => !h.exactAtCurrent && h.uncertain)).toBe(true);
  });

  it("caps a huge new hunk", () => {
    const big = hunk(
      "BIG",
      "big.ts",
      Array.from({ length: MAX_INTRODUCED_LINES + 10 }, (_, i) => `+line ${i}`),
    );
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 2,
      report: report(2, [{ status: "new", hunkId: "BIG", file: "big.ts" }]),
      revisionFiles: files(big),
      laterReports: [],
    });
    expect(out.hunks[0].lines).toHaveLength(MAX_INTRODUCED_LINES);
    expect(out.hunks[0].truncated).toBe(true);
  });
});
