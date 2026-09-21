import { describe, expect, it } from "vitest";
import type { ReviewUnit } from "../api/types";
import { unitDisplayNumbers, unitDisplayOrder } from "./unitOrder";

function unit(id: string, attention: ReviewUnit["attention"], order: number): ReviewUnit {
  return {
    id,
    title: id,
    summary: "",
    attention,
    order,
    kind: "wiring",
    riskFlags: [],
    hunkIds: [],
    findings: [],
  } as unknown as ReviewUnit;
}

describe("unitDisplayOrder", () => {
  it("groups must-read before skim before skip", () => {
    const units = [unit("skip1", "skip", 1), unit("must1", "must-read", 2), unit("skim1", "skim", 3)];
    expect(unitDisplayOrder(units).map((u) => u.id)).toEqual(["must1", "skim1", "skip1"]);
  });

  it("orders by `order` within a bucket, even though it is gappy across buckets", () => {
    const units = [
      unit("must-b", "must-read", 5),
      unit("must-a", "must-read", 1),
      unit("skim-b", "skim", 8),
      unit("skim-a", "skim", 6),
    ];
    expect(unitDisplayOrder(units).map((u) => u.id)).toEqual([
      "must-a",
      "must-b",
      "skim-a",
      "skim-b",
    ]);
  });

  it("sends an unknown attention to the back rather than the front", () => {
    const units = [
      unit("mystery", "weird" as ReviewUnit["attention"], 0),
      unit("skip1", "skip", 1),
      unit("must1", "must-read", 2),
    ];
    expect(unitDisplayOrder(units).map((u) => u.id)).toEqual(["must1", "skip1", "mystery"]);
  });
});

describe("unitDisplayNumbers", () => {
  it("numbers 1-based in display order, skipping nothing", () => {
    const units = [unit("skip1", "skip", 1), unit("must1", "must-read", 2), unit("skim1", "skim", 3)];
    const numbers = unitDisplayNumbers(units);
    expect(numbers.get("must1")).toBe(1);
    expect(numbers.get("skim1")).toBe(2);
    expect(numbers.get("skip1")).toBe(3);
  });

  it("gives every unit a number, including an unknown-attention one at the end", () => {
    const units = [unit("must1", "must-read", 1), unit("mystery", "weird" as ReviewUnit["attention"], 0)];
    const numbers = unitDisplayNumbers(units);
    expect(numbers.get("must1")).toBe(1);
    expect(numbers.get("mystery")).toBe(2);
  });

  it("returns an empty map for no units", () => {
    expect(unitDisplayNumbers([]).size).toBe(0);
  });
});

describe("husks", () => {
  const husk = (id: string, attention: ReviewUnit["attention"], order: number) =>
    ({ ...unit(id, attention, order), removedAtRevision: 3 }) as ReviewUnit;

  it("leaves husks out of the reading order", () => {
    const units = [unit("must1", "must-read", 1), husk("gone", "must-read", 0), unit("skim1", "skim", 2)];
    expect(unitDisplayOrder(units).map((u) => u.id)).toEqual(["must1", "skim1"]);
  });

  it("numbers live units without gaps and gives husks no number", () => {
    const units = [
      husk("gone", "must-read", 0),
      unit("must1", "must-read", 1),
      husk("gone2", "skim", 2),
      unit("skim1", "skim", 3),
    ];
    const numbers = unitDisplayNumbers(units);
    expect([...numbers]).toEqual([
      ["must1", 1],
      ["skim1", 2],
    ]);
    expect(numbers.has("gone")).toBe(false);
  });
});
