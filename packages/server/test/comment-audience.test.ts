import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commentsPath, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import {
  CommentNotDraftError,
  addComment,
  commentCounts,
  readComments,
  setCommentAudience,
  unanchoredDraftLineComments,
  writeComments,
} from "../src/comments.js";
import { writeConfig } from "../src/config.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

/**
 * Who a comment is for. `github` comments are the review (draft → pushed →
 * submitted); `agent` comments are notes for a coding agent that never
 * leave the machine, whatever a sync or a submit does.
 */

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-audience-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  gh = fakeGh();
  gh.install();
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const commentsUrl = (rest = "") => `/api/prs/${encodedKey}/comments${rest}`;

async function create(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await req("POST", commentsUrl(), { file: "src/foo.ts", line: 2, side: "RIGHT", body: "note", ...extra }, headers);
  expect(res.status).toBe(201);
  return (await res.json()).comment as { id: string; status: string; audience: string };
}

/* ------------------------------------------------------------------- model */

describe("comment audience (model)", () => {
  it("defaults to github, takes an explicit value, and reads older files as github", () => {
    const a = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "a" }, root);
    const b = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "b", audience: "agent" }, root);
    const c = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "c" }, root, "you", "agent");
    expect(a.audience).toBe("github");
    expect(b.audience).toBe("agent");
    expect(c.audience).toBe("agent");

    // A comments.json from before audiences carries no field at all.
    const file = commentsPath(key, root);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw[0].audience;
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(readComments(key, root)[0].audience).toBe("github");
  });

  it("counts github drafts and agent notes apart", () => {
    addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "a" }, root);
    addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "b", audience: "agent" }, root);
    expect(commentCounts(readComments(key, root))).toEqual({ draft: 1, pushed: 0, submitted: 0, agent: 1 });
  });

  it("moves only drafts", () => {
    const a = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "a" }, root);
    expect(setCommentAudience(key, a.id, "agent", root)?.audience).toBe("agent");
    expect(setCommentAudience(key, a.id, "agent", root)?.audience).toBe("agent"); // no-op
    expect(setCommentAudience(key, "nope", "agent", root)).toBeNull();
    writeComments(key, readComments(key, root).map((c) => ({ ...c, audience: "github" as const, status: "pushed" as const })), root);
    expect(() => setCommentAudience(key, a.id, "agent", root)).toThrow(CommentNotDraftError);
  });

  it("an agent note outside the diff is not a sync blocker", () => {
    addComment(key, { file: "src/foo.ts", line: 999, side: "RIGHT", body: "slid", audience: "agent" }, root);
    expect(unanchoredDraftLineComments(key, root)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ routes */

describe("comment audience (routes)", () => {
  it("new comments follow the global switch unless told otherwise", async () => {
    expect((await create()).audience).toBe("github");
    writeConfig({ commentAudience: "agent" }, root);
    expect((await create()).audience).toBe("agent");
    expect((await create({ audience: "github" })).audience).toBe("github");
    // The chat follows the switch too.
    expect((await create({}, { "X-Purview-Actor": "chat" })).audience).toBe("agent");
  });

  it("the switch round-trips through /api/config", async () => {
    const put = await req("PUT", "/api/config", { commentAudience: "agent" });
    expect((await put.json()).commentAudience).toBe("agent");
    expect((await (await req("GET", "/api/config")).json()).commentAudience).toBe("agent");
    const bad = await req("PUT", "/api/config", { commentAudience: "me" });
    expect(bad.status).toBe(400);
  });

  it("PATCH { audience } moves a draft, alone or with a body, and refuses a pushed one", async () => {
    const c = await create();
    const alone = await req("PATCH", commentsUrl(`/${c.id}`), { audience: "agent" });
    expect(alone.status).toBe(200);
    expect(await alone.json()).toMatchObject({ comment: { audience: "agent", body: "note" }, remote: null });

    const withBody = await req("PATCH", commentsUrl(`/${c.id}`), { audience: "github", body: "edited" });
    expect(await withBody.json()).toMatchObject({ comment: { audience: "github", body: "edited" } });

    expect((await req("PATCH", commentsUrl(`/${c.id}`), { audience: "nope" })).status).toBe(400);

    writeComments(key, readComments(key, root).map((x) => ({ ...x, status: "pushed" as const })), root);
    const pushed = await req("PATCH", commentsUrl(`/${c.id}`), { audience: "agent" });
    expect(pushed.status).toBe(400);
    expect((await pushed.json()).error ?? (await pushed.json())).toBeTruthy();
  });

  it("sync pushes github drafts and leaves agent notes on the machine", async () => {
    await create({ body: "for the review" });
    const note = await create({ body: "for the agent", audience: "agent" });
    const res = await (await req("POST", `/api/prs/${encodedKey}/sync`)).json();
    expect(res.comments.ok).toBe(true);
    expect(res.comments.pushed).toBe(1);
    expect(res.comments.counts).toEqual({ draft: 0, pushed: 1, submitted: 0, agent: 1 });
    const after = readComments(key, root);
    expect(after.find((c) => c.id === note.id)).toMatchObject({ status: "draft", audience: "agent" });
    expect(gh.createReviewPayloads()[0].comments).toHaveLength(1);
  });

  it("the review's included list and a submit leave agent notes out", async () => {
    await create({ body: "for the review" });
    const note = await create({ body: "for the agent", audience: "agent" });
    const status = await (await req("GET", `/api/prs/${encodedKey}/review`)).json();
    expect(status.comments.included.map((c: { body: string }) => c.body)).toEqual(["for the review"]);
    expect(status.comments.counts).toEqual({ draft: 1, pushed: 0, submitted: 0, agent: 1 });

    const submit = await req("POST", `/api/prs/${encodedKey}/review/submit`, { event: "COMMENT", confirm: true });
    expect(submit.status).toBe(200);
    expect((await submit.json()).commentCount).toBe(1);
    expect(readComments(key, root).find((c) => c.id === note.id)).toMatchObject({ status: "draft", audience: "agent" });
  });
});

/* ----------------------------------------------------------------- publish */

describe("POST /api/prs/:key/comments/:id/publish", () => {
  const publish = (id: string, body: unknown = { confirm: true }, headers = {}) =>
    req("POST", commentsUrl(`/${id}/publish`), body, headers);

  it("posts one draft as a standalone public comment and marks it submitted", async () => {
    const c = await create({ body: "ship it", startLine: 1, line: 3 });
    const res = await publish(c.id);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.url).toMatch(/discussion_r\d+/);
    expect(out.comment).toMatchObject({ status: "submitted", audience: "github", githubCommentId: 5000, githubCommentNodeId: "PRRC_5000" });
    expect(out.comment.submittedAt).toBeTruthy();
    expect(gh.published).toHaveLength(1);
    expect(gh.published[0]).toMatchObject({ commit_id: "head1", path: "src/foo.ts", line: 3, side: "RIGHT", start_line: 1, start_side: "RIGHT", body: "ship it" });
    expect(gh.createReviewCalls()).toBe(0);
    expect(readComments(key, root)[0].status).toBe("submitted");
  });

  it("sends a file-level draft with subject_type: file", async () => {
    const res = await req("POST", commentsUrl(), { file: "src/foo.ts", body: "whole file" });
    const c = (await res.json()).comment;
    expect((await publish(c.id)).status).toBe(200);
    expect(gh.published[0]).toMatchObject({ path: "src/foo.ts", subject_type: "file", body: "whole file" });
    expect(gh.published[0].line).toBeUndefined();
  });

  it("asks for confirmation, and names each refusal", async () => {
    const c = await create();
    expect((await publish(c.id, {})).status).toBe(400);
    expect((await (await publish(c.id, {})).json()).error).toBe("confirmation_required");
    expect((await publish("nope")).status).toBe(404);

    const note = await create({ audience: "agent" });
    const agent = await publish(note.id);
    expect(agent.status).toBe(400);
    expect((await agent.json()).error).toBe("agent_comment");

    const chat = await publish(c.id, { confirm: true }, { "X-Purview-Actor": "chat" });
    expect(chat.status).toBe(409);

    const slid = await create({ line: 999 });
    const outside = await publish(slid.id);
    expect(outside.status).toBe(422);
    expect((await outside.json()).error).toBe("comment_outside_diff");

    await publish(c.id);
    const again = await publish(c.id);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("not_draft");
    expect(gh.published).toHaveLength(1);
  });

  it("a reply cannot go out on its own", async () => {
    const c = await create({ inReplyTo: "PRRT_1" });
    const res = await publish(c.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("reply_not_publishable");
  });
});
