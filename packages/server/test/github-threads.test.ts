import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { readComments, writeComments } from "../src/comments.js";
import {
  classifyAuthor,
  normalizeConversation,
  normalizeReviews,
  normalizeThreads,
  threadsPath,
  type RawThread,
} from "../src/github-threads.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-threads-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  gh = fakeGh();
  gh.install();
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

let nextDbId = 1;

function rawComment(
  login: string | null,
  over: Partial<{ typename: string; body: string; state: string; createdAt: string; edited: string; dbId: number }> = {},
) {
  const dbId = over.dbId ?? nextDbId++;
  return {
    id: `PRRC_${dbId}`,
    databaseId: dbId,
    body: over.body ?? `comment ${dbId}`,
    createdAt: over.createdAt ?? `2026-01-01T00:00:${String(dbId % 60).padStart(2, "0")}Z`,
    lastEditedAt: over.edited ?? null,
    url: `https://github.com/acme/widgets/pull/7#discussion_r${dbId}`,
    author: login === null ? null : { __typename: over.typename ?? "User", login, avatarUrl: `https://a/${login}` },
    pullRequestReview: { state: over.state ?? "COMMENTED" },
  };
}

function rawThread(id: string, comments: ReturnType<typeof rawComment>[], over: Partial<RawThread> = {}): RawThread {
  return {
    id,
    path: "src/foo.ts",
    line: 2,
    originalLine: 2,
    startLine: null,
    diffSide: "RIGHT",
    subjectType: "LINE",
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: comments },
    ...over,
  };
}

function rawReview(
  login: string,
  state: string,
  over: Partial<{ typename: string; body: string; at: string; inline: number; dbId: number }> = {},
) {
  const dbId = over.dbId ?? nextDbId++;
  return {
    id: `PRR_${dbId}`,
    databaseId: dbId,
    state,
    body: over.body ?? "",
    submittedAt: state === "PENDING" ? null : over.at ?? "2026-01-01T00:00:00Z",
    createdAt: over.at ?? "2026-01-01T00:00:00Z",
    url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${dbId}`,
    author: { __typename: over.typename ?? "User", login, avatarUrl: `https://a/${login}` },
    comments: { totalCount: over.inline ?? 0 },
  };
}

