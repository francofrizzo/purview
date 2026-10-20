import { afterEach, describe, expect, it } from "vitest";
import { ciFromRollup, fetchPrStatuses, fetchReviewStatus, setGhRunner } from "../src/github.js";

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
