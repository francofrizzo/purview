import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VIEWER_TEAMS_TTL_MS,
  clearViewerCache,
  fetchReviewRequest,
  fetchReviewRequestAsync,
  foldReviewRequest,
  resolveReviewRequest,
  resolveReviewRequestAsync,
  setGhRunner,
  viewerLogin,
  viewerLoginAsync,
  viewerTeams,
  type TimelineEvent,
} from "../src/github.js";
import { githubUserCachePath, type PrKey } from "../src/paths.js";

const ME = "francofrizzo";

const requested = (at: string, reviewer: string, by = "crivaronicolini"): TimelineEvent => ({
  event: "review_requested",
  created_at: at,
  requested_reviewer: { login: reviewer },
  requested_team: { slug: null },
  review_requester: { login: by },
});
const teamRequested = (at: string, slug: string, by = "crivaronicolini"): TimelineEvent => ({
  event: "review_requested",
  created_at: at,
  requested_reviewer: { login: null },
  requested_team: { slug },
  review_requester: { login: by },
});
const removed = (at: string, reviewer: string | null, slug: string | null = null): TimelineEvent => ({
  event: "review_request_removed",
  created_at: at,
  requested_reviewer: { login: reviewer },
  requested_team: { slug },
  review_requester: { login: "crivaronicolini" },
});
const reviewed = (at: string, user: string, state = "approved"): TimelineEvent => ({
  event: "reviewed",
  created_at: null,
  submitted_at: at,
  state,
  user: { login: user },
});

describe("foldReviewRequest", () => {
  it("returns the pending direct request", () => {
    expect(foldReviewRequest([requested("2026-09-18T21:46:16Z", ME)], ME)).toEqual({
      at: "2026-09-18T21:46:16Z",
      by: "crivaronicolini",
      via: "you",
    });
  });

  it("is null with no events, or only other people's", () => {
    expect(foldReviewRequest([], ME)).toBeNull();
    expect(
      foldReviewRequest(
        [
          requested("2026-09-18T10:00:00Z", "someone-else"),
          reviewed("2026-09-18T11:00:00Z", "coderabbitai[bot]", "commented"),
          teamRequested("2026-09-18T12:00:00Z", "not-my-team"),
        ],
        ME,
        ["backend"],
      ),
    ).toBeNull();
  });

  it("a removal closes the request", () => {
    expect(
      foldReviewRequest(
        [requested("2026-09-18T10:00:00Z", ME), removed("2026-09-18T11:00:00Z", ME)],
        ME,
      ),
    ).toBeNull();
  });

  it("someone else's removal leaves mine open", () => {
    expect(
      foldReviewRequest(
        [requested("2026-09-18T10:00:00Z", ME), removed("2026-09-18T11:00:00Z", "bob")],
        ME,
      )?.at,
    ).toBe("2026-09-18T10:00:00Z");
  });

  it("my review closes it; a re-request after it opens a new one", () => {
    const events = [
      requested("2026-09-18T21:46:16Z", ME),
      reviewed("2026-09-18T21:49:53Z", "coderabbitai[bot]", "commented"),
      reviewed("2026-09-21T14:02:11Z", ME),
    ];
    expect(foldReviewRequest(events, ME)).toBeNull();
    expect(
      foldReviewRequest([...events, requested("2026-09-21T16:00:00Z", ME, "alice")], ME),
    ).toEqual({ at: "2026-09-21T16:00:00Z", by: "alice", via: "you" });
  });

  it("someone else's review does not close mine", () => {
    expect(
      foldReviewRequest(
        [requested("2026-09-18T10:00:00Z", ME), reviewed("2026-09-18T11:00:00Z", "bob")],
        ME,
      ),
    ).not.toBeNull();
  });

  it("an unsubmitted (pending) review of mine does not close it", () => {
    expect(
      foldReviewRequest(
        [requested("2026-09-18T10:00:00Z", ME), reviewed("2026-09-18T11:00:00Z", ME, "pending")],
        ME,
      ),
    ).not.toBeNull();
  });

  it("recognises requests to my teams, and only those", () => {
    const events = [teamRequested("2026-09-18T10:00:00Z", "Backend")];
    expect(foldReviewRequest(events, ME, ["backend"])).toEqual({
      at: "2026-09-18T10:00:00Z",
      by: "crivaronicolini",
      via: "team:Backend",
    });
    expect(foldReviewRequest(events, ME, [])).toBeNull();
    expect(foldReviewRequest(events, ME, ["frontend"])).toBeNull();
  });

  it("a team removal closes only the team request", () => {
    const events = [
      requested("2026-09-18T10:00:00Z", ME),
      teamRequested("2026-09-18T12:00:00Z", "backend"),
      removed("2026-09-18T13:00:00Z", null, "backend"),
    ];
    expect(foldReviewRequest(events, ME, ["backend"])).toMatchObject({
      at: "2026-09-18T10:00:00Z",
      via: "you",
    });
  });

  it("with several open, the latest request wins", () => {
    const events = [
      requested("2026-09-18T10:00:00Z", ME),
      teamRequested("2026-09-19T10:00:00Z", "backend", "dana"),
    ];
    expect(foldReviewRequest(events, ME, ["backend"])).toEqual({
      at: "2026-09-19T10:00:00Z",
      by: "dana",
      via: "team:backend",
    });
  });

  it("my review closes team requests too", () => {
    expect(
      foldReviewRequest(
        [teamRequested("2026-09-18T10:00:00Z", "backend"), reviewed("2026-09-18T11:00:00Z", ME)],
        ME,
        ["backend"],
      ),
    ).toBeNull();
  });

  it("orders unordered input by time", () => {
    const events = [
      requested("2026-09-21T16:00:00Z", ME, "alice"),
      reviewed("2026-09-21T14:02:11Z", ME),
      removed("2026-09-19T00:00:00Z", ME),
      requested("2026-09-18T21:46:16Z", ME),
    ];
    expect(foldReviewRequest(events, ME)).toMatchObject({ at: "2026-09-21T16:00:00Z", by: "alice" });
    // …and a removal that is the latest event wins even when listed first.
    expect(
      foldReviewRequest(
        [removed("2026-09-20T00:00:00Z", ME), requested("2026-09-18T00:00:00Z", ME)],
        ME,
      ),
    ).toBeNull();
  });

  it("matches logins case-insensitively and skips undated events", () => {
    expect(foldReviewRequest([requested("2026-09-18T10:00:00Z", "FrancoFrizzo")], ME)?.via).toBe("you");
    expect(
      foldReviewRequest(
        [requested("2026-09-18T10:00:00Z", ME), { ...reviewed("", ME), submitted_at: null }],
        ME,
      ),
    ).not.toBeNull();
  });

  it("falls back to an empty requester", () => {
    const e = requested("2026-09-18T10:00:00Z", ME);
    e.review_requester = null;
    expect(foldReviewRequest([e], ME)?.by).toBe("");
  });
});

