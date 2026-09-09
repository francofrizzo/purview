import { describe, expect, it } from "vitest";
import { mergeStickyIntoRange, stickyHeadersFor } from "./stickyHeaders";

// Row layout used throughout:
//   0 file  1 hunk  2..9 lines  10 hunk  11..19 lines  20 file  21 hunk  22.. lines
const FILES = [0, 20];
const HUNKS = [1, 10, 21];

describe("stickyHeadersFor", () => {
  it("picks the governing file and hunk mid-file", () => {
    expect(stickyHeadersFor(FILES, HUNKS, 15)).toEqual({ file: 0, hunk: 10 });
  });

  it("returns the header row itself at an exact boundary", () => {
    expect(stickyHeadersFor(FILES, HUNKS, 10)).toEqual({ file: 0, hunk: 10 });
    expect(stickyHeadersFor(FILES, HUNKS, 20)).toEqual({ file: 20, hunk: undefined });
  });

  it("drops the hunk when it belongs to the previous file", () => {
    // startIndex 20 = the second file's header; the last hunk at/above (10)
    // belongs to the first file and must not stick.
    expect(stickyHeadersFor(FILES, HUNKS, 20).hunk).toBeUndefined();
  });

  it("works without file rows (unit view hides them)", () => {
    expect(stickyHeadersFor([], HUNKS, 15)).toEqual({ file: undefined, hunk: 10 });
  });

  it("finds nothing above the first header", () => {
    expect(stickyHeadersFor([5], [6], 3)).toEqual({ file: undefined, hunk: undefined });
  });

  it("handles empty row sets", () => {
    expect(stickyHeadersFor([], [], 0)).toEqual({ file: undefined, hunk: undefined });
  });
});

describe("mergeStickyIntoRange", () => {
  it("prepends sticky indexes, sorted and de-duplicated", () => {
    expect(mergeStickyIntoRange({ file: 0, hunk: 10 }, [14, 15, 16])).toEqual([0, 10, 14, 15, 16]);
    // already-visible sticky rows are not duplicated
    expect(mergeStickyIntoRange({ file: 0, hunk: 10 }, [10, 11])).toEqual([0, 10, 11]);
  });

  it("passes the visible range through when nothing sticks", () => {
    expect(mergeStickyIntoRange({}, [3, 4])).toEqual([3, 4]);
  });
});
