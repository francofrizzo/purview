import { describe, expect, it } from "vitest";
import type { PrListEntry } from "../api/types";
import {
  applyArchive,
  applyRepoArchive,
  formatAbsoluteDate,
  formatAddedAt,
  formatFullTimestamp,
  formatMustReadLines,
  groupKeyOf,
  groupPrsByRepo,
  partitionRepoGroups,
} from "./prList";

const NOW = new Date("2026-08-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pr(
  key: string,
  owner: string,
  repo: string,
  addedAt: string,
  archived = false,
): PrListEntry {
  const [, , , number] = key.split("/");
  return {
    key,
    meta: {
      host: "github.com",
      owner,
      repo,
      number: Number(number),
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    },
    state: "open",
    reviewDecision: null,
    addedAt,
    archived,
  };
}

describe("formatAddedAt", () => {
  it("reads as relative under a week", () => {
    expect(formatAddedAt(ago(5_000), NOW)).toBe("just now");
    expect(formatAddedAt(ago(3 * MINUTE), NOW)).toBe("3m ago");
    expect(formatAddedAt(ago(5 * HOUR), NOW)).toBe("5h ago");
    expect(formatAddedAt(ago(2 * DAY), NOW)).toBe("2d ago");
    expect(formatAddedAt(ago(6 * DAY), NOW)).toBe("6d ago");
  });

  it("switches to an absolute date at exactly a week", () => {
    expect(formatAddedAt(ago(7 * DAY - 1), NOW)).toBe("6d ago");
    expect(formatAddedAt(ago(7 * DAY), NOW)).toBe(formatAbsoluteDate(ago(7 * DAY), NOW));
    expect(formatAddedAt(ago(40 * DAY), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("carries the year only when it is not the current one", () => {
    expect(formatAbsoluteDate("2026-03-04T09:00:00Z", NOW)).toMatch(/^Mar [34]$/);
    expect(formatAbsoluteDate("2024-03-04T09:00:00Z", NOW)).toMatch(/^Mar [34], 2024$/);
  });

  it("never reports a negative age for a future stamp", () => {
    expect(formatAddedAt(new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toBe("just now");
  });

  it("returns an empty string for an unparseable stamp", () => {
    expect(formatAddedAt("not-a-date", NOW)).toBe("");
    expect(formatAbsoluteDate("", NOW)).toBe("");
    expect(formatFullTimestamp("nope")).toBe("");
  });
});

describe("formatMustReadLines", () => {
  it("is exact under 1000", () => {
    expect(formatMustReadLines(0)).toBe("0");
    expect(formatMustReadLines(42)).toBe("42");
    expect(formatMustReadLines(999)).toBe("999");
  });

  it("abbreviates to one decimal at and above 1000", () => {
    expect(formatMustReadLines(1000)).toBe("1.0k");
    expect(formatMustReadLines(1649)).toBe("1.6k");
    expect(formatMustReadLines(15000)).toBe("15.0k");
  });
});

describe("groupPrsByRepo", () => {
  const prs = [
    pr("github.com/acme/billing/482", "acme", "billing", ago(2 * DAY)),
    pr("github.com/acme/platform/1190", "acme", "platform", ago(30 * MINUTE)),
    pr("github.com/acme/billing/470", "acme", "billing", ago(9 * DAY), true),
    pr("github.com/acme/billing/491", "acme", "billing", ago(1 * HOUR)),
  ];

  it("buckets by host/owner/repo", () => {
    expect(groupKeyOf(prs[0])).toBe("github.com/acme/billing");
    expect(groupPrsByRepo(prs).map((g) => g.key)).toEqual([
      "github.com/acme/platform",
      "github.com/acme/billing",
    ]);
  });

  it("sorts PRs newest-added first within a group", () => {
    const billing = groupPrsByRepo(prs).find((g) => g.repo === "billing")!;
    expect(billing.prs.map((p) => p.key)).toEqual([
      "github.com/acme/billing/491",
      "github.com/acme/billing/482",
    ]);
  });

  it("splits archived rows out and still counts them as activity", () => {
    const billing = groupPrsByRepo(prs).find((g) => g.repo === "billing")!;
    expect(billing.archived.map((p) => p.key)).toEqual(["github.com/acme/billing/470"]);
    expect(billing.latestAddedAt).toBe(prs[3].addedAt);
  });

  it("keeps a fully archived repo as its own group", () => {
    const groups = groupPrsByRepo([pr("github.com/x/y/1", "x", "y", ago(DAY), true)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].prs).toEqual([]);
    expect(groups[0].archived).toHaveLength(1);
  });

  it("handles an empty list", () => {
    expect(groupPrsByRepo([])).toEqual([]);
  });
});

describe("applyArchive", () => {
  const prs = [
    pr("github.com/acme/billing/482", "acme", "billing", ago(DAY)),
    pr("github.com/acme/billing/491", "acme", "billing", ago(HOUR)),
  ];

  it("flips exactly one row and leaves the others identical", () => {
    const next = applyArchive(prs, "github.com/acme/billing/482", true);
    expect(next[0].archived).toBe(true);
    expect(next[1]).toBe(prs[1]);
    expect(prs[0].archived).toBe(false);
  });

  it("moves the row into the disclosure once regrouped", () => {
    const next = applyArchive(prs, "github.com/acme/billing/482", true);
    const group = groupPrsByRepo(next)[0];
    expect(group.prs.map((p) => p.key)).toEqual(["github.com/acme/billing/491"]);
    expect(group.archived.map((p) => p.key)).toEqual(["github.com/acme/billing/482"]);
  });

  it("is a no-op for an unknown key", () => {
    expect(applyArchive(prs, "nope", true)).toEqual(prs);
  });
});

describe("archived repos", () => {
  const prs = [
    pr("github.com/acme/billing/482", "acme", "billing", ago(2 * DAY)),
    pr("github.com/acme/billing/470", "acme", "billing", ago(9 * DAY), true),
    pr("github.com/acme/platform/1190", "acme", "platform", ago(30 * MINUTE)),
    pr("github.com/acme/infra/5", "acme", "infra", ago(HOUR)),
  ];

  it("keeps every group active until a repo is archived", () => {
    const { active, archived } = partitionRepoGroups(groupPrsByRepo(prs));
    expect(active.map((g) => g.repo)).toEqual(["platform", "infra", "billing"]);
    expect(archived).toEqual([]);
  });

  it("moves a whole archived repo to its own tier, keeping the order in both", () => {
    const next = applyRepoArchive(
      applyRepoArchive(prs, "github.com/acme/billing", true),
      "github.com/acme/platform",
      true,
    );
    const { active, archived } = partitionRepoGroups(groupPrsByRepo(next));
    expect(active.map((g) => g.repo)).toEqual(["infra"]);
    expect(archived.map((g) => g.repo)).toEqual(["platform", "billing"]);
    expect(archived.every((g) => g.repoArchived)).toBe(true);
  });

  it("leaves each PR's own archived flag alone, so unarchiving the repo restores it exactly", () => {
    const archivedRepo = applyRepoArchive(prs, "github.com/acme/billing", true);
    expect(archivedRepo.map((p) => p.archived)).toEqual(prs.map((p) => p.archived));
    const billing = groupPrsByRepo(archivedRepo).find((g) => g.repo === "billing")!;
    expect(billing.prs.map((p) => p.key)).toEqual(["github.com/acme/billing/482"]);
    expect(billing.archived.map((p) => p.key)).toEqual(["github.com/acme/billing/470"]);

    const restored = applyRepoArchive(archivedRepo, "github.com/acme/billing", false);
    const { active, archived } = partitionRepoGroups(groupPrsByRepo(restored));
    expect(archived).toEqual([]);
    expect(active.find((g) => g.repo === "billing")!.archived.map((p) => p.key)).toEqual([
      "github.com/acme/billing/470",
    ]);
    // Rows of other repos are the very same objects.
    expect(restored[2]).toBe(prs[2]);
  });
});
