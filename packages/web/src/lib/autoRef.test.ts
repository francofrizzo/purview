import { describe, expect, it } from "vitest";
import type { ChatRef } from "../api/types";
import { autoRef, autoRefReducer, effectiveRefs, initialAutoRefState, isAutoRef, type AutoRefState } from "./autoRef";

const hunkRef: ChatRef = { kind: "hunk", id: "h1" };

describe("autoRefReducer", () => {
  it("starts with no unit in context and not suppressed", () => {
    expect(initialAutoRefState).toEqual({ selectedUnitId: null, suppressed: false });
  });

  it("tracks unit selection", () => {
    const next = autoRefReducer(initialAutoRefState, { type: "select-unit", unitId: "u1" });
    expect(next).toEqual({ selectedUnitId: "u1", suppressed: false });
  });

  it("is a no-op when the selection does not change", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: true };
    const next = autoRefReducer(state, { type: "select-unit", unitId: "u1" });
    expect(next).toBe(state);
  });

  it("lifts suppression on a unit switch, even to a different unit", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: true };
    expect(autoRefReducer(state, { type: "select-unit", unitId: "u2" })).toEqual({
      selectedUnitId: "u2",
      suppressed: false,
    });
  });

  it("leaving the units tab (unitId: null) also lifts suppression", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: true };
    expect(autoRefReducer(state, { type: "select-unit", unitId: null })).toEqual({
      selectedUnitId: null,
      suppressed: false,
    });
  });

  it("remove-auto suppresses", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: false };
    expect(autoRefReducer(state, { type: "remove-auto" })).toEqual({
      selectedUnitId: "u1",
      suppressed: true,
    });
  });

  it("remove-auto is idempotent", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: true };
    expect(autoRefReducer(state, { type: "remove-auto" })).toBe(state);
  });

  it("panel-opened lifts suppression", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: true };
    expect(autoRefReducer(state, { type: "panel-opened" })).toEqual({
      selectedUnitId: "u1",
      suppressed: false,
    });
  });

  it("panel-opened is a no-op when not suppressed", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: false };
    expect(autoRefReducer(state, { type: "panel-opened" })).toBe(state);
  });

  it("reset drops unit context and dismissal (e.g. switching PR)", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: true };
    expect(autoRefReducer(state, { type: "reset" })).toEqual(initialAutoRefState);
  });

  it("reset is a no-op from the initial state", () => {
    expect(autoRefReducer(initialAutoRefState, { type: "reset" })).toBe(initialAutoRefState);
  });
});

describe("autoRef", () => {
  it("points at the selected unit", () => {
    expect(autoRef({ selectedUnitId: "u1", suppressed: false })).toEqual({ kind: "unit", id: "u1" });
  });

  it("is null with no unit in context", () => {
    expect(autoRef({ selectedUnitId: null, suppressed: false })).toBeNull();
  });
});

describe("effectiveRefs", () => {
  it("falls back to the auto ref when nothing is explicitly staged", () => {
    expect(effectiveRefs([], { selectedUnitId: "u1", suppressed: false })).toEqual([
      { kind: "unit", id: "u1" },
    ]);
  });

  it("explicit refs win outright, even a single one", () => {
    expect(effectiveRefs([hunkRef], { selectedUnitId: "u1", suppressed: false })).toEqual([hunkRef]);
  });

  it("is empty once the auto chip is suppressed", () => {
    expect(effectiveRefs([], { selectedUnitId: "u1", suppressed: true })).toEqual([]);
  });

  it("is empty with no unit in context (files tab)", () => {
    expect(effectiveRefs([], { selectedUnitId: null, suppressed: false })).toEqual([]);
  });

  it("the auto chip returns once the last explicit ref is removed, unless suppressed", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: false };
    expect(effectiveRefs([hunkRef], state)).toEqual([hunkRef]);
    expect(effectiveRefs([], state)).toEqual([{ kind: "unit", id: "u1" }]);
  });
});

describe("isAutoRef", () => {
  it("is true for the auto ref when nothing explicit is staged and not suppressed", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: false };
    expect(isAutoRef({ kind: "unit", id: "u1" }, [], state)).toBe(true);
  });

  it("is false once anything explicit is staged", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: false };
    expect(isAutoRef({ kind: "unit", id: "u1" }, [hunkRef], state)).toBe(false);
  });

  it("is false when suppressed", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: true };
    expect(isAutoRef({ kind: "unit", id: "u1" }, [], state)).toBe(false);
  });

  it("is false for a ref that isn't the current auto pointer", () => {
    const state: AutoRefState = { selectedUnitId: "u1", suppressed: false };
    expect(isAutoRef({ kind: "unit", id: "u2" }, [], state)).toBe(false);
  });
});
