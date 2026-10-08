import { describe, expect, it } from "vitest";
import type { RemoteConversationComment, RemoteReview } from "../api/types";
import { buildTimeline, entryBody, latestVerdicts, reviewRevision, revisionNote, verdictsTitle } from "./reviews";
import { DEFAULT_THREAD_FILTERS } from "./threads";

let seq = 0;
const author = (login: string, bot = false, botName?: string) => ({ login, bot, ...(botName ? { botName } : {}) });

const review = (
  login: string,
  state: RemoteReview["state"],
  at: string,
  over: Partial<RemoteReview> & { bot?: boolean; botName?: string } = {},
): RemoteReview => {
  const { bot = false, botName, ...rest } = over;
  const n = seq++;
  return {
    id: `PRR_${n}`,
    databaseId: n,
    author: author(login, bot, botName),
    state,
    body: "",
    submittedAt: at,
    url: `https://x/r${n}`,
    commentCount: 0,
    isMine: login === "me",
    ...rest,
  };
};

const said = (login: string, at: string, over: Partial<RemoteConversationComment> & { bot?: boolean } = {}): RemoteConversationComment => {
  const { bot = false, ...rest } = over;
  const n = seq++;
  return {
    id: `IC_${n}`,
    databaseId: n,
    author: author(login, bot),
    body: `said ${n}`,
    createdAt: at,
    url: `https://x/c${n}`,
    isMine: login === "me",
    ...rest,
  };
};

describe("buildTimeline", () => {
  it("merges reviews and conversation comments oldest first", () => {
    const t = buildTimeline(
      [review("maria", "APPROVED", "2026-01-03"), review("bob", "COMMENTED", "2026-01-01")],
      [said("dana", "2026-01-02"), said("oliver", "2026-01-04")],
    );
    expect(t.entries.map((e) => [e.kind, e.author.login])).toEqual([
      ["review", "bob"],
      ["comment", "dana"],
      ["review", "maria"],
      ["comment", "oliver"],
    ]);
    expect(t.hidden).toBe(0);
  });

  it("hides AI reviewers per the thread filters, never the reader's own", () => {
    const reviews = [
      review("coderabbitai", "COMMENTED", "2026-01-01", { bot: true }),
      review("copilot", "COMMENTED", "2026-01-02", { bot: true }),
      review("me", "COMMENTED", "2026-01-03", { bot: true }),
    ];
    const conv = [said("coderabbitai[bot]", "2026-01-04", { bot: true })];
    const perBot = buildTimeline(reviews, conv, { ...DEFAULT_THREAD_FILTERS, hiddenBots: ["coderabbitai"] });
    expect(perBot.entries.map((e) => e.author.login)).toEqual(["copilot", "me"]);
    expect(perBot.hidden).toBe(2);
    const noAi = buildTimeline(reviews, conv, { ...DEFAULT_THREAD_FILTERS, showAiReviewers: false });
    expect(noAi.entries.map((e) => e.author.login)).toEqual(["me"]);
  });

  it("tolerates a response without reviews or conversation", () => {
    expect(buildTimeline(undefined, undefined).entries).toEqual([]);
  });
});

describe("entryBody", () => {
  it("drops HTML comments, so a bookkeeping-only body reads as empty", () => {
    const [e] = buildTimeline([review("coderabbitai", "COMMENTED", "t", { body: "<!-- state: abc -->\n" })]).entries;
    expect(entryBody(e)).toBe("");
  });
});

