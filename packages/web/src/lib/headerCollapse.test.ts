import { describe, expect, it } from "vitest";
import { COLLAPSE_PAST, EXPAND_UNDER, nextHeaderCollapsed } from "./headerCollapse";

const viewport = { clientHeight: 600, collapsedDelta: 180 };

describe("nextHeaderCollapsed", () => {
  it("collapses long content once past the threshold", () => {
    const s = { ...viewport, scrollHeight: 5000, collapsed: false };
    expect(nextHeaderCollapsed({ ...s, scrollTop: COLLAPSE_PAST })).toBe(false);
    expect(nextHeaderCollapsed({ ...s, scrollTop: COLLAPSE_PAST + 1 })).toBe(true);
    expect(nextHeaderCollapsed({ ...s, scrollTop: 3000 })).toBe(true);
  });

  it("keeps the header when content is only slightly taller than the viewport", () => {
    // 200px of range with the header open; collapsing it takes 180 of them,
    // so scrollTop would be clamped to 20 — back under the collapse point.
    const s = { ...viewport, scrollHeight: 800, collapsed: false };
    expect(nextHeaderCollapsed({ ...s, scrollTop: 60 })).toBe(false);
    expect(nextHeaderCollapsed({ ...s, scrollTop: 200 })).toBe(false);
  });

  it("does not oscillate across the collapse the loop case would trigger", () => {
    // Walk the feedback loop by hand: the reader is at the bottom, the header
    // decides, the scroller's range changes accordingly, scrollTop clamps,
    // and the header decides again. It must settle on its first answer.
    for (const scrollHeight of [650, 700, 800, 820, 821, 900, 1200]) {
      let collapsed = false;
      let range = scrollHeight - viewport.clientHeight;
      let scrollTop = range;
      const seen: boolean[] = [];
      for (let i = 0; i < 6; i++) {
        const next = nextHeaderCollapsed({ ...viewport, scrollTop, scrollHeight, collapsed });
        if (next !== collapsed) {
          // The header's height moves between the scroller's viewport and
          // (in reverse) back; content height itself is unchanged.
          range += next ? -viewport.collapsedDelta : viewport.collapsedDelta;
          collapsed = next;
        }
        scrollTop = Math.min(scrollTop, Math.max(0, range));
        seen.push(collapsed);
      }
      expect(new Set(seen.slice(1)).size, `scrollHeight ${scrollHeight}`).toBe(1);
    }
  });

  it("collapses when the range left after collapsing still clears the threshold", () => {
    const s = { ...viewport, collapsed: false, scrollTop: 100 };
    const edge = viewport.clientHeight + viewport.collapsedDelta + COLLAPSE_PAST;
    expect(nextHeaderCollapsed({ ...s, scrollHeight: edge })).toBe(false);
    expect(nextHeaderCollapsed({ ...s, scrollHeight: edge + 1 })).toBe(true);
  });

  it("stays collapsed in the hysteresis band and expands only near the top", () => {
    const s = { ...viewport, scrollHeight: 5000, collapsed: true };
    expect(nextHeaderCollapsed({ ...s, scrollTop: COLLAPSE_PAST })).toBe(true);
    expect(nextHeaderCollapsed({ ...s, scrollTop: EXPAND_UNDER + 1 })).toBe(true);
    expect(nextHeaderCollapsed({ ...s, scrollTop: EXPAND_UNDER })).toBe(false);
    expect(nextHeaderCollapsed({ ...s, scrollTop: 0 })).toBe(false);
  });

  it("stays expanded in the hysteresis band", () => {
    const s = { ...viewport, scrollHeight: 5000, collapsed: false };
    expect(nextHeaderCollapsed({ ...s, scrollTop: EXPAND_UNDER + 1 })).toBe(false);
    expect(nextHeaderCollapsed({ ...s, scrollTop: COLLAPSE_PAST })).toBe(false);
  });

  it("never collapses content that does not scroll", () => {
    const s = { ...viewport, scrollHeight: 600, collapsed: false, scrollTop: 0 };
    expect(nextHeaderCollapsed(s)).toBe(false);
    expect(nextHeaderCollapsed({ ...s, collapsedDelta: 0, scrollHeight: 400 })).toBe(false);
  });

  it("treats a negative delta as zero", () => {
    const s = { ...viewport, scrollHeight: 700, collapsed: false, scrollTop: 60 };
    expect(nextHeaderCollapsed({ ...s, collapsedDelta: -500 })).toBe(true);
  });
});
