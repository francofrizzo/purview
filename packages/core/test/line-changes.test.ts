import { describe, expect, it } from "vitest";
import {
  MAX_INTRODUCED_LINES,
  bodyLineDelta,
  computeRevisionLineChanges,
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

describe("bodyLineDelta", () => {
  it("keeps prefixes and counts duplicates as a multiset", () => {
    const d = bodyLineDelta(A1, A2);
    expect(d.introduced.sort()).toEqual(["+  }", "+second"].sort());
    expect(d.dropped).toEqual([]);
  });

  it("reports dropped lines", () => {
    const d = bodyLineDelta(A2, A1);
    expect(d.introduced).toEqual([]);
    expect(d.dropped).toHaveLength(2);
  });
});

describe("computeRevisionLineChanges", () => {
  it("reports N's reworked and new hunks, exact when nothing later touched them", () => {
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 2,
      report: R2,
      previousFiles: files(A1, B),
      revisionFiles: files(A2, B, C),
      laterReports: [],
      currentFiles: files(A2, B, C),
    });
    expect(out.goneCount).toBe(0);
    const byId = new Map(out.hunks.map((h) => [h.currentHunkId, h]));
    expect([...byId.keys()].sort()).toEqual(["A2", "C"]);
    expect(byId.get("A2")).toMatchObject({ status: "fuzzy", droppedCount: 0, exactAtCurrent: true });
    expect(byId.get("A2")!.introduced.filter((l) => l === "+  }")).toHaveLength(1);
    // new hunks: every '+' line, no context, nothing dropped
    expect(byId.get("C")).toMatchObject({
      status: "new",
      introduced: ["+new one", "+new two"],
      droppedCount: 0,
    });
  });

  it("maps forward across identical and fuzzy steps, keyed by the current id", () => {
    const A3 = hunk("A3", "a.ts", [" ctx", "-old", "+first", "+second", "+  }", "+  }", "+third", " tail"]);
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 4,
      report: R2,
      previousFiles: files(A1, B),
      revisionFiles: files(A2, B, C),
      laterReports: [
        report(3, [same("A2"), same("B", "b.ts"), same("C", "c.ts")]),
        report(4, [fuzzy("A2", "A3"), same("B", "b.ts"), same("C", "c.ts")]),
      ],
      currentFiles: files(A3, B, C),
    });
    const byId = new Map(out.hunks.map((h) => [h.currentHunkId, h]));
    expect(byId.get("A3")).toMatchObject({ originHunkId: "A2", exactAtCurrent: false });
    expect(byId.get("C")).toMatchObject({ originHunkId: "C", exactAtCurrent: true });
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
    expect(out.hunks[0]).toMatchObject({ status: "renamed", introduced: ["+changed"], droppedCount: 1 });
  });

  it("treats a missing later report as a carry-over that is no longer exact", () => {
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 3,
      report: R2,
      previousFiles: files(A1, B),
      revisionFiles: files(A2, B, C),
      laterReports: [null],
      currentFiles: files(A2, B, C),
    });
    expect(out.hunks.every((h) => !h.exactAtCurrent)).toBe(true);
    expect(out.hunks).toHaveLength(2);
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
    expect(out.hunks[0].introduced).toHaveLength(MAX_INTRODUCED_LINES);
    expect(out.hunks[0].truncated).toBe(true);
  });
});
