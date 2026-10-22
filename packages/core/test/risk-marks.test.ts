import { describe, expect, it } from "vitest";
import { HunkEntrySchema, hunkListIssues, type HunkEntry } from "../src/schemas.js";
import { derivedRiskFlags } from "../src/units.js";

describe("hunk risk marks", () => {
  const mark = { flag: "money" as const, why: "A retry can charge twice.", lines: [10, 12] as [number, number] };
  it("validates vocabulary, sentence limits and range shape", () => {
    for (const risks of [[{ ...mark, flag: "other" }], [{ ...mark, why: "" }], [{ ...mark, why: "x".repeat(1000) }], [{ ...mark, lines: [12, 10] }], Array(5).fill(mark)]) {
      expect(HunkEntrySchema.safeParse({ id: "h", risks }).success).toBe(false);
    }
  });
  it("rejects skips, overlapping ranges and mixed whole-hunk marks", () => {
    const bad: HunkEntry[] = [
      { id: "a", skip: true, label: "boilerplate", risks: [mark] },
      { id: "b", risks: [mark, { ...mark, lines: [12, 15] }] },
      { id: "c", risks: [mark, { flag: "auth", why: "Access can leak." }] },
    ];
    expect(hunkListIssues(bad)).toHaveLength(3);
  });
  it("checks known new-side bounds while allowing hearts to overlap risks", () => {
    const hunks = [{ id: "h", risks: [mark], heart: [{ why: "Records the charge.", lines: mark.lines }] }];
    expect(hunkListIssues(hunks)).toEqual([]);
    expect(hunkListIssues(hunks, { bounds: new Map([["h", { newStart: 11, newLines: 2 }]]) })).toHaveLength(1);
    expect(hunkListIssues(hunks, { bounds: new Map([["h", { newStart: 10, newLines: 3 }]]) })).toEqual([]);
  });
  it("derives a unique union, retaining flags only for legacy units", () => {
    expect(derivedRiskFlags({ hunks: [{ id: "h", risks: [mark, { ...mark, flag: "auth" }] }, { id: "j", risks: [mark] }], riskFlags: ["security"] })).toEqual(["money", "auth"]);
    expect(derivedRiskFlags({ hunks: [{ id: "h" }], riskFlags: ["security"] })).toEqual(["security"]);
  });
});
