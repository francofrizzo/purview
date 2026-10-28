import { describe, expect, it } from "vitest";
import { HunkEntrySchema, hunkListIssues, type HunkEntry } from "../src/schemas.js";
import { derivedRiskFlags } from "../src/units.js";

describe("hunk signals", () => {
  const mark = { flag: "money" as const, why: "A retry can charge twice.", lines: [10, 12] as [number, number] };
  it("validates vocabulary, sentence limits and range shape", () => {
    for (const signals of [[], [{ ...mark, flag: "other" }], [{ ...mark, why: "" }], [{ ...mark, why: "x".repeat(1000) }], [{ ...mark, lines: [12, 10] }], [{ ...mark, lines: [0, 1] }], Array(5).fill(mark)]) {
      expect(HunkEntrySchema.safeParse({ id: "h", signals }).success).toBe(false);
    }
    for (const flag of ["auth", "migration", "concurrency", "money", "external-call", "security", "abstraction", "duplication", "defensive-code", "convention-drift", "intent-drift", "test-gap"]) {
      expect(HunkEntrySchema.safeParse({ id: "h", signals: [{ ...mark, flag }] }).success).toBe(true);
    }
    expect(HunkEntrySchema.safeParse({ id: "h", signals: Array(4).fill(mark) }).success).toBe(true);
  });
  it("rejects signals on skips but permits overlapping and mixed whole-hunk lenses", () => {
    expect(hunkListIssues([{ id: "a", skip: true, label: "boilerplate", signals: [mark] }])).toHaveLength(1);
    const hunks: HunkEntry[] = [
      { id: "b", signals: [mark, { ...mark, flag: "duplication", lines: [12, 15] }] },
      { id: "c", signals: [mark, { flag: "test-gap", why: "Retries have no coverage." }] },
    ];
    expect(hunkListIssues(hunks)).toEqual([]);
  });
  it("checks every range's new-side bounds while allowing hearts to overlap signals", () => {
    const hunks: HunkEntry[] = [{ id: "h", signals: [mark, { ...mark, flag: "duplication", lines: [12, 13] }, { flag: "test-gap", why: "No retry coverage." }], heart: [{ why: "Records the charge.", lines: mark.lines }] }];
    expect(hunkListIssues(hunks)).toEqual([]);
    expect(hunkListIssues(hunks, { bounds: new Map([["h", { newStart: 11, newLines: 2 }]]) })).toHaveLength(1);
    expect(hunkListIssues(hunks, { bounds: new Map([["h", { newStart: 10, newLines: 3 }]]) })).toHaveLength(1);
    expect(hunkListIssues(hunks, { bounds: new Map([["h", { newStart: 10, newLines: 4 }]]) })).toEqual([]);
  });
  it("derives a unique union, retaining flags only for legacy units", () => {
    expect(derivedRiskFlags({ hunks: [{ id: "h", signals: [mark, { ...mark, flag: "auth" }, { ...mark, flag: "abstraction" }] }, { id: "j", signals: [mark] }], riskFlags: ["security"] })).toEqual(["money", "auth"]);
    expect(derivedRiskFlags({ hunks: [{ id: "h", signals: [{ ...mark, flag: "test-gap" }] }], riskFlags: ["security"] })).toEqual([]);
    expect(derivedRiskFlags({ hunks: [{ id: "h" }], riskFlags: ["security"] })).toEqual(["security"]);
  });
});
