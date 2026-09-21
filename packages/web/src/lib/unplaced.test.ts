import { describe, expect, it } from "vitest";
import type { FileEntry, PrDetail, ReviewUnit } from "../api/types";
import { mockDetail } from "../mocks/fixture";
import { unplacedHunkIds } from "./unplaced";

const file = (path: string, ids: string[]): FileEntry =>
  ({ path, status: "modified", hunks: ids.map((id) => ({ id, file: path })) }) as unknown as FileEntry;

const unit = (id: string, hunkIds: string[], extra: Partial<ReviewUnit> = {}): ReviewUnit =>
  ({ id, hunkIds, ...extra }) as ReviewUnit;

function detailOf(
  files: FileEntry[],
  units: ReviewUnit[],
  removedUnits: ReviewUnit[] = [],
): Pick<PrDetail, "files" | "state"> {
  return {
    files: { files },
    state: { revision: 2, units, removedUnits, hunks: {} },
  };
}

describe("unplacedHunkIds", () => {
  it("is empty when every hunk belongs to a live unit", () => {
    const d = detailOf([file("a.ts", ["h1", "h2"]), file("b.ts", ["h3"])], [
      unit("u1", ["h1", "h3"]),
      unit("u2", ["h2"]),
    ]);
    expect(unplacedHunkIds(d)).toEqual([]);
  });

  it("collects hunks no unit covers — unassigned or simply new — in file order", () => {
    // h2 stands for an explicitly unassigned hunk, h4 for one a refresh added
    // after the last analysis: neither is in any unit's hunkIds.
    const d = detailOf([file("a.ts", ["h1", "h2"]), file("b.ts", ["h3", "h4"])], [
      unit("u1", ["h1", "h3"]),
    ]);
    expect(unplacedHunkIds(d)).toEqual(["h2", "h4"]);
  });

  it("does not let a husk cover anything", () => {
    const d = detailOf(
      [file("a.ts", ["h1", "h2"])],
      [unit("u1", ["h1"])],
      [unit("gone", ["h2"], { removedAtRevision: 2 })],
    );
    expect(unplacedHunkIds(d)).toEqual(["h2"]);
  });

  it("ignores a husk that slipped into the live list", () => {
    const d = detailOf([file("a.ts", ["h1", "h2"])], [
      unit("u1", ["h1"]),
      unit("gone", ["h2"], { removedAtRevision: 2 }),
    ]);
    expect(unplacedHunkIds(d)).toEqual(["h2"]);
  });

  it("ignores unit hunk ids that are not in this revision's files", () => {
    const d = detailOf([file("a.ts", ["h1"])], [unit("u1", ["h1", "stale"])]);
    expect(unplacedHunkIds(d)).toEqual([]);
  });

  it("finds the mock fixture's deliberately unplaced hunk", () => {
    expect(unplacedHunkIds(mockDetail)).toEqual(["a1b2c3d4e5f60004"]);
  });
});
