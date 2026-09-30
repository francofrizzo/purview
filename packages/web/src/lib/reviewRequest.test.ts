import { describe, expect, it } from "vitest";
import {
  formatCompactAge,
  formatRequestedAgo,
  requestAgeLevel,
  reviewRequestTooltip,
  reviewRequestVia,
  visibleReviewRequest,
} from "./reviewRequest";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("formatCompactAge", () => {
  it.each([
    [0, "just now"],
    [59_999, "just now"],
    [-5 * MINUTE, "just now"],
    [MINUTE, "1m"],
    [59 * MINUTE, "59m"],
    [HOUR, "1h"],
    [23 * HOUR + 59 * MINUTE, "23h"],
    [DAY, "1d"],
    [3 * DAY, "3d"],
    [14 * DAY - 1, "13d"],
    [14 * DAY, "2w"],
    [20 * DAY, "2w"],
    [21 * DAY, "3w"],
    [70 * DAY, "10w"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatCompactAge(ms)).toBe(expected);
  });

  it("treats NaN as just now", () => {
    expect(formatCompactAge(Number.NaN)).toBe("just now");
  });
});

describe("formatRequestedAgo", () => {
  it("phrases the age", () => {
    expect(formatRequestedAgo(ago(3 * DAY + HOUR), NOW)).toBe("asked you 3d ago");
    expect(formatRequestedAgo(ago(20 * MINUTE), NOW)).toBe("asked you 20m ago");
    expect(formatRequestedAgo(ago(10_000), NOW)).toBe("asked you just now");
    expect(formatRequestedAgo(ago(15 * DAY), NOW)).toBe("asked you 2w ago");
    expect(formatRequestedAgo(ago(3 * DAY), NOW, "team:backend")).toBe("asked your team 3d ago");
  });

  it("is empty for a bad stamp", () => {
    expect(formatRequestedAgo("nope", NOW)).toBe("");
  });
});

describe("requestAgeLevel", () => {
  const T = [1, 3, 7];
  it("climbs one level per threshold reached", () => {
    expect(requestAgeLevel(ago(DAY - 1), NOW, T)).toBe(0);
    expect(requestAgeLevel(ago(DAY), NOW, T)).toBe(1);
    expect(requestAgeLevel(ago(3 * DAY - 1), NOW, T)).toBe(1);
    expect(requestAgeLevel(ago(3 * DAY), NOW, T)).toBe(2);
    expect(requestAgeLevel(ago(7 * DAY), NOW, T)).toBe(3);
    expect(requestAgeLevel(ago(30 * DAY), NOW, T)).toBe(3);
  });

  it("is 0 for a future or unparseable stamp", () => {
    expect(requestAgeLevel(ago(-HOUR), NOW, T)).toBe(0);
    expect(requestAgeLevel("nope", NOW, T)).toBe(0);
  });

  it("takes the highest level reached even when thresholds are out of order", () => {
    expect(requestAgeLevel(ago(4 * DAY), NOW, [5, 3, 7])).toBe(2);
  });
});

describe("tooltip and via", () => {
  it("names direct and team requests", () => {
    expect(reviewRequestVia("you")).toBe("directly");
    expect(reviewRequestVia("team:backend")).toBe("via team backend");
  });

  it("carries who and how", () => {
    const t = reviewRequestTooltip({ at: ago(DAY), by: "alice", via: "team:backend" });
    expect(t).toMatch(/^Review requested .+ by alice, via team backend$/);
    expect(reviewRequestTooltip({ at: ago(DAY), by: "", via: "you" })).toMatch(
      /^Review requested .+, directly$/,
    );
  });
});

describe("visibleReviewRequest", () => {
  const rr = { at: ago(DAY), by: "alice", via: "you" };
  it("hides absent, null, merged, closed and unparseable", () => {
    expect(visibleReviewRequest(undefined, "open")).toBeNull();
    expect(visibleReviewRequest(null, "open")).toBeNull();
    expect(visibleReviewRequest(rr, "merged")).toBeNull();
    expect(visibleReviewRequest(rr, "closed")).toBeNull();
    expect(visibleReviewRequest({ ...rr, at: "nope" }, "open")).toBeNull();
  });
  it("shows it on open, draft or unknown-state PRs", () => {
    expect(visibleReviewRequest(rr, "open")).toBe(rr);
    expect(visibleReviewRequest(rr, "draft")).toBe(rr);
    expect(visibleReviewRequest(rr, undefined)).toBe(rr);
  });
});
