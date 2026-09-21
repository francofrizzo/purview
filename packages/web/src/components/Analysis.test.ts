import { describe, expect, it } from "vitest";
import { analysisStatsRows, archivedSkipText } from "./Analysis";

describe("analysisStatsRows", () => {
  it("lists known stats and orders tool calls by count", () => {
    expect(
      analysisStatsRows({
        durationMs: 204_000,
        turns: 20,
        costUsd: 1.144,
        usage: { output: 16_900 },
        toolCalls: { Read: 3, Bash: 9, Write: 1 },
        bash: { cli: 0, state: 0, grep: 0, sed: 0, other: 0 },
        reads: { filesJson: 0, diffPatch: 0, skill: 0, checkout: 0, other: 0 },
      }),
    ).toEqual([
      ["Duration", "3.4 min"],
      ["Turns", "20"],
      ["Cost", "$1.14"],
      ["Output tokens", "16.9k"],
      ["Tool calls", "Bash 9 · Read 3 · Write 1"],
    ]);
  });

  it("leaves out what the run did not record", () => {
    expect(
      analysisStatsRows({
        toolCalls: {},
        bash: { cli: 0, state: 0, grep: 0, sed: 0, other: 0 },
        reads: { filesJson: 0, diffPatch: 0, skill: 0, checkout: 0, other: 0 },
      }),
    ).toEqual([]);
  });
});

describe("archivedSkipText", () => {
  it("names the revision and counts the unplaced hunks", () => {
    expect(archivedSkipText(2, 16)).toEqual({
      title: "This PR is archived, so revision 2 wasn't analyzed.",
      detail: "16 hunks aren't in any unit yet.",
    });
    expect(archivedSkipText(3, 1).detail).toBe("1 hunk isn't in any unit yet.");
  });

  it("still explains itself when every hunk is placed (reworked units only)", () => {
    expect(archivedSkipText(4, 0).detail).toBe(
      "Some unit descriptions may not reflect its latest changes.",
    );
  });
});
