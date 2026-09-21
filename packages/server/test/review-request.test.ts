import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearViewerCache,
  readMeta,
  setGhRunner,
  updateMeta,
  writeMeta,
  type Meta,
  type PrKey,
  type ReviewRequest,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { checkStaleness, clearStalenessCache, REVIEW_REQUEST_POLL_MS } from "../src/staleness.js";
import {
  REVIEW_REQUEST_LIST_TTL_MS,
  resetReviewRequestRefresh,
  reviewRequestEligible,
  reviewRequestRefreshIdle,
  scheduleReviewRequestRefresh,
} from "../src/review-request-refresh.js";
import { buildFixture, key } from "./fixtures.js";

const ME = "reviewer-bot";
const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

let root: string;
let calls: string[][];
let prState: { state: string; merged: boolean };
let timelineFails: boolean;

const timelineCalls = () => calls.filter((c) => c.some((a) => a.includes("/timeline"))).length;

function installGh() {
  setGhRunner((args) => {
    calls.push([...args]);
    const joined = args.join(" ");
    if (joined === "api user") return JSON.stringify({ login: ME });
    if (joined.includes("user/teams")) return "";
    if (joined.includes("/timeline")) {
      if (timelineFails) throw new Error("gh api timeline failed: HTTP 502");
      return (
        JSON.stringify({
          event: "review_requested",
          created_at: "2026-09-18T21:46:16Z",
          requested_reviewer: { login: ME },
          requested_team: { slug: null },
          review_requester: { login: "alice" },
        }) + "\n"
      );
    }
    if (args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
    }
    if (joined.includes("Accept: application/vnd.github.v3.diff")) throw new Error("no diff expected");
    if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    if (/repos\/acme\/widgets$/.test(joined)) return JSON.stringify({ default_branch: "main" });
    if (args[0] === "pr" && args[1] === "list") return "[]";
    return JSON.stringify({
      node_id: "PR_1",
      number: key.number,
      title: "Add widgets",
      html_url: "https://example.invalid/pr",
      state: prState.state,
      merged: prState.merged,
      base: { ref: "main", sha: "base1" },
      head: { ref: "feature", sha: "head1" },
    });
  });
}

const EXPECTED: ReviewRequest = { at: "2026-09-18T21:46:16Z", by: "alice", via: "you" };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-rr-test-"));
  buildFixture(root);
  calls = [];
  prState = { state: "open", merged: false };
  timelineFails = false;
  clearViewerCache();
  clearStalenessCache();
  resetReviewRequestRefresh();
  installGh();
});

afterEach(async () => {
  await reviewRequestRefreshIdle();
  resetReviewRequestRefresh();
  setGhRunner(null);
  clearViewerCache();
  clearStalenessCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("refresh", () => {
  it("fills reviewRequest into meta and serves it", async () => {
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });
    const res = await app.request(`/api/prs/${encodedKey}/refresh?analyze=false`, { method: "POST" });
    expect(res.status).toBe(200);
    const meta = readMeta(key, root);
    expect(meta.reviewRequest).toEqual(EXPECTED);
    expect(meta.reviewRequestCheckedAt).toBeTypeOf("string");

    const detail = await (await app.request(`/api/prs/${encodedKey}`)).json();
    expect(detail.reviewRequest).toEqual(EXPECTED);
    const list = await (await app.request(`/api/prs`)).json();
    expect(list.prs[0].reviewRequest).toEqual(EXPECTED);
  });

  it("keeps the previous value when the timeline fetch fails", async () => {
    updateMeta(key, { reviewRequest: EXPECTED }, root);
    timelineFails = true;
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });
    await app.request(`/api/prs/${encodedKey}/refresh?analyze=false`, { method: "POST" });
    expect(readMeta(key, root).reviewRequest).toEqual(EXPECTED);
  });

  it("skips the lookup for a merged PR", async () => {
    prState = { state: "closed", merged: true };
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });
    await app.request(`/api/prs/${encodedKey}/refresh?analyze=false`, { method: "POST" });
    expect(timelineCalls()).toBe(0);
    expect(readMeta(key, root).reviewRequest).toBeUndefined();
  });
});

describe("staleness poll", () => {
  it("fills reviewRequest, at most once per poll interval", () => {
    let t = 1_800_000_000_000;
    const now = () => t;
    checkStaleness(key, root, { now });
    expect(readMeta(key, root).reviewRequest).toEqual(EXPECTED);
    expect(timelineCalls()).toBe(1);

    // A forced re-check inside the interval spends no timeline call…
    t += REVIEW_REQUEST_POLL_MS - 1;
    checkStaleness(key, root, { now, force: true });
    expect(timelineCalls()).toBe(1);

    // …the next poll does.
    t += 1;
    checkStaleness(key, root, { now, force: true });
    expect(timelineCalls()).toBe(2);
  });
});

