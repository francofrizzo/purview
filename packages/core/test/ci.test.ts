import { afterEach, describe, expect, it } from "vitest";
import { ciFromRollup, fetchPrStatuses, fetchReviewStatus, reviewersChanged, reviewersFromPr, setGhRunner } from "../src/github.js";

const key = { host: "github.com", owner: "acme", repo: "app", number: 1 };
const run = (conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun", name: "Tests", conclusion, status, detailsUrl: "https://example.com/run",
});
const commit = (nodes: ReturnType<typeof run>[]) => ({
  oid: "head1", statusCheckRollup: { contexts: { nodes } },
});
afterEach(() => setGhRunner(null));

describe("CI normalization", () => {
  it.each(["SUCCESS", "NEUTRAL"])("maps %s to success", conclusion => {
    expect(ciFromRollup(commit([run(conclusion)])).state).toBe("success");
  });
  it.each(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])("maps %s to failure", conclusion => {
    expect(ciFromRollup(commit([run(conclusion)])).checks[0].state).toBe("failure");
  });
  it("preserves skipped checks without treating them as failures", () => {
    expect(ciFromRollup(commit([run("SKIPPED")]))).toMatchObject({ state: "none", checks: [{ state: "skipped" }] });
  });
  it.each(["QUEUED", "IN_PROGRESS"])("maps unfinished %s checks to pending", status => {
    expect(ciFromRollup(commit([run(null, status)])).state).toBe("pending");
  });
  it.each([["SUCCESS", "success"], ["ERROR", "failure"], ["FAILURE", "failure"], ["PENDING", "pending"], ["EXPECTED", "pending"]])("maps legacy %s", (state, expected) => {
    expect(ciFromRollup({ oid: "sha", statusCheckRollup: { contexts: { nodes: [
      { __typename: "StatusContext", context: "legacy", state, targetUrl: null },
    ] } } })).toEqual({ state: expected, headSha: "sha", checks: [{ name: "legacy", state: expected, url: null }] });
  });
  it("aggregates failure before pending before success and preserves check details", () => {
    const result = ciFromRollup(commit([run("SUCCESS"), run(null), run("FAILURE")]));
    expect(result.state).toBe("failure");
    expect(result.checks[2]).toEqual({ name: "Tests", state: "failure", url: "https://example.com/run" });
    expect(ciFromRollup(commit([run("SUCCESS"), run(null)])).state).toBe("pending");
  });
  it("accepts missing and empty rollups", () => {
    for (const raw of [null, { oid: "sha", statusCheckRollup: null }, commit([])]) {
      expect(ciFromRollup(raw)).toMatchObject({ state: "none", checks: [] });
    }
  });
});

it("fetches identical CI in the batched and page queries without extra calls", async () => {
  const calls: string[][] = [];
  const raw = { state: "OPEN", reviewDecision: "APPROVED", commits: { nodes: [{ commit: commit([run("FAILURE")]) }] } };
  setGhRunner(args => {
    calls.push(args);
    return JSON.stringify({ data: { repository: { pullRequest: raw, pr1: raw } } });
  });
  expect(fetchReviewStatus(key)).toMatchObject({ reviewDecision: "approved", ci: { state: "failure", headSha: "head1" } });
  expect((await fetchPrStatuses(key, [1])).get(1)?.ci).toMatchObject({ state: "failure", headSha: "head1" });
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call.join(" ")).toContain("contexts(first: 50)");
});

it("tolerates absent commits and failed page queries", () => {
  setGhRunner(() => JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } }));
  expect(fetchReviewStatus(key)).toEqual({ reviewDecision: "approved", ci: undefined });
  setGhRunner(() => { throw new Error("offline"); });
  expect(fetchReviewStatus(key)).toEqual({ reviewDecision: null });
});

describe("reviewers normalization", () => {
  const user = (login: string, state: string) => ({ state, author: { login, avatarUrl: `https://a/${login}` } });
  const request = (who: Record<string, unknown>) => ({ requestedReviewer: who });
  const raw = {
    reviewRequests: { nodes: [
      request({ __typename: "User", login: "dana", avatarUrl: "https://a/dana" }),
      request({ __typename: "Team", slug: "payments", avatarUrl: "https://a/payments" }),
      request({ __typename: "Bot", login: "coderabbit[bot]", avatarUrl: null }),
      null,
    ] },
    latestReviews: { nodes: [
      user("sam", "APPROVED"),
      user("dana", "CHANGES_REQUESTED"),
      user("lee", "COMMENTED"),
      user("kim", "DISMISSED"),
      user("me", "PENDING"),
      user("sam", "COMMENTED"),
      null,
    ] },
  };

  it("lists requests first, then latest reviews, deduped by login, PENDING skipped", () => {
    expect(reviewersFromPr(raw)).toEqual([
      { login: "dana", avatarUrl: "https://a/dana", kind: "user", state: "requested" },
      { login: "payments", avatarUrl: "https://a/payments", kind: "team", state: "requested" },
      { login: "coderabbit[bot]", avatarUrl: null, kind: "user", state: "requested" },
      { login: "sam", avatarUrl: "https://a/sam", kind: "user", state: "approved" },
      { login: "lee", avatarUrl: "https://a/lee", kind: "user", state: "commented" },
      { login: "kim", avatarUrl: "https://a/kim", kind: "user", state: "dismissed" },
    ]);
  });

  it("leaves the PR author's own review comments out", () => {
    expect(reviewersFromPr({
      author: { login: "Me" },
      reviewRequests: { nodes: [] },
      latestReviews: { nodes: [
        { state: "COMMENTED", author: { login: "me", avatarUrl: null } },
        { state: "APPROVED", author: { login: "sam", avatarUrl: null } },
      ] },
    })).toEqual([{ login: "sam", avatarUrl: null, kind: "user", state: "approved" }]);
  });

  it("is empty when GitHub answered with nobody, and unknown when the fields are missing", () => {
    expect(reviewersFromPr({ reviewRequests: { nodes: [] }, latestReviews: { nodes: [] } })).toEqual([]);
    expect(reviewersFromPr(null)).toBeUndefined();
    expect(reviewersFromPr({ reviewRequests: { nodes: [] } })).toBeUndefined();
    expect(reviewersFromPr({ latestReviews: { nodes: [] } })).toBeUndefined();
  });

  it("changes on content only, and never on an unknown answer", () => {
    const a = [{ login: "dana", avatarUrl: null, kind: "user" as const, state: "requested" as const }];
    expect(reviewersChanged(undefined, a)).toBe(true);
    expect(reviewersChanged(a, [{ ...a[0], state: "approved" }])).toBe(true);
    expect(reviewersChanged(a, [...a])).toBe(false);
    expect(reviewersChanged(a, undefined)).toBe(false);
    expect(reviewersChanged(undefined, [])).toBe(true);
  });

  it("rides on both the batched and the page queries", async () => {
    const calls: string[][] = [];
    const pr = { state: "OPEN", reviewDecision: null, ...raw };
    setGhRunner(args => {
      calls.push(args);
      return JSON.stringify({ data: { repository: { pullRequest: pr, pr1: pr } } });
    });
    expect(fetchReviewStatus(key).reviewers).toHaveLength(6);
    expect((await fetchPrStatuses(key, [1])).get(1)?.reviewers).toHaveLength(6);
    for (const call of calls) expect(call.join(" ")).toContain("latestReviews(first: 50)");
  });
});