describe("latestVerdicts", () => {
  it("keeps an approval or change request through later comments, and lets a dismissal clear it", () => {
    const v = latestVerdicts([
      review("maria", "CHANGES_REQUESTED", "2026-01-01"),
      review("maria", "COMMENTED", "2026-01-02"),
      review("bob", "APPROVED", "2026-01-03"),
      review("maria", "APPROVED", "2026-01-04"),
      review("oliver", "APPROVED", "2026-01-02"),
      review("oliver", "DISMISSED", "2026-01-05"),
      review("maria", "COMMENTED", "2026-01-06"),
    ]);
    expect(v.map((x) => [x.author.login, x.verdict])).toEqual([
      ["bob", "APPROVED"],
      ["maria", "APPROVED"],
      ["oliver", "DISMISSED"],
    ]);
  });

  it("shows comment-only humans but not comment-only bots, and leaves out the PR author", () => {
    const v = latestVerdicts(
      [
        review("coderabbitai", "COMMENTED", "2026-01-01", { bot: true, botName: "CodeRabbit" }),
        review("copilot", "APPROVED", "2026-01-02", { bot: true, botName: "Copilot" }),
        review("Dana", "COMMENTED", "2026-01-03"),
        review("me", "COMMENTED", "2026-01-04"),
      ],
      { prAuthor: "dana" },
    );
    expect(v.map((x) => [x.author.login, x.verdict])).toEqual([
      ["copilot", "APPROVED"],
      ["me", "COMMENTED"],
    ]);
    expect(verdictsTitle(v)).toBe("Copilot approved · you commented");
  });

  it("drops reviewers the filters hide", () => {
    const v = latestVerdicts([review("copilot", "APPROVED", "t", { bot: true })], {
      filters: { ...DEFAULT_THREAD_FILTERS, hiddenBots: ["copilot"] },
    });
    expect(v).toEqual([]);
  });

  it("treats a [bot] suffix as the same reviewer", () => {
    const v = latestVerdicts([
      review("sourcery-ai[bot]", "CHANGES_REQUESTED", "2026-01-01", { bot: true }),
      review("sourcery-ai", "APPROVED", "2026-01-02", { bot: true }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].verdict).toBe("APPROVED");
  });
});

describe("reviewRevision", () => {
  const ctx = {
    current: 4,
    revisions: [
      { revision: 1, headSha: "a", addedAt: "2026-01-01T00:00:00Z" },
      { revision: 2, headSha: "b", addedAt: "2026-01-02T00:00:00Z" },
      // a rebase that only moved the base: same head as rev 2
      { revision: 3, headSha: "b", addedAt: "2026-01-03T00:00:00Z", baseOnly: true },
      { revision: 4, headSha: "c", addedAt: "2026-01-04T00:00:00Z" },
    ],
  };
  const at = (oid: string | undefined, when = "2026-01-02T12:00:00Z") => ({ commitOid: oid, submittedAt: when });

  it("is current when the review read the head being shown", () => {
    expect(reviewRevision(at("c"), ctx)).toEqual({ kind: "current" });
    // base-only refreshes after the reviewed head don't make it stale
    expect(reviewRevision(at("b"), { ...ctx, current: 3 })).toEqual({ kind: "current" });
  });

  it("counts the revisions since an older one, base-only ones included", () => {
    expect(reviewRevision(at("b"), ctx)).toEqual({ kind: "older", revision: 3, behind: 1 });
    expect(reviewRevision(at("a"), ctx)).toEqual({ kind: "older", revision: 1, behind: 3 });
  });

  it("tells a commit Purview never saw apart by when it was reviewed", () => {
    expect(reviewRevision(at("zz"), ctx)).toEqual({ kind: "unknown", newer: false });
    expect(reviewRevision(at("zz", "2026-02-01T00:00:00Z"), ctx)).toEqual({ kind: "unknown", newer: true });
  });

  it("says nothing without a commit or revisions", () => {
    expect(reviewRevision(at(undefined), ctx)).toBeUndefined();
    expect(reviewRevision(at("c"), undefined)).toBeUndefined();
  });

  it("notes only verdicts that don't cover the shown code", () => {
    expect(revisionNote({ kind: "current" })).toBeNull();
    expect(revisionNote({ kind: "older", revision: 2, behind: 1 })).toBe("on rev 2 · 1 revision ago");
    expect(revisionNote({ kind: "unknown", newer: false })).toBe("on an earlier commit");
  });

  it("carries the revision on a standing verdict", () => {
    const [v] = latestVerdicts([review("bob", "APPROVED", "2026-01-02T12:00:00Z", { commitOid: "a" })], { revisions: ctx });
    expect(v.revision).toEqual({ kind: "older", revision: 1, behind: 3 });
    expect(verdictsTitle([v])).toBe("bob approved (on rev 1 · 3 revisions ago)");
  });
});