describe("background refresh from GET /api/prs", () => {
  /** Extra tracked PRs of the same repo, with the given meta overrides. */
  function track(n: number, over: Partial<Meta> = {}): PrKey {
    const k = { ...key, number: n };
    writeMeta(
      k,
      {
        host: k.host,
        owner: k.owner,
        repo: k.repo,
        number: n,
        url: `https://example.invalid/${n}`,
        createdAt: "2026-09-01T00:00:00Z",
        prState: "open",
        archived: false,
        ...over,
      },
      root,
    );
    return k;
  }

  it("does not block the response, and fills meta afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const app = createApp({
      stateDir: root,
      webDist: "/nonexistent",
      reviewRequestRefresh: {
        resolve: async () => {
          started += 1;
          await gate;
          return EXPECTED;
        },
      },
    });
    const res = await app.request(`/api/prs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Answered while the lookup is still parked on the gate.
    expect(body.prs[0].reviewRequest).toBeUndefined();
    await Promise.resolve();
    expect(started).toBe(1);
    release();
    await reviewRequestRefreshIdle();
    expect(readMeta(key, root).reviewRequest).toEqual(EXPECTED);
  });

  it("runs the real async lookup through gh", async () => {
    const app = createApp({ stateDir: root, webDist: "/nonexistent" });
    await app.request(`/api/prs`);
    await reviewRequestRefreshIdle();
    expect(readMeta(key, root).reviewRequest).toEqual(EXPECTED);
  });

  it("caps concurrency at 2", async () => {
    for (let n = 100; n < 106; n++) track(n);
    let inFlight = 0;
    let peak = 0;
    let done = 0;
    const app = createApp({
      stateDir: root,
      webDist: "/nonexistent",
      reviewRequestRefresh: {
        resolve: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          done += 1;
          return null;
        },
      },
    });
    await app.request(`/api/prs`);
    await reviewRequestRefreshIdle();
    expect(done).toBe(7);
    expect(peak).toBe(2);
  });

  it("is rate-limited per PR by reviewRequestCheckedAt", async () => {
    let t = 1_800_000_000_000;
    let lookups = 0;
    const deps = {
      now: () => t,
      resolve: async () => {
        lookups += 1;
        return null;
      },
    };
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: deps });
    await app.request(`/api/prs`);
    await reviewRequestRefreshIdle();
    expect(lookups).toBe(1);
    expect(readMeta(key, root).reviewRequest).toBeNull();

    t += REVIEW_REQUEST_LIST_TTL_MS - 1;
    await app.request(`/api/prs`);
    await reviewRequestRefreshIdle();
    expect(lookups).toBe(1);

    t += 1;
    await app.request(`/api/prs`);
    await reviewRequestRefreshIdle();
    expect(lookups).toBe(2);
  });

  it("does not queue a PR twice while its lookup is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let lookups = 0;
    const deps = {
      resolve: async () => {
        lookups += 1;
        await gate;
        return null;
      },
    };
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: deps });
    await app.request(`/api/prs`);
    await app.request(`/api/prs`);
    release();
    await reviewRequestRefreshIdle();
    expect(lookups).toBe(1);
  });

  it("skips merged, closed and archived PRs", async () => {
    // The fixture PR is fresh, so only the extra ones are candidates.
    updateMeta(key, { reviewRequestCheckedAt: new Date().toISOString() }, root);
    track(201, { prState: "merged" });
    track(202, { prState: "closed" });
    track(203, { archived: true });
    const open = track(204, { prState: "draft" });
    const seen: number[] = [];
    const app = createApp({
      stateDir: root,
      webDist: "/nonexistent",
      reviewRequestRefresh: {
        resolve: async (k) => {
          seen.push(k.number);
          return null;
        },
      },
    });
    await app.request(`/api/prs`);
    await reviewRequestRefreshIdle();
    expect(seen).toEqual([open.number]);
  });

  it("stamps checkedAt but keeps the value when the lookup fails", async () => {
    updateMeta(key, { reviewRequest: EXPECTED }, root);
    const queued = scheduleReviewRequestRefresh([{ key, meta: readMeta(key, root) }], root, {
      resolve: async () => undefined,
    });
    expect(queued).toBe(1);
    await reviewRequestRefreshIdle();
    const meta = readMeta(key, root);
    expect(meta.reviewRequest).toEqual(EXPECTED);
    expect(meta.reviewRequestCheckedAt).toBeTypeOf("string");
  });

  it("eligibility helper", () => {
    const now = Date.parse("2026-09-21T12:00:00Z");
    expect(reviewRequestEligible({ prState: "open", archived: false }, now)).toBe(true);
    expect(
      reviewRequestEligible(
        { prState: "open", archived: false, reviewRequestCheckedAt: "2026-09-21T11:50:00Z" },
        now,
      ),
    ).toBe(false);
    expect(
      reviewRequestEligible(
        { prState: "open", archived: false, reviewRequestCheckedAt: "2026-09-21T11:40:00Z" },
        now,
      ),
    ).toBe(true);
    expect(reviewRequestEligible({ prState: "merged", archived: false }, now)).toBe(false);
  });
});
