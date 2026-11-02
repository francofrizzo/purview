import { afterEach, describe, expect, it } from "vitest";
import { fetchReviewerCandidatesAsync, reviewerCandidates, setGhAsyncRunner, setReviewRequestsAsync } from "../src/github.js";

const key = { host: "github.com", owner: "acme", repo: "billing", number: 7 };

afterEach(() => setGhAsyncRunner(null));

describe("reviewerCandidates", () => {
  it("puts GitHub's suggestions first, then users, then teams, each once", () => {
    const out = reviewerCandidates(
      {
        suggested: [{ reviewer: { login: "maria", name: "María", avatarUrl: "m.png" } }],
        users: [{ login: "maria" }, { login: "dana", avatarUrl: null }],
        teams: [{ slug: "payments", name: "Payments" }],
      },
      ["me"],
    );
    expect(out).toEqual([
      { login: "maria", kind: "user", avatarUrl: "m.png", name: "María", suggested: true },
      { login: "dana", kind: "user", avatarUrl: null },
      { login: "payments", kind: "team", avatarUrl: null, name: "Payments" },
    ]);
  });

  it("leaves out the author and whoever is already on the PR", () => {
    const out = reviewerCandidates({ users: [{ login: "Me" }, { login: "dana" }], teams: [{ slug: "core" }] }, ["me", "team:core"]);
    expect(out.map((c) => c.login)).toEqual(["dana"]);
  });
});

describe("GitHub calls", () => {
  it("requests and un-requests through requested_reviewers", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    setGhAsyncRunner(async (args, input) => {
      calls.push({ args, input });
      return "{}";
    });
    await setReviewRequestsAsync(key, { users: ["dana"], teams: ["payments"] });
    await setReviewRequestsAsync(key, { users: ["dana"], teams: [] }, true);
    expect(calls[0].args).toContain("POST");
    expect(calls[0].args).toContain("repos/acme/billing/pulls/7/requested_reviewers");
    expect(JSON.parse(calls[0].input!)).toEqual({ reviewers: ["dana"], team_reviewers: ["payments"] });
    expect(calls[1].args).toContain("DELETE");
  });

  it("keeps the users when the teams query fails", async () => {
    setGhAsyncRunner(async (args) => {
      if (args.some((a) => a.includes("organization("))) throw new Error("no org");
      return JSON.stringify({
        data: { repository: { pullRequest: { suggestedReviewers: [] }, assignableUsers: { nodes: [{ login: "dana" }] } } },
      });
    });
    expect((await fetchReviewerCandidatesAsync(key, "da")).map((c) => c.login)).toEqual(["dana"]);
  });
});
