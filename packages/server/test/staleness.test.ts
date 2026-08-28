import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadState, readMeta, setGhRunner, updateMeta, type GhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { STALENESS_TTL_MS, checkStaleness, clearStalenessCache } from "../src/staleness.js";
import { buildFixture, key } from "./fixtures.js";

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

/**
 * The fixture's revision 1 records base1/head1; upstream starts identical, and
 * each test moves exactly the pieces it is about.
 */
interface Upstream {
  headSha: string;
  baseSha: string;
  state: string;
  draft: boolean;
  merged: boolean;
  reviewDecision: string | null;
}

let root: string;
let app: ReturnType<typeof createApp>;
let upstream: Upstream;
let calls: string[][];
let ghFailure: string | null;

function installGh() {
  const runner: GhRunner = (args) => {
    calls.push([...args]);
    if (ghFailure) throw new Error(`gh ${args.join(" ")} failed: ${ghFailure}`);
    if (args[1] === "graphql") {
      return JSON.stringify({
        data: {
          repository: { pullRequest: { reviewDecision: upstream.reviewDecision } },
        },
      });
    }
    return JSON.stringify({
      node_id: "PR_1",
      number: key.number,
      title: "Add widgets",
      html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
      state: upstream.state,
      draft: upstream.draft,
      merged: upstream.merged,
      base: { ref: "main", sha: upstream.baseSha },
      head: { ref: "feature", sha: upstream.headSha },
    });
  };
  setGhRunner(runner);
}

/** How many `gh api repos/.../pulls/{n}` calls were made (excludes graphql). */
const pullCalls = () => calls.filter((c) => c.some((a) => /^repos\/.*\/pulls\/\d+$/.test(a))).length;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-staleness-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  upstream = {
    headSha: "head1",
    baseSha: "base1",
    state: "open",
    draft: false,
    merged: false,
    reviewDecision: null,
  };
  calls = [];
  ghFailure = null;
  clearStalenessCache();
  installGh();
});