function rawIssueComment(
  login: string,
  over: Partial<{ typename: string; body: string; at: string; edited: string; dbId: number }> = {},
) {
  const dbId = over.dbId ?? nextDbId++;
  return {
    id: `IC_${dbId}`,
    databaseId: dbId,
    body: over.body ?? `said ${dbId}`,
    createdAt: over.at ?? "2026-01-01T00:00:00Z",
    lastEditedAt: over.edited ?? null,
    url: `https://github.com/acme/widgets/pull/7#issuecomment-${dbId}`,
    author: { __typename: over.typename ?? "User", login, avatarUrl: `https://a/${login}` },
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const getThreads = async () => {
  const res = await app.request(`/api/prs/${encodedKey}/threads`);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
};

/* -------------------------------------------------------------- bot naming */

describe("classifyAuthor", () => {
  it("trusts GitHub's Bot actor and names the reviewers it knows", () => {
    expect(classifyAuthor({ __typename: "Bot", login: "coderabbitai" })).toEqual({
      login: "coderabbitai",
      bot: true,
      botName: "CodeRabbit",
    });
    expect(classifyAuthor({ __typename: "Bot", login: "copilot-pull-request-reviewer" }).botName).toBe("Copilot");
    expect(classifyAuthor({ __typename: "Bot", login: "some-linter" })).toEqual({ login: "some-linter", bot: true });
  });

  it("treats a [bot] login as a bot, matching known names without the suffix", () => {
    expect(classifyAuthor({ __typename: "User", login: "chatgpt-codex-connector[bot]" })).toMatchObject({
      bot: true,
      botName: "Codex",
    });
  });

  it("adds the reader's own AI reviewer list, case-insensitively and ignoring [bot]", () => {
    expect(classifyAuthor({ __typename: "User", login: "Review-Helper" }, ["review-helper[bot]"]).bot).toBe(true);
    expect(classifyAuthor({ __typename: "User", login: "alice" }, ["review-helper"]).bot).toBe(false);
  });

  it("never names a human who happens to share a known login (no bot flag, no botName)", () => {
    expect(classifyAuthor({ __typename: "User", login: "claude" })).toEqual({ login: "claude", bot: false });
  });

  it("reads a deleted account as ghost", () => {
    expect(classifyAuthor(null)).toEqual({ login: "ghost", bot: false });
  });
});

/* ------------------------------------------------------------ normalizing */

describe("normalizeThreads", () => {
  it("maps the GraphQL thread to the wire shape, oldest comment first", () => {
    const [t] = normalizeThreads(
      [
        rawThread("T1", [
          rawComment("bob", { createdAt: "2026-01-02T00:00:00Z", dbId: 11 }),
          rawComment("alice", { createdAt: "2026-01-01T00:00:00Z", edited: "2026-01-03T00:00:00Z", dbId: 10 }),
        ], { isResolved: true, resolvedBy: { login: "alice" }, diffSide: "LEFT" }),
      ],
      { viewerLogin: "Alice" },
    );
    expect(t).toMatchObject({
      id: "T1",
      path: "src/foo.ts",
      subjectType: "line",
      line: 2,
      originalLine: 2,
      startLine: null,
      side: "LEFT",
      isResolved: true,
      resolvedBy: "alice",
      viewerCanReply: true,
    });
    expect(t.comments.map((c) => c.databaseId)).toEqual([10, 11]);
    expect(t.comments[0]).toEqual({
      id: "PRRC_10",
      databaseId: 10,
      author: { login: "alice", bot: false, avatarUrl: "https://a/alice" },
      body: "comment 10",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
      url: "https://github.com/acme/widgets/pull/7#discussion_r10",
      reviewState: "SUBMITTED",
      isMine: true,
    });
    expect(t.comments[1].isMine).toBe(false);
    expect(t.comments[1].updatedAt).toBeUndefined();
  });

  it("keeps outdated and file-level threads with a null line", () => {
    const threads = normalizeThreads(
      [
        rawThread("OUT", [rawComment("bob")], { line: null, originalLine: 9, isOutdated: true }),
        rawThread("FILE", [rawComment("bob")], { line: null, originalLine: null, subjectType: "FILE" }),
      ],
      { viewerLogin: "me" },
    );
    expect(threads[0]).toMatchObject({ line: null, originalLine: 9, isOutdated: true, subjectType: "line" });
    expect(threads[1]).toMatchObject({ line: null, subjectType: "file" });
  });

  it("drops someone else's pending comments, and a thread left empty", () => {
    const threads = normalizeThreads(
      [
        rawThread("MINE", [rawComment("me", { state: "PENDING" }), rawComment("bob", { state: "PENDING" })]),
        rawThread("THEIRS", [rawComment("bob", { state: "PENDING" })]),
      ],
      { viewerLogin: "me" },
    );
    expect(threads.map((t) => t.id)).toEqual(["MINE"]);
    expect(threads[0].comments).toHaveLength(1);
    expect(threads[0].comments[0].reviewState).toBe("PENDING");
  });

  it("links a remote comment to the Purview comment it mirrors", () => {
    const [t] = normalizeThreads([rawThread("T", [rawComment("me", { dbId: 500 }), rawComment("bob", { dbId: 501 })])], {
      viewerLogin: "me",
      localComments: [{ id: "local-1", githubCommentId: 500 }, { id: "local-2" }],
    });
    expect(t.comments[0].localId).toBe("local-1");
    expect(t.comments[1].localId).toBeUndefined();
  });

  it("falls back to file, line and text for a sent comment that never got its GitHub id", () => {
    const [t] = normalizeThreads(
      [rawThread("T", [rawComment("me", { body: "nit: centralize?\n" }), rawComment("bob", { body: "nit: centralize?" })])],
      {
        viewerLogin: "me",
        localComments: [
          // a draft never matches: it isn't on GitHub, whatever its text
          { id: "draft", file: "src/foo.ts", line: 2, body: "nit: centralize?", status: "draft" },
          { id: "sent", file: "src/foo.ts", line: 2, body: "nit: centralize?", status: "submitted" },
        ],
      },
    );
    expect(t.comments[0].localId).toBe("sent");
    // only the viewer's own comments can mirror a Purview one
    expect(t.comments[1].localId).toBeUndefined();
  });

  it("does not text-match a sent comment on another line", () => {
    const [t] = normalizeThreads([rawThread("T", [rawComment("me", { body: "same words" })])], {
      viewerLogin: "me",
      localComments: [{ id: "sent", file: "src/foo.ts", line: 9, body: "same words", status: "pushed" }],
    });
    expect(t.comments[0].localId).toBeUndefined();
  });
});

describe("normalizeReviews", () => {
  it("maps reviews oldest first, drops PENDING, counts inline comments and marks the viewer's", () => {
    const out = normalizeReviews(
      [
        rawReview("bob", "CHANGES_REQUESTED", { at: "2026-01-03T00:00:00Z", body: "fix it", inline: 2, dbId: 31 }),
        rawReview("me", "PENDING", { dbId: 32 }),
        rawReview("coderabbitai", "COMMENTED", { typename: "Bot", at: "2026-01-02T00:00:00Z", dbId: 33 }),
        rawReview("alice", "APPROVED", { at: "2026-01-01T00:00:00Z", dbId: 34 }),
        rawReview("Me", "DISMISSED", { at: "2026-01-04T00:00:00Z", dbId: 35 }),
      ],
      { viewerLogin: "me" },
    );
    expect(out.map((r) => [r.author.login, r.state])).toEqual([
      ["alice", "APPROVED"],
      ["coderabbitai", "COMMENTED"],
      ["bob", "CHANGES_REQUESTED"],
      ["Me", "DISMISSED"],
    ]);
    expect(out[2]).toEqual({
      id: "PRR_31",
      databaseId: 31,
      author: { login: "bob", bot: false, avatarUrl: "https://a/bob" },
      state: "CHANGES_REQUESTED",
      body: "fix it",
      submittedAt: "2026-01-03T00:00:00Z",
      url: "https://github.com/acme/widgets/pull/7#pullrequestreview-31",
      commentCount: 2,
      isMine: false,
    });
    expect(out[1].author).toMatchObject({ bot: true, botName: "CodeRabbit" });
    expect(out[3].isMine).toBe(true);
  });
});

describe("normalizeConversation", () => {
  it("maps issue comments oldest first, with updatedAt only when edited", () => {
    const out = normalizeConversation(
      [
        rawIssueComment("bob", { at: "2026-01-02T00:00:00Z", dbId: 41 }),
        rawIssueComment("me", { at: "2026-01-01T00:00:00Z", edited: "2026-01-05T00:00:00Z", dbId: 42 }),
      ],
      { viewerLogin: "ME", aiReviewers: ["bob"] },
    );
    expect(out.map((c) => c.id)).toEqual(["IC_42", "IC_41"]);
    expect(out[0]).toMatchObject({ isMine: true, updatedAt: "2026-01-05T00:00:00Z" });
    expect(out[1]).not.toHaveProperty("updatedAt");
    expect(out[1].author.bot).toBe(true);
  });
});

/* ------------------------------------------------------------------ routes */

describe("GET /api/prs/:key/threads", () => {
  it("fetches every page, caches, and applies the configured AI reviewers", async () => {
    gh.threadPageSize = 1;
    gh.threads = [
      rawThread("T1", [rawComment("coderabbitai", { typename: "Bot" })]),
      rawThread("T2", [rawComment("house-ai")]),
    ];
    const put = await app.request("/api/config", { ...json({ aiReviewers: ["House-AI", "house-ai"] }), method: "PUT" });
    expect(put.status).toBe(200);
    expect((await put.json()).aiReviewers).toEqual(["House-AI"]);

    const body = await getThreads();
    expect(body.error).toBeUndefined();
    expect(typeof body.fetchedAt).toBe("string");
    expect(body.threads.map((t: any) => t.id)).toEqual(["T1", "T2"]);
    expect(body.threads[0].comments[0].author).toMatchObject({ bot: true, botName: "CodeRabbit" });
    expect(body.threads[1].comments[0].author).toMatchObject({ login: "house-ai", bot: true });
    expect(fs.existsSync(threadsPath(key, root))).toBe(true);
  });

  it("carries reviews and conversation comments from the same single call, and caches them", async () => {
    gh.threads = [rawThread("T1", [rawComment("bob")])];
    gh.prReviews = [rawReview("bob", "APPROVED", { inline: 1 }), rawReview("reviewer-bot", "PENDING")];
    gh.conversation = [rawIssueComment("coderabbitai", { typename: "Bot", body: "<!-- walkthrough -->hi" })];
    const body = await getThreads();
    expect(gh.calls.filter((c) => c[1] === "graphql")).toHaveLength(1);
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]).toMatchObject({ state: "APPROVED", commentCount: 1, author: { login: "bob" } });
    expect(body.conversation[0]).toMatchObject({ body: "<!-- walkthrough -->hi", author: { botName: "CodeRabbit" } });

    gh.fail("reviewThreads", "HTTP 502 Bad Gateway");
    const cached = await getThreads();
    expect(cached.error).toBeTruthy();
    expect(cached.reviews).toEqual(body.reviews);
    expect(cached.conversation).toEqual(body.conversation);
  });

  it("reads a cache written before reviews were fetched, defaulting them to empty", async () => {
    const file = threadsPath(key, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ threads: [], fetchedAt: "2026-01-01T00:00:00Z" }));
    gh.fail("reviewThreads", "HTTP 502 Bad Gateway");
    const body = await getThreads();
    expect(body).toMatchObject({ threads: [], reviews: [], conversation: [], fetchedAt: "2026-01-01T00:00:00Z" });
  });

  it("serves the cached copy with an error when gh fails, relinking local comments", async () => {
    gh.threads = [rawThread("T1", [rawComment("me", { dbId: 900 })])];
    const first = await getThreads();

    // A push since the fetch: the remote comment now mirrors a local one.
    writeComments(
      key,
      [
        {
          id: "loc",
          file: "src/foo.ts",
          subjectType: "line",
          line: 2,
          side: "RIGHT",
          body: "x",
          createdAt: "t",
          status: "pushed",
          githubCommentId: 900,
        },
      ],
      root,
    );
    gh.fail("reviewThreads", "HTTP 502 Bad Gateway");
    const body = await getThreads();
    expect(body.error).toMatch(/Bad Gateway/);
    expect(body.fetchedAt).toBe(first.fetchedAt);
    expect(body.threads[0].comments[0].localId).toBe("loc");
  });

  it("returns no threads and an error when gh fails and nothing is cached", async () => {
    gh.fail("reviewThreads", "HTTP 502 Bad Gateway");
    const body = await getThreads();
    expect(body.threads).toEqual([]);
    expect(body.reviews).toEqual([]);
    expect(body.conversation).toEqual([]);
    expect(body.fetchedAt).toBeUndefined();
    expect(body.error).toBeTruthy();
  });

  it("404s for a PR that isn't tracked", async () => {
    const other = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/999`);
    const res = await app.request(`/api/prs/${other}/threads`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/prs/:key/threads/:id/resolve | unresolve", () => {
  it("resolves and unresolves, patching the cache", async () => {
    gh.threads = [rawThread("T1", [rawComment("bob")])];
    await getThreads();

    const res = await app.request(`/api/prs/${encodedKey}/threads/T1/resolve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      thread: { id: "T1", isResolved: true, resolvedBy: gh.login, viewerCanResolve: false, viewerCanUnresolve: true },
    });
    const cached = JSON.parse(fs.readFileSync(threadsPath(key, root), "utf8"));
    expect(cached.threads[0]).toMatchObject({ isResolved: true, resolvedBy: gh.login });

    const un = await app.request(`/api/prs/${encodedKey}/threads/T1/unresolve`, { method: "POST" });
    expect((await un.json()).thread).toEqual({
      id: "T1",
      isResolved: false,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
    });
    const recached = JSON.parse(fs.readFileSync(threadsPath(key, root), "utf8"));
    expect(recached.threads[0].isResolved).toBe(false);
    expect(recached.threads[0].resolvedBy).toBeUndefined();
  });

  it("maps an unknown thread to 404 and a gh failure to 502", async () => {
    const missing = await app.request(`/api/prs/${encodedKey}/threads/NOPE/resolve`, { method: "POST" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("thread_not_found");

    gh.threads = [rawThread("T1", [rawComment("bob")])];
    gh.fail("resolveReviewThread", "HTTP 502 Bad Gateway");
    const failed = await app.request(`/api/prs/${encodedKey}/threads/T1/resolve`, { method: "POST" });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("gh_failed");
  });
});

