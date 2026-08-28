import { describe, expect, it } from "vitest";
import type { Staleness } from "../api/types";
import {
  STALENESS_POLL_MS,
  shouldShowStalenessHint,
  stalenessDismissKey,
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
    expect(stalenessReasonText(["state-changed"])).toBe("PR state changed");
  });

  it("joins several reasons", () => {
    expect(stalenessReasonText(["new-commits", "state-changed"])).toBe(
      "new commits upstream · PR state changed",
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

describe("hint dismissal", () => {
  it("shows the bar for a fresh stale result", () => {
    expect(shouldShowStalenessHint(result(), null)).toBe(true);
  });

  it("stays hidden for the same upstream head sha", () => {
    const first = result();
    const key = stalenessDismissKey(first);
    expect(shouldShowStalenessHint(first, key)).toBe(false);
    // A later check that reports the same upstream revision is not distinct,
    // even though it is a different response object.
    expect(shouldShowStalenessHint(result({ checkedAt: "2026-01-01T00:05:00Z" }), key)).toBe(false);
  });

  it("comes back once upstream moves again", () => {
    const key = stalenessDismissKey(result());
    expect(shouldShowStalenessHint(result({ upstreamHeadSha: "sha-3" }), key)).toBe(true);
  });

  it("keys a reason-only change on the same sha, so a dismiss holds", () => {
    const key = stalenessDismissKey(result());
    expect(shouldShowStalenessHint(result({ reasons: ["base-moved"] }), key)).toBe(false);
  });

  it("never shows the bar for a non-stale or missing result", () => {
    expect(shouldShowStalenessHint(undefined, null)).toBe(false);
    expect(shouldShowStalenessHint(result({ stale: false, reasons: [] }), null)).toBe(false);
    expect(stalenessDismissKey(result({ stale: false }))).toBeNull();
  });

  it("tolerates a stale result with no upstream sha", () => {
    const noSha = result({ upstreamHeadSha: null, reasons: ["state-changed"] });
    expect(shouldShowStalenessHint(noSha, null)).toBe(true);
    expect(shouldShowStalenessHint(noSha, stalenessDismissKey(noSha))).toBe(false);
  });
});