/* ----------------------------------------------------------- with gh */

const key: PrKey = { host: "github.com", owner: "primo-devs", repo: "core", number: 8505 };

let root: string;
let calls: string[][];
let fail: RegExp | null;
let timeline: TimelineEvent[];
let teamsOut: string;

function install() {
  setGhRunner((args) => {
    calls.push([...args]);
    const joined = args.join(" ");
    if (fail && fail.test(joined)) throw new Error(`gh ${joined} failed: HTTP 403`);
    if (joined === "api user") return JSON.stringify({ login: ME, id: 1 });
    if (args.includes("user/teams?per_page=100")) return teamsOut;
    if (args.some((a) => a.includes("/timeline"))) {
      return timeline.map((e) => JSON.stringify(e)).join("\n") + "\n";
    }
    throw new Error(`unexpected gh ${joined}`);
  });
}

const userCalls = () => calls.filter((c) => c.join(" ") === "api user").length;
const teamCalls = () => calls.filter((c) => c.includes("user/teams?per_page=100")).length;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-rr-"));
  calls = [];
  fail = null;
  timeline = [requested("2026-09-18T21:46:16Z", ME)];
  teamsOut = "";
  clearViewerCache();
  install();
});

afterEach(() => {
  setGhRunner(null);
  clearViewerCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fetchReviewRequest", () => {
  it("fetches the paginated timeline and folds it", () => {
    expect(fetchReviewRequest(key, ME)).toEqual({
      at: "2026-09-18T21:46:16Z",
      by: "crivaronicolini",
      via: "you",
    });
    const args = calls[0];
    expect(args).toContain("--paginate");
    expect(args).toContain("repos/primo-devs/core/issues/8505/timeline?per_page=100");
    expect(args).toContain("--jq");
  });

  it("returns undefined when gh fails, sync and async", async () => {
    fail = /timeline/;
    expect(fetchReviewRequest(key, ME)).toBeUndefined();
    await expect(fetchReviewRequestAsync(key, ME)).resolves.toBeUndefined();
  });

  it("returns undefined on unparseable output", () => {
    setGhRunner(() => "not json\n");
    expect(fetchReviewRequest(key, ME)).toBeUndefined();
  });

  it("passes --hostname for GHE", () => {
    fetchReviewRequest({ ...key, host: "ghe.example.com" }, ME);
    expect(calls[0].slice(0, 3)).toEqual(["api", "--hostname", "ghe.example.com"]);
  });
});