/* ----------------------------------------------------------------- replies */

describe("replies", () => {
  const addReply = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(`/api/prs/${encodedKey}/comments`, json(body, headers));

  it("skips the outside-the-diff check for a reply, even from the CLI", async () => {
    const CHAT = { "X-Purview-Actor": "chat" };
    const plain = await addReply({ file: "src/foo.ts", line: 999, side: "RIGHT", body: "x" }, CHAT);
    expect(plain.status).toBe(422);
    const reply = await addReply(
      { file: "src/foo.ts", line: 999, side: "RIGHT", body: "agreed", inReplyTo: "T1" },
      CHAT,
    );
    expect(reply.status).toBe(201);
    expect((await reply.json()).comment).toMatchObject({ inReplyTo: "T1", status: "draft" });
  });

  it("leaves a reply out of re-anchoring and the push pre-flight", async () => {
    gh.threads = [rawThread("T1", [rawComment("bob")], { line: null, originalLine: 999, isOutdated: true })];
    const res = await addReply({ file: "src/foo.ts", line: 999, side: "RIGHT", body: "on an outdated line", inReplyTo: "T1" });
    expect(res.status).toBe(201);
    const id = (await res.json()).comment.id;

    const sync = await (await app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" })).json();
    expect(sync.comments.ok).toBe(true);
    expect(readComments(key, root).find((c) => c.id === id)!.line).toBe(999);

    const reanchor = await app.request(`/api/prs/${encodedKey}/comments/${id}/reanchor`, { method: "POST" });
    expect(reanchor.status).toBe(400);
  });

  it("pushes a reply into a newly created pending review, after the line drafts", async () => {
    gh.threads = [rawThread("T1", [rawComment("bob")])];
    await addReply({ file: "src/foo.ts", line: 2, side: "RIGHT", body: "new thread" });
    const r = await addReply({ file: "src/foo.ts", line: 2, side: "RIGHT", body: "a reply", inReplyTo: "T1" });
    const replyId = (await r.json()).comment.id;

    const sync = await (await app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" })).json();
    expect(sync.comments).toMatchObject({ ok: true, pushed: 2, mode: "created" });
    // Only the new thread rode in the REST create payload.
    expect((gh.createReviewPayloads()[0].comments as unknown[]).length).toBe(1);
    expect(gh.replies).toEqual([
      { threadId: "T1", reviewId: gh.reviews[0].node_id, body: "a reply", id: expect.any(Number) },
    ]);
    const stored = readComments(key, root).find((c) => c.id === replyId)!;
    expect(stored).toMatchObject({
      status: "pushed",
      githubThreadId: "T1",
      inReplyTo: "T1",
      githubCommentId: gh.replies[0].id,
      githubCommentNodeId: `PRRC_${gh.replies[0].id}`,
    });
  });

  it("appends a reply to an existing pending review", async () => {
    await addReply({ file: "src/foo.ts", line: 2, side: "RIGHT", body: "first" });
    await app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" });
    await addReply({ subjectType: "file", file: "src/foo.ts", body: "file reply", inReplyTo: "T9" });

    const sync = await (await app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" })).json();
    expect(sync.comments).toMatchObject({ ok: true, pushed: 1, mode: "appended" });
    expect(gh.replies.map((r) => r.threadId)).toEqual(["T9"]);
    // No new thread was opened for it.
    const newThreads = gh.calls.filter(
      (c) => c[1] === "graphql" && c.some((a) => /addPullRequestReviewThread\(/.test(a)),
    );
    expect(newThreads).toHaveLength(0);
  });
});
