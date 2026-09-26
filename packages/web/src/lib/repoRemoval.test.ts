import { describe, expect, it } from "vitest";
import {
  removalBlockedWhy,
  removalConfirmMatches,
  removalConfirmName,
  removalLossLines,
} from "./repoRemoval";

const repo = { owner: "acme", repo: "billing" };

describe("removal confirm name", () => {
  it("is owner/repo, as the list shows it", () => {
    expect(removalConfirmName(repo)).toBe("acme/billing");
  });

  it("matches only the full name, ignoring surrounding space and case", () => {
    expect(removalConfirmMatches("acme/billing", repo)).toBe(true);
    expect(removalConfirmMatches("  Acme/Billing ", repo)).toBe(true);
    expect(removalConfirmMatches("billing", repo)).toBe(false);
    expect(removalConfirmMatches("acme/billin", repo)).toBe(false);
    expect(removalConfirmMatches("", repo)).toBe(false);
  });
});

describe("removalLossLines", () => {
  it("counts PRs and drafts, and says pushed comments stay on GitHub", () => {
    const lines = removalLossLines({ prCount: 3, draftComments: 2, pushedComments: 1 });
    expect(lines[0]).toBe("3 tracked PRs, with their analyses, viewed marks and chats.");
    expect(lines[1]).toBe("2 draft comments not yet pushed — these exist only here.");
    expect(lines[2]).toBe(
      "1 pushed comment in a pending review: it stays on GitHub, but Purview forgets it.",
    );
    expect(lines.at(-1)).toMatch(/local settings/);
  });

  it("singular, and no pushed line when there are none", () => {
    const lines = removalLossLines({ prCount: 1, draftComments: 0, pushedComments: 0 });
    expect(lines[0]).toMatch(/^1 tracked PR,/);
    expect(lines[1]).toBe("No unpushed draft comments.");
    expect(lines.some((l) => l.includes("pushed comment in"))).toBe(false);
  });
});

describe("removalBlockedWhy", () => {
  it("is null when nothing is busy", () => {
    expect(removalBlockedWhy({ busy: [] })).toBeNull();
  });

  it("names the PR and what is running", () => {
    expect(
      removalBlockedWhy({ busy: [{ key: "github.com/acme/billing/482", reason: "analysis" }] }),
    ).toBe("An analysis is running for #482; cancel it or let it finish first.");
    expect(removalBlockedWhy({ busy: [{ key: "github.com/acme/billing/7", reason: "chat" }] })).toMatch(
      /chat reply is still streaming for #7/,
    );
  });
});
