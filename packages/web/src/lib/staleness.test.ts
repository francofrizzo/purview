import { describe, expect, it } from "vitest";
import type { Staleness } from "../api/types";
import {
  STALENESS_POLL_MS,
  stalenessPollInterval,
  stalenessReasonText,
  stalenessTooltip,
} from "./staleness";

const result = (patch: Partial<Staleness> = {}): Staleness => ({
  stale: true,
  reasons: ["new-commits"],
  upstreamHeadSha: "sha-2",
  localHeadSha: "sha-1",
  upstreamState: "open",
  localState: "open",
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("stalenessPollInterval", () => {
  it("polls open and draft PRs on the slow interval", () => {
    expect(stalenessPollInterval("open")).toBe(STALENESS_POLL_MS);
    expect(stalenessPollInterval("draft")).toBe(STALENESS_POLL_MS);
  });

  it("drops the interval for PRs that can no longer grow commits", () => {
    expect(stalenessPollInterval("merged")).toBe(false);
    expect(stalenessPollInterval("closed")).toBe(false);
  });

  it("polls when the state is not known yet", () => {
    expect(stalenessPollInterval(null)).toBe(STALENESS_POLL_MS);
    expect(stalenessPollInterval(undefined)).toBe(STALENESS_POLL_MS);
  });
});

describe("reason wording", () => {
  it("never claims a commit count it cannot know", () => {
    expect(stalenessReasonText(["new-commits"])).toBe("new commits upstream");
    expect(stalenessReasonText(["base-moved"])).toBe("base branch moved");
  });

  it("joins several reasons", () => {
    expect(stalenessReasonText(["new-commits", "base-moved"])).toBe(
      "new commits upstream · base branch moved",
    );
  });

  it("has no tooltip when nothing is stale", () => {
    expect(stalenessTooltip(undefined)).toBeNull();
    expect(stalenessTooltip(result({ stale: false, reasons: [] }))).toBeNull();
    expect(stalenessTooltip(result({ reasons: [] }))).toBeNull();
  });

  it("spells the reasons out in the tooltip", () => {
    expect(stalenessTooltip(result())).toBe("new commits upstream — refresh to fetch the latest");
  });
});