afterEach(() => {
  setGhRunner(null);
  clearStalenessCache();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A clock the TTL tests advance by hand. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("staleness reasons", () => {
  it("reports nothing when head, base and state all match", () => {
    updateMeta(key, { prState: "open" }, root);
    const res = checkStaleness(key, root);
    expect(res.stale).toBe(false);
    expect(res.reasons).toEqual([]);
    expect(res.upstreamHeadSha).toBe("head1");
    expect(res.localHeadSha).toBe("head1");
    expect(res.error).toBeUndefined();
    expect(res.checkedAt).toBeTruthy();
  });

  it("reports new-commits when the head sha moved", () => {
    upstream.headSha = "head2";
    const res = checkStaleness(key, root);
    expect(res.stale).toBe(true);
    expect(res.reasons).toEqual(["new-commits"]);
    expect(res.upstreamHeadSha).toBe("head2");
    expect(res.localHeadSha).toBe("head1");
  });

  it("reports base-moved when the base sha moved", () => {
    upstream.baseSha = "base2";
    const res = checkStaleness(key, root);
    expect(res.reasons).toEqual(["base-moved"]);
  });

  it("reports state-changed when the PR state moved", () => {
    updateMeta(key, { prState: "open" }, root);
    upstream.state = "closed";
    upstream.merged = true;
    const res = checkStaleness(key, root);
    expect(res.reasons).toEqual(["state-changed"]);
    expect(res.upstreamState).toBe("merged");
    expect(res.localState).toBe("open");
  });

  it("reports state-changed when only the review decision moved", () => {
    updateMeta(key, { prState: "open", reviewDecision: null }, root);
    upstream.reviewDecision = "APPROVED";
    const res = checkStaleness(key, root);
    expect(res.reasons).toEqual(["state-changed"]);
    expect(res.upstreamReviewDecision).toBe("approved");
  });

  it("combines every reason that applies", () => {
    updateMeta(key, { prState: "open" }, root);
    upstream.headSha = "head2";
    upstream.baseSha = "base2";
    upstream.state = "closed";
    const res = checkStaleness(key, root);
    expect(res.reasons).toEqual(["new-commits", "base-moved", "state-changed"]);
    expect(res.stale).toBe(true);
  });

  it("never reports state-changed off a meta that never recorded a state", () => {
    // Pre-`prState` state dirs: unknown is not a difference.
    expect(readMeta(key, root).prState).toBeUndefined();
    upstream.state = "closed";
    expect(checkStaleness(key, root).reasons).toEqual([]);
  });

  it("treats a null upstream review decision as unknown, not as cleared", () => {
    // `fetchReviewDecision` reports a failed query as `null`, so a null can
    // never be allowed to look like "the approval went away".
    updateMeta(key, { prState: "open", reviewDecision: "approved" }, root);
    upstream.reviewDecision = null;
    const res = checkStaleness(key, root);
    expect(res.reasons).toEqual([]);
    expect(readMeta(key, root).reviewDecision).toBe("approved");
  });
});

describe("staleness cache", () => {
  it("reuses one answer for the whole TTL window, then re-checks", () => {
    const c = clock();
    upstream.headSha = "head2";
    const first = checkStaleness(key, root, { now: c.now });
    expect(pullCalls()).toBe(1);

    c.advance(STALENESS_TTL_MS - 1);
    const cached = checkStaleness(key, root, { now: c.now });
    expect(pullCalls()).toBe(1);
    expect(cached).toBe(first);
    expect(cached.checkedAt).toBe(first.checkedAt);

    c.advance(2);
    const fresh = checkStaleness(key, root, { now: c.now });
    expect(pullCalls()).toBe(2);
    expect(fresh.checkedAt).not.toBe(first.checkedAt);
  });

  it("caches failures too, so a broken gh is not hammered", () => {
    const c = clock();
    ghFailure = "HTTP 503";
    checkStaleness(key, root, { now: c.now });
    checkStaleness(key, root, { now: c.now });
    expect(pullCalls()).toBe(1);
  });

  it("`force` skips the cache", () => {
    const c = clock();
    checkStaleness(key, root, { now: c.now });
    checkStaleness(key, root, { now: c.now, force: true });
    expect(pullCalls()).toBe(2);
  });
});

describe("gh failure tolerance", () => {
  it("answers a non-stale result carrying the error instead of throwing", () => {
    ghFailure = "gh: command not found";
    const res = checkStaleness(key, root);
    expect(res.stale).toBe(false);
    expect(res.reasons).toEqual([]);
    expect(res.upstreamHeadSha).toBeNull();
    expect(res.localHeadSha).toBe("head1");
    expect(res.error).toContain("command not found");
  });

  it("still answers 200 over HTTP", async () => {
    ghFailure = "HTTP 500";
    const res = await app.request(`/api/prs/${encodedKey}/staleness`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stale).toBe(false);
    expect(body.error).toBeTruthy();
  });
});

describe("opportunistic meta update", () => {
  it("writes the moved state and decision into meta", () => {
    updateMeta(key, { prState: "open", reviewDecision: null }, root);
    upstream.state = "closed";
    upstream.merged = true;
    upstream.reviewDecision = "CHANGES_REQUESTED";
    checkStaleness(key, root);
    const meta = readMeta(key, root);
    expect(meta.prState).toBe("merged");
    expect(meta.reviewDecision).toBe("changes_requested");
  });

  it("leaves revisions, hunks and the diff completely alone", () => {
    updateMeta(key, { prState: "open" }, root);
    const before = loadState(key, root);
    const revDir = path.join(root, key.host, key.owner, key.repo, String(key.number), "revisions");
    const revsBefore = fs.readdirSync(revDir);
    const eventsBefore = fs.readFileSync(
      path.join(root, key.host, key.owner, key.repo, String(key.number), "events.jsonl"),
      "utf8",
    );

    upstream.state = "closed";
    upstream.headSha = "head2";
    checkStaleness(key, root);

    const after = loadState(key, root);
    expect(after.currentRevision).toBe(before.currentRevision);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.hunks).toEqual(before.hunks);
    expect(fs.readdirSync(revDir)).toEqual(revsBefore);
    expect(
      fs.readFileSync(
        path.join(root, key.host, key.owner, key.repo, String(key.number), "events.jsonl"),
        "utf8",
      ),
    ).toBe(eventsBefore);
  });

  it("writes nothing when nothing moved", () => {
    updateMeta(key, { prState: "open" }, root);
    const metaFile = path.join(
      root,
      key.host,
      key.owner,
      key.repo,
      String(key.number),
      "meta.json",
    );
    const before = fs.readFileSync(metaFile, "utf8");
    checkStaleness(key, root);
    expect(fs.readFileSync(metaFile, "utf8")).toBe(before);
  });
});

describe("GET /api/prs/:key/staleness", () => {
  it("returns the full result shape", async () => {
    updateMeta(key, { prState: "open" }, root);
    upstream.headSha = "head2";
    const res = await app.request(`/api/prs/${encodedKey}/staleness`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      stale: true,
      reasons: ["new-commits"],
      upstreamHeadSha: "head2",
      localHeadSha: "head1",
      upstreamState: "open",
      localState: "open",
    });
    expect(typeof body.checkedAt).toBe("string");
  });

  it("404s for an unknown PR without spending a gh call", async () => {
    const other = encodeURIComponent("github.com/acme/other/1");
    const res = await app.request(`/api/prs/${other}/staleness`);
    expect(res.status).toBe(404);
    expect(pullCalls()).toBe(0);
  });

  it("serves repeated polls from the cache", async () => {
    await app.request(`/api/prs/${encodedKey}/staleness`);
    await app.request(`/api/prs/${encodedKey}/staleness`);
    await app.request(`/api/prs/${encodedKey}/staleness`);
    expect(pullCalls()).toBe(1);
  });
});
