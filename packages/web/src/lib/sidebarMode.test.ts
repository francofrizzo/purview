import { describe, expect, it } from "vitest";
import { SIDEBAR_DRAWER_BREAKPOINT, sidebarModeFor } from "./sidebarMode";

describe("sidebarModeFor", () => {
  it("is a drawer below the breakpoint", () => {
    expect(sidebarModeFor(0)).toBe("drawer");
    expect(sidebarModeFor(SIDEBAR_DRAWER_BREAKPOINT - 1)).toBe("drawer");
  });

  it("is a column at or above the breakpoint", () => {
    expect(sidebarModeFor(SIDEBAR_DRAWER_BREAKPOINT)).toBe("column");
    expect(sidebarModeFor(SIDEBAR_DRAWER_BREAKPOINT + 1)).toBe("column");
    expect(sidebarModeFor(2560)).toBe("column");
  });
});
