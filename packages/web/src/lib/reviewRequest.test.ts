import { describe, expect, it } from "vitest";
import {
  REVIEW_REQUEST_OVERDUE_MS,
  formatCompactAge,
  formatRequestedAgo,
  isReviewRequestOverdue,
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

describe("isReviewRequestOverdue", () => {
  it("flips at exactly three days", () => {
    expect(REVIEW_REQUEST_OVERDUE_MS).toBe(3 * DAY);
    expect(isReviewRequestOverdue(ago(3 * DAY - 1), NOW)).toBe(false);
    expect(isReviewRequestOverdue(ago(3 * DAY), NOW)).toBe(true);
    expect(isReviewRequestOverdue(ago(10 * DAY), NOW)).toBe(true);
    expect(isReviewRequestOverdue(ago(-HOUR), NOW)).toBe(false);
    expect(isReviewRequestOverdue("nope", NOW)).toBe(false);
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
