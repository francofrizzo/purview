import { describe, expect, it } from "vitest";
import type { FileEntry } from "../api/types";
import { changedLines, reviewProgressByAttention, reviewProgressByKind } from "./reviewProgress";

const hunk = (id: string, changed: number) => ({ id, lines: [" ctx", ...Array.from({ length: changed }, () => "+x")] });

describe("reviewProgressByAttention", () => {
  const files = [
    { hunks: [hunk("a", 10), hunk("b", 30)] },
    { hunks: [hunk("c", 20), hunk("d", 5)] },
    { generated: { source: "lockfile" as const }, hunks: [hunk("g", 500)] },
  ];
  const units = [
    { id: "u1", attention: "must-read" as const, hunks: [{ id: "a" }, { id: "b" }] },
    { id: "u2", attention: "skip" as const, hunks: [{ id: "c" }] },
    { id: "gen", attention: "skip" as const, hunks: [{ id: "g" }], origin: "generated" as const },
  ];

  it("weighs by changed lines, files hunks by their unit's attention, an unclaimed hunk as skim, and leaves generated files out", () => {
    const p = reviewProgressByAttention(files, { a: { viewed: true, changedSinceViewed: false } }, units);
    const [must, skim, skip] = p.groups;
    expect(must).toMatchObject({ lines: 40, read: 10, hunks: 2, hunksRead: 1, units: 1, unitsDone: 0 });
    expect(skim).toMatchObject({ lines: 5, read: 0, units: 0 });
    expect(skip).toMatchObject({ lines: 20, read: 0 });
    // Skip is never owed: 10 of the 45 must-read and skim lines.
    expect(p.percent).toBe(22);
    expect(p.done).toBe(false);
  });

  it("is done, at 100%, once every must-read and skim hunk is read, skip or not", () => {
    const read = { viewed: true, changedSinceViewed: false };
    const p = reviewProgressByAttention(files, { a: read, b: read, d: read }, units);
    expect(p.done).toBe(true);
    expect(p.percent).toBe(100);
    expect(p.groups[0].unitsDone).toBe(1);
  });

  it("counts a hunk a new revision changed after it was read as to read again", () => {
    const p = reviewProgressByAttention(files, { b: { viewed: false, changedSinceViewed: true } }, units);
    expect(p.groups[0]).toMatchObject({ read: 0, reread: 30 });
  });

  it("never rounds up to 100% before it is done", () => {
    const big = [{ hunks: [hunk("x", 999), hunk("y", 1)] }];
    const p = reviewProgressByAttention(big, { x: { viewed: true, changedSinceViewed: false } }, [
      { id: "u", attention: "must-read", hunks: [{ id: "x" }, { id: "y" }] },
    ]);
    expect(p.percent).toBe(99);
  });
});

it("a hunk its unit marks skip counts nowhere: nothing ever marks it read", () => {
  const p = reviewProgressByAttention([{ hunks: [hunk("a", 4), hunk("b", 6)] }], { a: { viewed: true, changedSinceViewed: false } }, [
    { id: "u", attention: "must-read", hunks: [{ id: "a" }, { id: "b", skip: true }] },
  ]);
  expect(p.groups[0]).toMatchObject({ lines: 4, unitsDone: 1 });
  expect(p.groups[2]).toMatchObject({ lines: 0 });
  expect(p.groups[1]).toMatchObject({ lines: 0 });
  expect(p.done).toBe(true);
});

it("changedLines counts + and - lines", () => {
  expect(changedLines({ lines: [" a", "+b", "-c", "+d"] })).toBe(3);
});

describe("reviewProgressByKind", () => {
  const file = (path: string, hunks: ReturnType<typeof hunk>[], generated?: boolean) =>
    ({ path, status: "modified", hunks: hunks.map((h) => ({ ...h, file: path, header: "@@ -1 +1 @@" })), ...(generated ? { generated: { source: "lockfile" } } : {}) }) as unknown as FileEntry;

  it("splits the lines by what they are, generated shown, skipped hunks nowhere, in mix order", () => {
    const files = [
      file("src/a.ts", [hunk("a", 10), hunk("s", 3)]),
      file("src/a.test.ts", [hunk("t", 20)]),
      file("README.md", [hunk("d", 5)]),
      file("pnpm-lock.yaml", [hunk("g", 50)], true),
    ];
    const units = [{ id: "u1", hunks: [{ id: "a" }, { id: "t" }, { id: "d" }, { id: "s", skip: true as const }] }];
    const groups = reviewProgressByKind(files, { t: { viewed: true, changedSinceViewed: false } }, units);
    expect(groups.map((g) => g.kind)).toEqual(["implementation", "tests", "docs", "generated"]);
    expect(groups[0]).toMatchObject({ lines: 10, read: 0, hunks: 1 });
    expect(groups[0].unread).toEqual([{ id: "a", path: "src/a.ts" }]);
    expect(groups[1]).toMatchObject({ lines: 20, read: 20, hunksRead: 1, unread: [] });
    expect(groups[3]).toMatchObject({ lines: 50 });
  });
});
