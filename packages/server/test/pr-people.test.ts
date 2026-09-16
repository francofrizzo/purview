import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMeta, prDir, keyToString, updateMeta } from "@reviewer/core";
import { buildFixture, key as fixtureKey } from "./fixtures.js";
import { createPrPeopleLoader, persistPrPeople } from "../src/pr-people.js";

const key = (number: number, host = "github.com") => ({ host, owner: "acme", repo: "widgets", number });
const url = (n: number) => `https://github.com/acme/widgets/pull/${n}`;

describe("PR authors and relationships", () => {
  it("separates own, requested reviews and other PRs, and caches repeated reads", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("user")) return { login: "Octocat" };
      if (args.includes("search/issues")) return { total_count: 1, items: [{ html_url: url(2) }] };
      const n = Number(args.at(-1)?.split("/").at(-1));
      return { user: { login: n === 1 ? "octocat" : "hubot" }, html_url: url(n) };
    });
    const load = createPrPeopleLoader(run);
    const result = await load([key(1), key(2), key(3)]);
    expect(result).toEqual({
      "github.com/acme/widgets/1": { author: "octocat", relationship: "own" },
      "github.com/acme/widgets/2": { author: "hubot", relationship: "review" },
      "github.com/acme/widgets/3": { author: "hubot", relationship: "other" },
    });
    expect(await load([key(3), key(2), key(1)])).toEqual(result);
    expect(run).toHaveBeenCalledTimes(8);
    expect(run.mock.calls[1][0]).toContain("q=is:pr is:open review-requested:Octocat");
  });

  it("keeps authors when review discovery fails without mislabeling others", async () => {
    const load = createPrPeopleLoader(async (args) => {
      if (args.includes("user")) return { login: "octocat" };
      if (args.includes("search/issues")) throw new Error("rate limit");
      return { user: { login: "hubot" }, html_url: url(2) };
    });
    expect(await load([key(2)])).toEqual({ "github.com/acme/widgets/2": { author: "hubot", relationship: "unknown" } });
  });

  it("reports inaccessible PRs as unknown and does not lose other results", async () => {
    const load = createPrPeopleLoader(async (args) => {
      if (args.includes("user")) return { login: "octocat" };
      if (args.includes("search/issues")) return { items: [], total_count: 0 };
      if (args.at(-1)?.endsWith("/1")) throw new Error("404");
      return { user: { login: "octocat" }, html_url: url(2) };
    });
    expect(await load([key(1), key(2)])).toEqual({
      "github.com/acme/widgets/1": { relationship: "unknown" },
      "github.com/acme/widgets/2": { author: "octocat", relationship: "own" },
    });
  });

  it("uses the tracked host and does not accept incomplete review searches", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("user")) return { login: "octocat" };
      if (args.includes("search/issues")) return { items: [], incomplete_results: true, total_count: 0 };
      return { user: { login: "hubot" } };
    });
    const result = await createPrPeopleLoader(run)([key(2, "git.example.com")]);
    expect(result["git.example.com/acme/widgets/2"].relationship).toBe("unknown");
    expect(run.mock.calls.every(([args]) => args[args.indexOf("--hostname") + 1] === "git.example.com")).toBe(true);
  });
});


describe("GitHub metadata polling", () => {
  it("refreshes lifecycle and review decisions on force while caching ordinary reads", async () => {
    let merged = false;
    let decision: string | null = "APPROVED";
    let failDecision = false;
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("user")) return { login: "octocat" };
      if (args.includes("search/issues")) return { total_count: 0, items: [] };
      if (args.includes("graphql")) {
        if (failDecision) throw new Error("offline");
        return { data: { repository: { pullRequest: { reviewDecision: decision } } } };
      }
      return { user: { login: "octocat" }, title: "Latest title", state: merged ? "closed" : "open", merged, html_url: url(1) };
    });
    const load = createPrPeopleLoader(run);
    expect((await load([key(1)]))[keyToString(key(1))]).toMatchObject({ state: "open", reviewDecision: "approved" });
    merged = true;
    decision = null;
    expect((await load([key(1)]))[keyToString(key(1))].state).toBe("open");
    expect((await load([key(1)], true))[keyToString(key(1))]).toMatchObject({ state: "merged", reviewDecision: null, title: "Latest title" });
    failDecision = true;
    expect((await load([key(1)], true))[keyToString(key(1))]).not.toHaveProperty("reviewDecision");
  });

  it("persists metadata without changing review state or recreating deleted PRs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-metadata-"));
    try {
      buildFixture(root);
      updateMeta(fixtureKey, { reviewDecision: "approved", archived: true }, root);
      const dir = prDir(fixtureKey, root);
      const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
      const people = { [keyToString(fixtureKey)]: { author: "new-author", title: "New title", state: "merged" as const, relationship: "other" as const } };
      persistPrPeople([fixtureKey], people, root);
      expect(readMeta(fixtureKey, root)).toMatchObject({ author: "new-author", title: "New title", prState: "merged", reviewDecision: "approved", archived: true, reviewRelationship: "other" });
      persistPrPeople([fixtureKey], { [keyToString(fixtureKey)]: { relationship: "unknown" } }, root);
      expect(readMeta(fixtureKey, root)).toMatchObject({ author: "new-author", reviewRelationship: "other", prState: "merged" });
      expect(fs.readFileSync(path.join(dir, "state.json"), "utf8")).toBe(before);
      persistPrPeople([fixtureKey], { [keyToString(fixtureKey)]: { ...people[keyToString(fixtureKey)], reviewDecision: null } }, root);
      expect(readMeta(fixtureKey, root).reviewDecision).toBeNull();
      fs.rmSync(dir, { recursive: true });
      persistPrPeople([fixtureKey], people, root);
      expect(fs.existsSync(dir)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
