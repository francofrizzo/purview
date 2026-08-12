import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEvents, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { readComments } from "../src/comments.js";
import { readReviewDraft } from "../src/review-store.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-review-test-"));
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

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function addDraft(body: string, line = 2) {
  const res = await app.request(`/api/prs/${encodedKey}/comments`, {
    ...json({ file: "src/foo.ts", line, side: "RIGHT", body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).comment as { id: string; status: string };
}

const sync = () => app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" });

const submit = (body: unknown) =>
  app.request(`/api/prs/${encodedKey}/review/submit`, { ...json(body) });

/* ------------------------------------------------------------ reconciliation */

describe("pending-review reconciliation", () => {
  it("creates a pending review on the first sync and appends to it on the second", async () => {
    await addDraft("first", 2);
    const first = await (await sync()).json();
    expect(first.comments.ok).toBe(true);
    expect(first.comments.pushed).toBe(1);
    expect(first.comments.mode).toBe("created");
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0].state).toBe("PENDING");

    await addDraft("second", 11);
    const second = await (await sync()).json();
    expect(second.comments.ok).toBe(true);
    expect(second.comments.pushed).toBe(1);
    expect(second.comments.mode).toBe("appended");

    // The whole point: no second review was created.
    expect(gh.createReviewCalls()).toBe(1);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0].comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("persists both ids of the pending review into review.json", async () => {
    await addDraft("hello");
    await sync();
    const draft = readReviewDraft(key, root);
    expect(draft.pendingReviewDatabaseId).toBe(gh.reviews[0].id);
    expect(draft.pendingReviewId).toBe(gh.reviews[0].node_id);
    expect(draft.lastSyncedAt).toBeTruthy();
  });

  it("forgets a pending review that disappeared out of band", async () => {
    await addDraft("hello");
    await sync();
    gh.reviews.length = 0;
    await sync();
    expect(readReviewDraft(key, root).pendingReviewId).toBeUndefined();
  });
});

/* ---------------------------------------------------------- comment statuses */

describe("comment status transitions", () => {
  it("goes draft -> pushed -> submitted and records the GitHub comment id", async () => {
    const created = await addDraft("look here");
    expect(created.status).toBe("draft");

    await sync();
    let stored = readComments(key, root);
    expect(stored[0].status).toBe("pushed");
    expect(stored[0].githubCommentId).toBe(gh.reviews[0].comments[0].id);

    const res = await submit({ event: "COMMENT", body: "done", confirm: true });
    expect(res.status).toBe(200);
    stored = readComments(key, root);
    expect(stored[0].status).toBe("submitted");
    expect(stored[0].submittedAt).toBeTruthy();
  });

  it("migrates a legacy `submitted` status (no submittedAt) to `pushed` on read", () => {
    const file = path.join(root, key.host, key.owner, key.repo, String(key.number), "comments.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: "legacy-1",
          file: "src/foo.ts",
          line: 2,
          side: "RIGHT",
          body: "old",
          createdAt: new Date().toISOString(),
          status: "submitted",
        },
      ]),
    );
    expect(readComments(key, root)[0].status).toBe("pushed");
  });

  it("best-effort deletes a pushed comment on GitHub and never fails the request", async () => {
    const created = await addDraft("remove me");
    await sync();
    const remoteId = readComments(key, root)[0].githubCommentId!;

    const ok = await app.request(`/api/prs/${encodedKey}/comments/${created.id}`, {
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, remote: { attempted: true, ok: true } });
    expect(gh.deletedCommentIds).toEqual([remoteId]);
    expect(readComments(key, root)).toHaveLength(0);
  });

  it("still removes the comment locally when the GitHub delete errors", async () => {
    const created = await addDraft("remove me");
    await sync();
    gh.fail("/pulls/comments/", "HTTP 404 Not Found");

    const res = await app.request(`/api/prs/${encodedKey}/comments/${created.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.remote.ok).toBe(false);
    expect(readComments(key, root)).toHaveLength(0);
  });
});

/* ------------------------------------------------------ PATCH comment body */

const patchComment = (id: string, body: unknown) =>
  app.request(`/api/prs/${encodedKey}/comments/${id}`, { ...json(body), method: "PATCH" });

describe("PATCH /api/prs/:key/comments/:id", () => {
  it("edits a draft comment locally with no gh calls", async () => {
    const created = await addDraft("original");
    const callsBefore = gh.calls.length;

    const res = await patchComment(created.id, { body: "updated" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.body).toBe("updated");
    expect(body.comment.updatedAt).toBeTruthy();
    expect(body.remote).toBeNull();
    expect(gh.calls.length).toBe(callsBefore);
    expect(readComments(key, root)[0].body).toBe("updated");
  });

  it("edits a pushed comment locally and mirrors it via GraphQL using the node id, not the databaseId", async () => {
    const created = await addDraft("original");
    await sync();
    const stored = readComments(key, root)[0];
    const nodeId = stored.githubCommentNodeId!;
    const databaseId = stored.githubCommentId!;
    // The two ids must actually differ in shape for this test to mean
    // anything (see FakeReviewComment.node_id in fake-gh.ts).
    expect(nodeId).not.toBe(String(databaseId));

    const res = await patchComment(created.id, { body: "revised" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remote).toEqual({ ok: true });
    expect(readComments(key, root)[0].body).toBe("revised");
    expect(gh.reviews[0].comments[0].body).toBe("revised");

    const mutationCall = gh.calls.find((c) =>
      c.some((a) => a.includes("updatePullRequestReviewComment")),
    );
    expect(mutationCall).toBeTruthy();
    expect(mutationCall).toContain(`commentId=${nodeId}`);
    expect(mutationCall).not.toContain(`commentId=${databaseId}`);
    expect(mutationCall).toContain("body=revised");
  });

  it("recovers a missing node id via a read-only lookup and mirrors the edit remotely", async () => {
    const created = await addDraft("original");
    await sync();

    // Simulate the backfill gap for the node id specifically (e.g. the
    // create-response scrape found the databaseId but not the node id).
    // The databaseId stays on record, so recovery via listReviewComments
    // (a GET, never a write) should be able to fill it back in.
    const file = path.join(root, key.host, key.owner, key.repo, String(key.number), "comments.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedNodeId = stored[0].githubCommentNodeId;
    delete stored[0].githubCommentNodeId;
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(readComments(key, root)[0].githubCommentNodeId).toBeUndefined();

    const res = await patchComment(created.id, { body: "revised" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remote).toEqual({ ok: true });
    expect(body.comment.githubCommentNodeId).toBe(expectedNodeId);
    // The recovered id is persisted for next time.
    expect(readComments(key, root)[0].githubCommentNodeId).toBe(expectedNodeId);
    expect(gh.reviews[0].comments[0].body).toBe("revised");
  });

  it("saves locally and reports a structured remote failure when no id can be recovered", async () => {
    const created = await addDraft("original");
    await sync();

    // Simulate a total backfill failure: neither id is on record, so there
    // is nothing to look up and nothing to recover.
    const file = path.join(root, key.host, key.owner, key.repo, String(key.number), "comments.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    delete stored[0].githubCommentId;
    delete stored[0].githubCommentNodeId;
    fs.writeFileSync(file, JSON.stringify(stored));

    const res = await patchComment(created.id, { body: "revised" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remote.ok).toBe(false);
    expect(body.remote.reason).toBeTruthy();
    expect(readComments(key, root)[0].body).toBe("revised");
  });

  it("400s editing a submitted comment without confirm", async () => {
    const created = await addDraft("original");
    await sync();
    await submit({ event: "COMMENT", body: "done", confirm: true });
    expect(readComments(key, root)[0].status).toBe("submitted");

    const res = await patchComment(created.id, { body: "revised" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirm_required_public_edit");
    expect(readComments(key, root)[0].body).toBe("original");
  });

  it("edits a submitted comment remotely once confirmed", async () => {
    const created = await addDraft("original");
    await sync();
    await submit({ event: "COMMENT", body: "done", confirm: true });

    const res = await patchComment(created.id, { body: "revised", confirm: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remote).toEqual({ ok: true });
    expect(readComments(key, root)[0].body).toBe("revised");
  });

  it("400s an empty or whitespace-only body", async () => {
    const created = await addDraft("original");
    const res = await patchComment(created.id, { body: "   " });
    expect(res.status).toBe(400);
    expect(readComments(key, root)[0].body).toBe("original");
  });

  it("404s an unknown comment id", async () => {
    const res = await patchComment("nope", { body: "x" });
    expect(res.status).toBe(404);
  });

  it("no-ops an unchanged body without any gh call, even on a submitted comment", async () => {
    const created = await addDraft("original");
    await sync();
    await submit({ event: "COMMENT", body: "done", confirm: true });
    const callsBefore = gh.calls.length;

    const res = await patchComment(created.id, { body: "original" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remote).toBeNull();
    expect(gh.calls.length).toBe(callsBefore);
  });
});

/* ------------------------------------------------------------------- review */

describe("GET/POST /api/prs/:key/review", () => {
  it("reports the local draft, remote pending status, counts and readiness", async () => {
    await app.request(`/api/prs/${encodedKey}/review`, { ...json({ body: "Looks good overall" }) });
    await addDraft("nit");

    const res = await app.request(`/api/prs/${encodedKey}/review`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.body).toBe("Looks good overall");
    expect(body.comments.counts).toEqual({ draft: 1, pushed: 0, submitted: 0 });
    expect(body.comments.included).toHaveLength(1);
    expect(body.pending).toMatchObject({ known: true, exists: false });
    // The fixture has one must-read unit with two unviewed hunks.
    expect(body.readiness.mustRead.total).toBe(1);
    expect(body.readiness.mustRead.unviewed).toBe(1);
    expect(body.readiness.ready).toBe(false);
  });

  it("rejects a review body that is not a string", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/review`, { ...json({ body: 42 }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/prs/:key/review/submit", () => {
  it.each(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const)(
    "submits with event %s",
    async (event) => {
      await addDraft("nit");
      const res = await submit({ event, body: `verdict: ${event}`, confirm: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.event).toBe(event);
      expect(body.url).toContain("pullrequestreview-");
      expect(body.commentCount).toBe(1);
      expect(gh.reviews[0].state).toBe(event === "APPROVE" ? "APPROVED" : event);
      expect(readReviewDraft(key, root).submittedEvent).toBe(event);
      expect(readReviewDraft(key, root).pendingReviewDatabaseId).toBeUndefined();
    },
  );

  it("400s without confirm:true and posts nothing", async () => {
    await addDraft("nit");
    const res = await submit({ event: "APPROVE", body: "yes" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirmation_required");
    expect(gh.reviews).toHaveLength(0);
    expect(readComments(key, root)[0].status).toBe("draft");
  });

  it("400s for an unknown event", async () => {
    const res = await submit({ event: "LGTM", confirm: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_event");
  });

  it("creates and submits in one call when there is nothing pending and no comments", async () => {
    const res = await submit({ event: "COMMENT", body: "just a note", confirm: true });
    expect(res.status).toBe(200);
    expect(gh.createReviewCalls()).toBe(1);
    expect(gh.reviews[0].state).toBe("COMMENT");
    expect(gh.reviews[0].commit_id).toBe("head1");
  });

  it("surfaces approving your own PR as a clean JSON error", async () => {
    gh.login = "pr-author";
    const res = await submit({ event: "APPROVE", body: "lgtm", confirm: true });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("cannot_approve_own_pr");
    expect(body.detail).toMatch(/own pull request/i);
  });

  it("surfaces a stale commit_id after a force-push", async () => {
    // `--input` only appears on the write calls, so the pending-review lookup
    // still succeeds and it is the create-and-submit that fails.
    gh.fail(
      "--input",
      "HTTP 422 Unprocessable Entity: Validation Failed: commit_id is not part of the pull request",
    );
    const res = await submit({ event: "COMMENT", body: "note", confirm: true });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("stale_commit_id");
  });

  it("surfaces a comment anchored to a line that left the diff", async () => {
    await addDraft("first");
    await sync(); // creates the pending review
    await addDraft("stale anchor", 999);
    gh.fail("graphql", "HTTP 422: line must be part of the diff");

    const res = await submit({ event: "COMMENT", body: "note", confirm: true });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("comment_line_not_in_diff");
    // Nothing was submitted: the review is still pending.
    expect(gh.reviews[0].state).toBe("PENDING");
  });

  it("recovers when the pending review was deleted between the lookup and the submit", async () => {
    await addDraft("nit");
    await sync();
    expect(gh.reviews).toHaveLength(1);

    // The submit 404s and the review is genuinely gone; the retry must
    // create-and-submit rather than surface the 404.
    gh.fail("/events", "HTTP 404 Not Found", true, () => {
      gh.reviews.length = 0;
    });

    const res = await submit({ event: "COMMENT", body: "retried", confirm: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0].state).toBe("COMMENT");
    // The draft was re-pushed into the new review rather than being lost.
    expect(gh.reviews[0].comments.map((c) => c.body)).toEqual(["nit"]);
    expect(readComments(key, root)[0].status).toBe("submitted");
  });

  it("appends a review-submitted event to the log", async () => {
    await addDraft("nit");
    await submit({ event: "REQUEST_CHANGES", body: "please fix", confirm: true });

    const events = readEvents(key, root);
    const submitted = events.filter((e) => e.type === "review-submitted");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ event: "REQUEST_CHANGES", commentCount: 1 });
    expect((submitted[0] as { url?: string }).url).toContain("pullrequestreview-");

    const state = await (await app.request(`/api/prs/${encodedKey}`)).json();
    expect(state.state.reviewSubmissions).toHaveLength(1);
    expect(state.state.reviewSubmissions[0].event).toBe("REQUEST_CHANGES");
    expect(state.state.reviewSubmissions[0].revision).toBe(1);
  });
});

describe("DELETE /api/prs/:key/review/pending", () => {
  it("discards the pending review and resets pushed comments to draft", async () => {
    await addDraft("nit");
    await sync();
    expect(gh.reviews).toHaveLength(1);
    expect(readComments(key, root)[0].status).toBe("pushed");

    const res = await app.request(`/api/prs/${encodedKey}/review/pending`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, discarded: true, resetToDraft: 1 });
    expect(gh.reviews).toHaveLength(0);

    const stored = readComments(key, root)[0];
    expect(stored.status).toBe("draft");
    expect(stored.githubCommentId).toBeUndefined();
    expect(readReviewDraft(key, root).pendingReviewId).toBeUndefined();
  });

  it("is a no-op when there is nothing pending", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/review/pending`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ discarded: false, resetToDraft: 0 });
  });

  it("treats an already-deleted pending review as success", async () => {
    await addDraft("nit");
    await sync();
    gh.fail("--method DELETE", "HTTP 404 Not Found");
    const res = await app.request(`/api/prs/${encodedKey}/review/pending`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(readComments(key, root)[0].status).toBe("draft");
  });
});
