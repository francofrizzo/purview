import { describe, expect, it } from "vitest";
import {
  EMPTY_COLLAPSED,
  isCollapsed,
  pruneCollapsed,
  reconcileViewed,
  setCollapsed,
  toggleCollapsed,
  viewedSnapshot,
} from "./hunkCollapse";

describe("manual folding", () => {
  it("toggles a hunk in and out of the folded set", () => {
    const once = toggleCollapsed(EMPTY_COLLAPSED, "h1");
    expect(isCollapsed(once, "h1")).toBe(true);
    expect(isCollapsed(toggleCollapsed(once, "h1"), "h1")).toBe(false);
  });

  it("leaves other hunks alone", () => {
    const state = toggleCollapsed(toggleCollapsed(EMPTY_COLLAPSED, "h1"), "h2");
    expect(isCollapsed(state, "h1")).toBe(true);
    expect(isCollapsed(state, "h2")).toBe(true);
    expect(isCollapsed(state, "h3")).toBe(false);
  });

  it("setCollapsed is a no-op — same object — when nothing would change", () => {
    const state = toggleCollapsed(EMPTY_COLLAPSED, "h1");
    expect(setCollapsed(state, "h1", true)).toBe(state);
    expect(setCollapsed(state, "h1", false)).not.toBe(state);
  });
});

describe("auto-collapse on viewed", () => {
  it("folds a hunk that was just marked viewed", () => {
    const next = reconcileViewed(EMPTY_COLLAPSED, { h1: false }, { h1: true }, true);
    expect(isCollapsed(next, "h1")).toBe(true);
  });

  it("unfolds a hunk that was just un-viewed", () => {
    const folded = toggleCollapsed(EMPTY_COLLAPSED, "h1");
    const next = reconcileViewed(folded, { h1: true }, { h1: false }, true);
    expect(isCollapsed(next, "h1")).toBe(false);
  });

  it("does nothing at all when the setting is off", () => {
    const next = reconcileViewed(EMPTY_COLLAPSED, { h1: false }, { h1: true }, false);
    expect(next).toBe(EMPTY_COLLAPSED);
    expect(isCollapsed(next, "h1")).toBe(false);
  });

  it("acts on changes, not on the flag — a manual unfold survives", () => {
    // Viewed and folded, then unfolded by hand. Nothing about `viewed` moves,
    // so the next reconcile must not re-fold it.
    const unfolded = setCollapsed({ h1: true }, "h1", false);
    const next = reconcileViewed(unfolded, { h1: true }, { h1: true }, true);
    expect(next).toBe(unfolded);
    expect(isCollapsed(next, "h1")).toBe(false);
  });

  it("takes over again the moment the viewed state does move", () => {
    const unfolded = setCollapsed({ h1: true }, "h1", false);
    const off = reconcileViewed(unfolded, { h1: true }, { h1: false }, true);
    const on = reconcileViewed(off, { h1: false }, { h1: true }, true);
    expect(isCollapsed(on, "h1")).toBe(true);
  });

  it("handles a whole unit being ticked at once", () => {
    const next = reconcileViewed(
      EMPTY_COLLAPSED,
      { h1: false, h2: false, h3: true },
      { h1: true, h2: true, h3: true },
      true,
    );
    expect(isCollapsed(next, "h1")).toBe(true);
    expect(isCollapsed(next, "h2")).toBe(true);
    // h3 did not change, so it keeps whatever it had (nothing).
    expect(isCollapsed(next, "h3")).toBe(false);
  });

  it("returns the same object when there is nothing to do", () => {
    const state = { h1: true };
    expect(reconcileViewed(state, { h1: true }, { h1: true }, true)).toBe(state);
  });

  it("does not re-fold a hunk that is already folded", () => {
    const state = { h1: true };
    expect(reconcileViewed(state, { h1: false }, { h1: true }, true)).toBe(state);
  });
});

describe("snapshots and pruning", () => {
  it("reduces hunk state to plain booleans", () => {
    expect(
      viewedSnapshot({ h1: { viewed: true }, h2: { viewed: false }, h3: undefined }),
    ).toEqual({ h1: true, h2: false, h3: false });
  });

  it("drops hunks that left the shown set", () => {
    expect(pruneCollapsed({ h1: true, h2: true }, ["h1"])).toEqual({ h1: true });
  });

  it("keeps the same object when everything is still live", () => {
    const state = { h1: true, h2: false };
    expect(pruneCollapsed(state, ["h1", "h2", "h3"])).toBe(state);
  });
});
