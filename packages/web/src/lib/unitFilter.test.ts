import { describe, expect, it } from "vitest";
import { filterUnits, hiddenHint } from "./unitFilter";

const units = [{ id: "a" }, { id: "b" }, { id: "c" }];
/** b and c are done; a still has unviewed hunks. */
const isFullyViewed = (u: { id: string }) => u.id !== "a";

describe("filterUnits", () => {
  it("shows everything, and hides nothing, when the toggle is off", () => {
    const out = filterUnits(units, { hide: false, isFullyViewed, selectedId: null });
    expect(out.shown).toBe(units);
    expect(out.hidden).toBe(0);
  });

  it("drops fully-viewed units when the toggle is on", () => {
    const out = filterUnits(units, { hide: true, isFullyViewed, selectedId: null });
    expect(out.shown.map((u) => u.id)).toEqual(["a"]);
    expect(out.hidden).toBe(2);
  });

  it("keeps the selected unit visible even once it is fully viewed", () => {
    const out = filterUnits(units, { hide: true, isFullyViewed, selectedId: "b" });
    expect(out.shown.map((u) => u.id)).toEqual(["a", "b"]);
    expect(out.hidden).toBe(1);
  });

  it("does not double-count a selected unit that was never hideable", () => {
    const out = filterUnits(units, { hide: true, isFullyViewed, selectedId: "a" });
    expect(out.shown.map((u) => u.id)).toEqual(["a"]);
    expect(out.hidden).toBe(2);
  });

  it("can hide a whole group", () => {
    const out = filterUnits([{ id: "b" }, { id: "c" }], {
      hide: true,
      isFullyViewed,
      selectedId: null,
    });
    expect(out.shown).toEqual([]);
    expect(out.hidden).toBe(2);
  });

  it("preserves the incoming order of what survives", () => {
    const many = [{ id: "a" }, { id: "b" }, { id: "a2" }];
    const out = filterUnits(many, {
      hide: true,
      isFullyViewed: (u) => u.id === "b",
      selectedId: null,
    });
    expect(out.shown.map((u) => u.id)).toEqual(["a", "a2"]);
  });

  it("handles an empty group", () => {
    expect(filterUnits([], { hide: true, isFullyViewed, selectedId: null })).toEqual({
      shown: [],
      hidden: 0,
    });
  });
});

describe("hiddenHint", () => {
  it("says nothing when nothing is hidden", () => {
    expect(hiddenHint(0)).toBe("");
  });

  it("reports the count otherwise", () => {
    expect(hiddenHint(1)).toBe("(1 hidden)");
    expect(hiddenHint(7)).toBe("(7 hidden)");
  });
});