describe("viewer login cache", () => {
  it("asks gh once per process and persists to disk", () => {
    expect(viewerLogin("github.com", root)).toBe(ME);
    expect(viewerLogin("github.com", root)).toBe(ME);
    expect(userCalls()).toBe(1);
    const disk = JSON.parse(fs.readFileSync(githubUserCachePath(root), "utf8"));
    expect(disk["github.com"].login).toBe(ME);

    // A fresh process (memory cleared) reads the disk cache, no gh call.
    clearViewerCache();
    expect(viewerLogin("github.com", root)).toBe(ME);
    expect(userCalls()).toBe(1);
  });

  it("shares one in-flight gh call between async callers", async () => {
    const [a, b] = await Promise.all([viewerLoginAsync("github.com", root), viewerLoginAsync("github.com", root)]);
    expect([a, b]).toEqual([ME, ME]);
    expect(userCalls()).toBe(1);
  });

  it("answers null on failure and does not hammer gh", () => {
    fail = /^api user$/;
    const t = 1_700_000_000_000;
    expect(viewerLogin("github.com", root, t)).toBeNull();
    expect(viewerLogin("github.com", root, t + 1000)).toBeNull();
    expect(userCalls()).toBe(1);
    fail = null;
    expect(viewerLogin("github.com", root, t + 6 * 60_000)).toBe(ME);
    expect(fs.existsSync(githubUserCachePath(root))).toBe(true);
  });
});

describe("viewer teams cache", () => {
  it("filters by org and caches in memory until the TTL", () => {
    teamsOut = [
      { slug: "backend", org: "primo-devs" },
      { slug: "general", org: "CubaWiki" },
    ]
      .map((t) => JSON.stringify(t))
      .join("\n");
    const t = 1_700_000_000_000;
    expect(viewerTeams("github.com", "Primo-Devs", root, t)).toEqual(["backend"]);
    expect(viewerTeams("github.com", "CubaWiki", root, t + 1)).toEqual(["general"]);
    expect(teamCalls()).toBe(1);
    viewerTeams("github.com", "primo-devs", root, t + VIEWER_TEAMS_TTL_MS);
    expect(teamCalls()).toBe(2);
  });

  it("treats a failure (e.g. no read:org scope) as no teams, never an error", () => {
    fail = /user\/teams/;
    expect(viewerTeams("github.com", "primo-devs", root)).toEqual([]);
  });
});

describe("resolveReviewRequest", () => {
  it("combines login, teams and timeline", async () => {
    teamsOut = JSON.stringify({ slug: "backend", org: "primo-devs" });
    timeline = [teamRequested("2026-09-19T10:00:00Z", "backend")];
    expect(resolveReviewRequest(key, root)).toMatchObject({ via: "team:backend" });
    clearViewerCache();
    await expect(resolveReviewRequestAsync(key, root)).resolves.toMatchObject({
      via: "team:backend",
    });
  });

  it("still resolves direct requests when teams cannot be read", () => {
    fail = /user\/teams/;
    expect(resolveReviewRequest(key, root)).toMatchObject({ via: "you" });
  });

  it("is undefined when the login is unknown", async () => {
    fail = /^api user$/;
    expect(resolveReviewRequest(key, root)).toBeUndefined();
    clearViewerCache();
    await expect(resolveReviewRequestAsync(key, root)).resolves.toBeUndefined();
    expect(calls.some((c) => c.some((a) => a.includes("/timeline")))).toBe(false);
  });
});
