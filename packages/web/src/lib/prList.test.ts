import { describe, expect, it } from "vitest";
import type { PrListEntry } from "../api/types";
import {
  arrangeBlock,
  stackOf,
  applyArchive,
  applyRepoArchive,
  formatAbsoluteDate,
  formatAddedAt,
  formatFullTimestamp,
  formatMustReadLines,
  groupKeyOf,
  groupPrsByRepo,
  finishedPrKeys,
  partitionRepoGroups,
  reviewedPrKeys,
  prUrlForNumber,
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

  it("sorts PRs oldest-added first within a group", () => {
    const billing = groupPrsByRepo(prs).find((g) => g.repo === "billing")!;
    expect(billing.prs.map((p) => p.key)).toEqual([
      "github.com/acme/billing/482",
      "github.com/acme/billing/491",
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

describe("groupPrsByRepo — pending review requests", () => {
  const asked = (p: PrListEntry, at: string): PrListEntry => ({
    ...p,
    reviewRequest: { at, by: "dana", via: "you" },
  });
  const prs = [
    pr("github.com/acme/platform/1190", "acme", "platform", ago(30 * MINUTE)),
    asked(pr("github.com/acme/billing/482", "acme", "billing", ago(2 * DAY)), ago(DAY)),
    asked(pr("github.com/acme/billing/491", "acme", "billing", ago(HOUR)), ago(HOUR)),
    asked(pr("github.com/acme/billing/475", "acme", "billing", ago(5 * DAY)), ago(4 * DAY)),
    pr("github.com/acme/billing/499", "acme", "billing", ago(10 * MINUTE)),
  ];

  it("lifts requested PRs into their own bucket, longest-waiting first", () => {
    const billing = groupPrsByRepo(prs).find((g) => g.repo === "billing")!;
    expect(billing.needsReview.map((p) => p.key)).toEqual([
      "github.com/acme/billing/475",
      "github.com/acme/billing/482",
      "github.com/acme/billing/491",
    ]);
    expect(billing.prs.map((p) => p.key)).toEqual(["github.com/acme/billing/499"]);
  });

  it("puts repos with a pending request ahead of more recently touched ones", () => {
    expect(groupPrsByRepo([prs[0], prs[1]]).map((g) => g.key)).toEqual([
      "github.com/acme/billing",
      "github.com/acme/platform",
    ]);
  });

  it("puts the PRs you opened in their own bucket, below the waiting ones", () => {
    const mine = { ...prs[4], authoredByYou: true };
    const billing = groupPrsByRepo([prs[1], mine, prs[0]]).find((g) => g.repo === "billing")!;
    expect(billing.needsReview.map((p) => p.key)).toEqual([prs[1].key]);
    expect(billing.mine.map((p) => p.key)).toEqual([mine.key]);
    expect(billing.prs).toEqual([]);
  });

  it("lists archived rows newest first", () => {
    const rows = [1, 2, 3].map((n) => pr(`github.com/acme/repo/${n}`, "acme", "repo", ago(n), true));
    expect(groupPrsByRepo(rows)[0].archived.map((p) => p.meta.number)).toEqual([1, 2, 3]);
  });
  it("keeps an archived PR of yours in the archived disclosure", () => {
    const mine = { ...prs[4], authoredByYou: true, archived: true };
    const [group] = groupPrsByRepo([mine]);
    expect(group.mine).toEqual([]);
    expect(group.archived.map((p) => p.key)).toEqual([mine.key]);
  });

  it("ignores requests on merged, closed or archived PRs", () => {
    const merged = { ...prs[1], state: "merged" as const };
    const archived = { ...prs[2], archived: true };
    const billing = groupPrsByRepo([merged, archived]).find((g) => g.repo === "billing")!;
    expect(billing.needsReview).toEqual([]);
    expect(billing.prs.map((p) => p.key)).toEqual([merged.key]);
    expect(billing.archived.map((p) => p.key)).toEqual([archived.key]);
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

describe("prUrlForNumber", () => {
  const repo = { host: "github.com", owner: "acme", repo: "billing" };
  it("builds the PR URL from 123 or #123", () => {
    expect(prUrlForNumber(repo, "123")).toBe("https://github.com/acme/billing/pull/123");
    expect(prUrlForNumber(repo, " #42 ")).toBe("https://github.com/acme/billing/pull/42");
    expect(prUrlForNumber({ ...repo, host: "ghe.corp" }, "7")).toBe("https://ghe.corp/acme/billing/pull/7");
  });
  it("rejects anything else", () => {
    for (const bad of ["", "abc", "12a", "#", "0", "-3", "1.5"]) expect(prUrlForNumber(repo, bad)).toBeNull();
  });
});

describe("finishedPrKeys", () => {
  it("picks the merged and closed PRs, from every block", () => {
    const pr = (key: string, state: string) => ({ key, state }) as PrListEntry;
    expect(
      finishedPrKeys({
        needsReview: [pr("a", "open"), pr("b", "closed")],
        mine: [pr("c", "merged"), pr("d", "draft")],
        prs: [pr("e", "merged")],
      }),
    ).toEqual(["b", "c", "e"]);
  });
});

describe("diffTotals", () => {
  it("uses the file's own counts when GitHub supplied them, counting files without numbers", async () => {
    const { diffTotals } = await import("./prList");
    expect(
      diffTotals([
        { additions: 34, deletions: 3 },
        { additions: 14, deletions: 0 },
        { /* binary */ },
      ]),
    ).toEqual({ files: 3, additions: 48, deletions: 3 });
    expect(diffTotals([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("counts +/- hunk lines when the file carries null counts (real files.json)", async () => {
    const { diffTotals } = await import("./prList");
    expect(
      diffTotals([
        {
          additions: null,
          deletions: null,
          hunks: [
            { lines: [" ctx", "+a", "+b", "-old", " ctx", "\\ No newline at end of file"] },
            { lines: ["-x", "-y", "+z"] },
          ],
        },
        // A hunk from before bodies were kept: the content-only arrays stand in.
        { hunks: [{ addedLines: ["p", "q"], removedLines: [] }] },
      ]),
    ).toEqual({ files: 2, additions: 5, deletions: 3 });
  });
});

describe("stackOf", () => {
  const row = (n: number, base?: number, archived = false) => {
    const p = pr(`github.com/acme/repo/${n}`, "acme", "repo", ago(n));
    p.archived = archived;
    if (base) p.meta.basePr = { number: base, title: "base", url: `https://github.com/acme/repo/pull/${base}` };
    return p;
  };
  it("walks base links both ways inside the repo, skipping archived rows", () => {
    const other = pr("github.com/acme/else/1", "acme", "else", ago(1));
    other.meta.basePr = { number: 1, title: "base", url: "" };
    const prs = [row(1), row(2, 1), row(3, 2), row(4, 1, true), row(5), other];
    const keys = (n: number) => stackOf(prs, `github.com/acme/repo/${n}`).map((k) => Number(k.split("/").pop())).sort();
    expect(keys(2)).toEqual([1, 2, 3]);
    expect(keys(1)).toEqual([1, 2, 3]);
    expect(keys(5)).toEqual([5]);
    expect(stackOf(prs, "github.com/acme/repo/99")).toEqual(["github.com/acme/repo/99"]);
  });
});

describe("arrangeBlock", () => {
  const row = (n: number, tag?: string, base?: number) => {
    const p = pr(`github.com/acme/repo/${n}`, "acme", "repo", ago(n));
    p.meta.tag = tag;
    if (base) p.meta.basePr = { number: base, title: "base", url: `https://github.com/acme/repo/pull/${base}` };
    return p;
  };
  const shape = (rows: PrListEntry[]) => arrangeBlock(rows).map((g) => ({ tag: g.tag, rows: g.prs.map(({ pr, depth }) => [pr.meta.number, depth]) }));
  it("sorts tags, preserves group order and puts untagged last", () => {
    expect(shape([row(1), row(2, "z"), row(3, "a"), row(4, "z"), row(5)])).toEqual([
      { tag: "a", rows: [[3, 0]] }, { tag: "z", rows: [[2, 0], [4, 0]] }, { tag: null, rows: [[1, 0], [5, 0]] },
    ]);
    expect(arrangeBlock([])).toEqual([]);
  });
  it("orders a chain at its base position with stable siblings", () => {
    expect(shape([row(3, "a", 2), row(4, "a"), row(2, "a", 1), row(1, "a"), row(5, "a", 1)])).toEqual([
      { tag: "a", rows: [[4, 0], [1, 0], [2, 1], [3, 2], [5, 1]] },
    ]);
  });
  it("leaves bases outside the group at depth zero", () => {
    expect(shape([row(2, "a", 1), row(1, "b"), row(3, "a", 99)])).toEqual([
      { tag: "a", rows: [[2, 0], [3, 0]] }, { tag: "b", rows: [[1, 0]] },
    ]);
  });
  it("tells each row how to draw its tree: guides for continuing ancestors, elbow kind, children", () => {
    // 1 ─┬ 2 ─ 3 (3 is 2's only child; 2 continues to sibling 4)
    //    └ 4
    const rows = arrangeBlock([row(1, "a"), row(2, "a", 1), row(3, "a", 2), row(4, "a", 1)])[0]!.prs;
    expect(rows.map((r) => [r.pr.meta.number, r.depth, r.guides, r.last, r.hasChildren])).toEqual([
      [1, 0, [], true, true],
      [2, 1, [], false, true],
      [3, 2, [true], true, false],
      [4, 1, [], true, false],
    ]);
  });
  it("breaks cycles without omitting or duplicating rows", () => {
    expect(shape([row(1, undefined, 2), row(2, undefined, 1), row(3, undefined, 3)])).toEqual([
      { tag: null, rows: [[1, 0], [2, 1], [3, 0]] },
    ]);
  });
});

describe("reviewedPrKeys", () => {
  it("picks the open PRs you already reviewed, never a finished one", () => {
    const pr = (key: string, state: string, reviewedByYou?: boolean) => ({ key, state, reviewedByYou }) as PrListEntry;
    expect(
      reviewedPrKeys({
        prs: [pr("a", "open", true), pr("b", "draft", true), pr("c", "open"), pr("d", "merged", true)],
      }),
    ).toEqual(["a", "b"]);
  });
});
