import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  analysisCoverage,
  hunkDiffOfDiffs,
  initPr,
  keyToString,
  listPrs,
  loadState,
  parseKey,
  readDiff,
  readFilesJson,
  readMeta,
  readMigrationReport,
  refreshPr,
  setHunkViewed,
  setUnit,
  setUnitViewed,
  stateRoot,
  syncPr,
  unitProgress,
  type Hunk,
  type PrKey,
  type State,
} from "@reviewer/core";
import {
  addComment,
  deleteComment,
  readComments,
  setCommentNodeId,
  updateCommentBody,
} from "./comments.js";
import { recoverCommentNodeId, syncCommentsToGithub } from "./comment-sync.js";
import {
  SUBMIT_EVENTS,
  discardPendingReview,
  reviewStatus,
  saveReviewBody,
  submitReview,
} from "./review.js";
import {
  classifyGhReviewError,
  updatePullRequestReviewCommentBody,
  type SubmitEvent,
} from "./github-review.js";
import { HttpError, classifyError } from "./http-error.js";
import { streamSSE } from "hono/streaming";
import {
  cancelAnalysis,
  jobEvents,
  readJob,
  reconcileStaleJobs,
  startAnalysis,
} from "./analysis.js";
import { chatBusy, startChatTurn, type ChatStreamEvent } from "./chat-session.js";
import { ChatRefSchema, clearChat, readChat } from "./chat.js";
import { prHead, setRepoPath } from "./repo-path.js";
import { resolveCheckout } from "./worktree.js";
import { localOnlyGuard } from "./security.js";

export const DEFAULT_PORT = 4779;

export interface AppOptions {
  /** Overrides @reviewer/core's REVIEWER_STATE_DIR-based default; mainly for tests. */
  stateDir?: string;
  /** Directory to serve statically at `/`; defaults to ../../web/dist relative to this file. */
  webDist?: string;
  /** Skip the automatic Claude analysis triggers (tests, and `--no-analyze` runs). */
  autoAnalyze?: boolean;
  /** Timeout handed to analysis runs; tests shorten it. */
  analysisTimeoutMs?: number;
  /** The port we are listening on — the Host/Origin guard validates against it. */
  port?: number;
  /** Extra origins the guard accepts (Vite dev proxy); see config.ts. */
  devOrigins?: string[];
}

function keyParam(c: { req: { param(name: string): string | undefined } }): PrKey {
  const raw = c.req.param("key");
  if (!raw) throw new HttpError(400, "missing_key", "PR key is required");
  try {
    return parseKey(raw);
  } catch (err) {
    throw classifyError(err);
  }
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function progressOf(state: State) {
  const units = unitProgress(state);
  const hunkTotal = Object.keys(state.hunks).length;
  const hunkViewed = Object.values(state.hunks).filter((h) => h.viewed).length;
  return {
    hunks: { viewed: hunkViewed, total: hunkTotal },
    units: {
      complete: units.filter((u) => u.complete).length,
      total: units.length,
    },
    files: {
      viewed: state.files.filter((f) => f.viewed).length,
      total: state.files.length,
    },
  };
}

export function createApp(opts: AppOptions = {}): Hono {
  const app = new Hono();
  const root = opts.stateDir ?? stateRoot();
  const autoAnalyze = opts.autoAnalyze ?? true;
  // A "running" job record can only be stale at boot — nothing is running yet.
  reconcileStaleJobs(root);

  /** `?analyze=false` opts a single init/refresh out of the automatic run. */
  const analyzeRequested = (c: { req: { query(k: string): string | undefined } }) =>
    autoAnalyze && c.req.query("analyze") !== "false";

  /** Auto-triggers are best-effort: a failed spawn must not fail the request. */
  const triggerAnalysis = (key: PrKey) => {
    try {
      return startAnalysis(key, root, { timeoutMs: opts.analysisTimeoutMs });
    } catch (err) {
      console.warn(`[analysis] not started for ${keyToString(key)}: ${(err as Error).message}`);
      return null;
    }
  };
  const webDist =
    opts.webDist ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../../web/dist");

  // No CORS middleware at all: the UI is served from this same origin, so it
  // needs none, and emitting none is what stops a foreign page from reading any
  // response. What replaces it is a Host + Origin guard — see security.ts for
  // why CORS alone was never enough (it gates reads, not requests).
  app.use(
    "/api/*",
    localOnlyGuard({
      port: opts.port ?? DEFAULT_PORT,
      devOrigins: opts.devOrigins,
    }),
  );

  app.onError((err, c) => {
    const httpErr = classifyError(err);
    return c.json({ error: httpErr.message, detail: httpErr.detail }, httpErr.status as 400);
  });

  /* -------------------------------------------------------------- PR list */

  app.get("/api/prs", (c) => {
    const keys = listPrs(root);
    const prs = keys.map((key) => {
      const meta = readMeta(key, root);
      const state = loadState(key, root);
      return {
        key: keyToString(key),
        meta,
        currentRevision: state.currentRevision,
        summary: state.summary,
        progress: progressOf(state),
        analysisJob: readJob(key, root),
      };
    });
    return c.json({ prs });
  });

  app.post("/api/prs", async (c) => {
    const body = (await readJsonBody(c)) as { url?: string };
    if (!body.url) throw new HttpError(400, "missing_url", "Body must include { url }");
    let key: PrKey;
    try {
      key = parseKey(body.url);
    } catch (err) {
      throw classifyError(err);
    }
    const result = initPr(key, root);
    // A freshly tracked PR has no analysis at all, so init always kicks one
    // off (unless the caller opted out with ?analyze=false).
    const job = analyzeRequested(c) ? triggerAnalysis(key) : null;
    return c.json({
      key: keyToString(result.key),
      created: result.created,
      revision: result.revision,
      state: result.state,
      analysisJob: job,
    });
  });

  /* -------------------------------------------------------------- one PR */

  app.post("/api/prs/:key/refresh", (c) => {
    const key = keyParam(c);
    const result = refreshPr(key, root);
    // Re-analyzing costs real money and time, so a refresh only triggers one
    // when the migration actually left work to do: hunks the existing analysis
    // cannot already account for.
    const hasNewWork =
      !!result.report &&
      (result.report.counts.new > 0 ||
        loadState(key, root).unassignedHunkIds.length > 0);
    const job = analyzeRequested(c) && hasNewWork ? triggerAnalysis(key) : null;
    return c.json({
      key: keyToString(key),
      revision: result.revision,
      added: result.added,
      baseOnly: result.baseOnly,
      report: result.report ?? null,
      state: result.state,
      analysisJob: job,
    });
  });

  app.get("/api/prs/:key", (c) => {
    const key = keyParam(c);
    const meta = readMeta(key, root);
    const state = loadState(key, root);
    const filesJson = readFilesJson(key, state.currentRevision, root);
    const diff = readDiff(key, state.currentRevision, root);
    // Resolving here is what makes a stale checkout visible in the UI without
    // waiting for a run to say so; it is additive, so a client that predates
    // the field is unaffected.
    const checkout = resolveCheckout(meta.repoPath, prHead(key, root));
    return c.json({
      state,
      files: filesJson.files,
      diff,
      meta,
      analysisJob: readJob(key, root),
      checkoutMismatch: checkout.mismatch ?? null,
    });
  });

  /* ------------------------------------------------- Claude: analysis job */

  app.get("/api/prs/:key/analysis-job", (c) => {
    const key = keyParam(c);
    readMeta(key, root); // 404s for an unknown PR instead of reporting "no job"
    return c.json({ job: readJob(key, root) });
  });

  app.post("/api/prs/:key/analyze", (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    return c.json({ job: startAnalysis(key, root, { timeoutMs: opts.analysisTimeoutMs }) });
  });

  app.delete("/api/prs/:key/analyze", (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    return c.json({ job: cancelAnalysis(key, root) });
  });

  app.post("/api/prs/:key/repo-path", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const body = (await readJsonBody(c)) as { path?: unknown };
    const result = setRepoPath(key, body.path, root);
    return c.json({
      ok: true,
      path: result.path,
      warning: result.warning,
      checkoutMismatch: result.checkoutMismatch ?? null,
    });
  });

  /**
   * Server-sent job transitions. One stream per PR view; the UI does not have
   * to poll to watch an analysis run.
   */
  app.get("/api/prs/:key/events", (c) => {
    const key = keyParam(c);
    const keyStr = keyToString(key);
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const onJob = (payload: { key: PrKey; job: unknown }) => {
        if (keyToString(payload.key) !== keyStr) return;
        queue.push(JSON.stringify({ type: "analysis-job", job: payload.job }));
        wake?.();
        wake = null;
      };
      // Subscribe before the first write: a transition landing during that
      // write would otherwise fall in the gap and never reach the client.
      jobEvents.on("job", onJob);
      await stream.writeSSE({
        event: "analysis-job",
        data: JSON.stringify({ type: "analysis-job", job: readJob(key, root) }),
      });

      try {
        while (!closed) {
          if (queue.length === 0) {
            // Heartbeat doubles as the "is anyone still there" probe: writing
            // to a dead socket is what surfaces the disconnect.
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
            ]);
            if (closed) break;
            if (queue.length === 0) {
              await stream.writeSSE({ data: "", event: "heartbeat" });
              continue;
            }
          }
          await stream.writeSSE({ event: "analysis-job", data: queue.shift()! });
        }
      } finally {
        jobEvents.off("job", onJob);
      }
    });
  });

  /* -------------------------------------------------------- Claude: chat */

  app.get("/api/prs/:key/chat", (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const chat = readChat(key, root);
    return c.json({
      messages: chat.messages,
      sessionId: chat.sessionId,
      busy: chatBusy(key),
    });
  });

  app.delete("/api/prs/:key/chat", (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    clearChat(key, root);
    return c.json({ ok: true });
  });

  /**
   * A chat turn streams over SSE but does not depend on the stream: the run is
   * started first and persists its answer to chat.json even if the client
   * disconnects halfway through.
   */
  app.post("/api/prs/:key/chat", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const body = (await readJsonBody(c)) as { text?: string; refs?: unknown };
    const refs = z.array(ChatRefSchema).default([]).parse(body.refs ?? []);
    const turn = startChatTurn(key, { text: body.text ?? "", refs }, root);

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      const pending: ChatStreamEvent[] = [...turn.backlog];
      let wake: (() => void) | null = null;
      const onEvent = (event: ChatStreamEvent) => {
        pending.push(event);
        wake?.();
        wake = null;
      };
      turn.emitter.on("event", onEvent);
      try {
        for (;;) {
          if (pending.length === 0) {
            if (closed) return;
            const settled = await Promise.race([
              new Promise<"event">((resolve) => {
                wake = () => resolve("event");
              }),
              turn.done.then(() => "done" as const),
            ]);
            if (settled === "done" && pending.length === 0) return;
          }
          const event = pending.shift()!;
          if (closed) continue; // drain silently; the run still persists
          if (event.type === "delta") {
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: event.text }) });
          } else if (event.type === "tool") {
            await stream.writeSSE({
              event: "tool",
              data: JSON.stringify({ name: event.name, detail: event.detail }),
            });
          } else if (event.type === "done") {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ message: event.message }),
            });
          } else {
            await stream.writeSSE({ event: "error", data: JSON.stringify({ error: event.error }) });
          }
        }
      } finally {
        turn.emitter.off("event", onEvent);
      }
    });
  });

  app.post("/api/prs/:key/hunks/:id/viewed", async (c) => {
    const key = keyParam(c);
    const hunkId = c.req.param("id");
    const body = (await readJsonBody(c)) as { viewed?: boolean };
    if (typeof body.viewed !== "boolean") {
      throw new HttpError(400, "invalid_body", "Body must include { viewed: boolean }");
    }
    const state = setHunkViewed(key, hunkId, body.viewed, root);
    return c.json({ state });
  });

  app.post("/api/prs/:key/units/:id/viewed", async (c) => {
    const key = keyParam(c);
    const unitId = c.req.param("id");
    const body = (await readJsonBody(c)) as { viewed?: boolean };
    const viewed = body.viewed ?? true;
    const state = setUnitViewed(key, unitId, viewed, root);
    return c.json({ state });
  });

  app.post("/api/prs/:key/units/:id", async (c) => {
    const key = keyParam(c);
    const unitId = c.req.param("id");
    const body = (await readJsonBody(c)) as { note?: string } & Record<string, unknown>;
    const { note, ...patch } = body;
    const state = setUnit(key, unitId, patch, { note }, root);
    return c.json({ state });
  });

  app.post("/api/prs/:key/sync", (c) => {
    const key = keyParam(c);
    let fileSync: ReturnType<typeof syncPr> | undefined;
    let fileSyncError: string | undefined;
    try {
      fileSync = syncPr(key, root);
    } catch (err) {
      fileSyncError = classifyError(err).message + ": " + String((err as Error).message ?? err);
    }
    const commentSync = syncCommentsToGithub(key, root);
    return c.json({
      files: fileSync
        ? { ok: true, pushed: fileSync.pushed, drift: fileSync.drift }
        : { ok: false, error: fileSyncError },
      comments: commentSync,
      state: fileSync?.state ?? loadState(key, root),
    });
  });

  /* --------------------------------------------------------------- diffs */

  /**
   * The UI presents this as "what changed since you viewed it", so the
   * baseline is the revision at which the hunk was actually marked viewed —
   * not simply the previous revision. `changedSinceViewed` is sticky across
   * later revisions, so diffing only one revision back would report "no
   * difference" for a hunk that genuinely changed since the reader saw it.
   * We walk the per-revision migration reports back to that baseline,
   * following the predecessor chain through renames and fuzzy matches.
   */
  app.get("/api/prs/:key/hunks/:id/diff-of-diffs", (c) => {
    const key = keyParam(c);
    const hunkId = c.req.param("id");
    const state = loadState(key, root);
    const hunkState = state.hunks[hunkId];
    if (!hunkState) {
      return c.json({ error: "not_found", detail: `No hunk "${hunkId}" in current state` }, 404);
    }
    const revisions = [...state.revisions]
      .sort((a, b) => a.revision - b.revision)
      .map((r) => r.revision);
    const idx = revisions.indexOf(state.currentRevision);
    const previousRevision = idx > 0 ? revisions[idx - 1] : undefined;
    if (previousRevision === undefined) {
      return c.json(
        { error: "no_previous_revision", detail: "No previous revision on record" },
        404,
      );
    }
    // Baseline: where the reader last saw it, clamped to a stored revision
    // that is strictly older than the current one.
    const viewedAt = hunkState.viewedAtRevision;
    const baseline =
      viewedAt !== undefined && viewedAt < state.currentRevision && revisions.includes(viewedAt)
        ? viewedAt
        : previousRevision;

    // Walk the predecessor chain back from the current revision to `baseline`.
    let ancestorId: string | undefined = hunkId;
    for (let i = revisions.indexOf(state.currentRevision); i > revisions.indexOf(baseline); i--) {
      const report = readMigrationReport(key, revisions[i], root);
      const entry = report?.entries.find((e) => e.hunkId === ancestorId);
      // No report (or the hunk is new here) => the chain ends before the baseline.
      ancestorId = entry?.previousHunkId;
      if (!ancestorId) break;
    }
    if (!ancestorId) {
      return c.json(
        {
          error: "no_predecessor",
          detail: `Hunk has no recorded predecessor back to revision ${baseline}`,
        },
        404,
      );
    }

    let currentHunk: Hunk | undefined;
    let previousHunk: Hunk | undefined;
    try {
      currentHunk = readFilesJson(key, state.currentRevision, root)
        .files.flatMap((f) => f.hunks)
        .find((h) => h.id === hunkId);
      previousHunk = readFilesJson(key, baseline, root)
        .files.flatMap((f) => f.hunks)
        .find((h) => h.id === ancestorId);
    } catch (err) {
      return c.json({ error: "not_found", detail: classifyError(err).detail }, 404);
    }
    if (!currentHunk || !previousHunk) {
      return c.json(
        {
          error: "hunk_content_unavailable",
          detail: "Predecessor or current hunk content is not present in stored revisions",
        },
        404,
      );
    }
    return c.json({ ...hunkDiffOfDiffs(previousHunk, currentHunk), baselineRevision: baseline });
  });

  /* ------------------------------------------------------------ comments */

  app.get("/api/prs/:key/comments", (c) => {
    const key = keyParam(c);
    return c.json({ comments: readComments(key, root) });
  });

  app.post("/api/prs/:key/comments", async (c) => {
    const key = keyParam(c);
    const body = await readJsonBody(c);
    try {
      const comment = addComment(key, body, root);
      return c.json({ comment }, 201);
    } catch (err) {
      throw classifyError(err);
    }
  });

  app.delete("/api/prs/:key/comments/:id", (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const result = deleteComment(key, id, root);
    if (!result.removed) throw new HttpError(404, "not_found", `No comment "${id}"`);
    // A failed remote delete is reported, never fatal — see comments.ts.
    return c.json({ ok: true, remote: result.remote ?? null });
  });

  /**
   * Editing a comment's body. What happens beyond the local write depends on
   * status:
   *   draft     — local only, no GitHub call.
   *   pushed    — local write always happens, then a best-effort GraphQL
   *               update via the stored githubCommentId. That id can be
   *               missing (a known backfill gap, see comment-sync.ts); when
   *               it is, we still save locally and report a structured
   *               remote failure instead of hard-failing the request.
   *   submitted — same remote update, but the edit is publicly visible so it
   *               requires an explicit { confirm: true }.
   * An unchanged body is a 200 no-op before any of the above, including the
   * confirm requirement — nothing is being edited, so nothing needs a
   * remote call or a confirmation.
   */
  app.patch("/api/prs/:key/comments/:id", async (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const body = (await readJsonBody(c)) as { body?: unknown; confirm?: boolean };
    if (typeof body.body !== "string" || body.body.trim() === "") {
      throw new HttpError(400, "invalid_body", "Body must include a non-empty { body: string }");
    }
    const newBody = body.body;

    const existing = readComments(key, root);
    const target = existing.find((c2) => c2.id === id);
    if (!target) throw new HttpError(404, "not_found", `No comment "${id}"`);

    if (target.body === newBody) {
      return c.json({ comment: target, remote: null });
    }

    if (target.status === "submitted" && body.confirm !== true) {
      throw new HttpError(
        400,
        "confirm_required_public_edit",
        "Editing a submitted (public) comment is visible to others; resend with { confirm: true }",
      );
    }

    const result = updateCommentBody(key, id, newBody, root);
    if (!result.found || !result.comment) throw new HttpError(404, "not_found", `No comment "${id}"`);

    if (target.status === "draft") {
      return c.json({ comment: result.comment, remote: null });
    }

    // pushed or submitted: best-effort remote update, never fatal. The
    // mutation needs the comment's GraphQL node id specifically — the REST
    // databaseId in githubCommentId is the wrong id type for it — so if the
    // node id was never backfilled, try a read-only recovery before giving
    // up (see comment-sync.ts).
    let nodeId = target.githubCommentNodeId;
    if (nodeId === undefined) {
      nodeId = recoverCommentNodeId(key, target, root);
      if (nodeId) setCommentNodeId(key, id, nodeId, root);
    }
    if (nodeId === undefined) {
      return c.json({
        comment: result.comment,
        remote: {
          ok: false,
          reason:
            "No GitHub comment id on record for this comment, so the edit could not be mirrored " +
            "remotely. Discard the pending review and re-sync to pick up an id, then retry.",
        },
      });
    }
    try {
      updatePullRequestReviewCommentBody(key, nodeId, newBody);
      return c.json({
        comment: { ...result.comment, githubCommentNodeId: nodeId },
        remote: { ok: true },
      });
    } catch (err) {
      const e = classifyGhReviewError(err);
      return c.json({ comment: result.comment, remote: { ok: false, reason: e.message } });
    }
  });

  /* -------------------------------------------------------------- review */

  app.get("/api/prs/:key/review", (c) => {
    const key = keyParam(c);
    const remote = c.req.query("remote") !== "0";
    return c.json(reviewStatus(key, root, { checkRemote: remote }));
  });

  app.post("/api/prs/:key/review", async (c) => {
    const key = keyParam(c);
    const body = (await readJsonBody(c)) as { body?: unknown };
    if (typeof body.body !== "string") {
      throw new HttpError(400, "invalid_body", "Body must include { body: string }");
    }
    return c.json({ draft: saveReviewBody(key, body.body, root) });
  });

  /**
   * Submitting posts publicly and cannot be undone, so `confirm: true` is
   * mandatory: no accidental verdict can be produced by a stray POST or a
   * double-submitting form.
   */
  app.post("/api/prs/:key/review/submit", async (c) => {
    const key = keyParam(c);
    const body = (await readJsonBody(c)) as {
      event?: string;
      body?: string;
      confirm?: boolean;
    };
    if (!SUBMIT_EVENTS.includes(body.event as SubmitEvent)) {
      throw new HttpError(
        400,
        "invalid_event",
        `event must be one of ${SUBMIT_EVENTS.join(", ")}`,
      );
    }
    if (body.confirm !== true) {
      throw new HttpError(
        400,
        "confirmation_required",
        "Submitting a review is public and irreversible; resend with { confirm: true }",
      );
    }
    const result = submitReview(
      key,
      { event: body.event as SubmitEvent, body: body.body },
      root,
    );
    return c.json({ ...result, state: loadState(key, root) });
  });

  app.delete("/api/prs/:key/review/pending", (c) => {
    const key = keyParam(c);
    return c.json(discardPendingReview(key, root));
  });

  /* -------------------------------------------------------- misc / debug */

  app.get("/api/prs/:key/migration/:revision", (c) => {
    const key = keyParam(c);
    const revision = Number(c.req.param("revision"));
    const report = readMigrationReport(key, revision, root);
    if (!report) throw new HttpError(404, "not_found", `No migration report for revision ${revision}`);
    return c.json(report);
  });

  app.get("/api/prs/:key/coverage", (c) => {
    const key = keyParam(c);
    const state = loadState(key, root);
    const coverage = analysisCoverage(state, {
      summary: state.summary,
      units: state.units,
      unassigned: state.unassignedHunkIds,
    });
    return c.json(coverage);
  });

  /* ---------------------------------------------------------- static web */

  if (fs.existsSync(webDist)) {
    app.get("/*", async (c) => {
      const reqPath = new URL(c.req.url).pathname;
      const filePath = path.join(webDist, reqPath === "/" ? "index.html" : reqPath);
      const target = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? filePath
        : path.join(webDist, "index.html");
      const data = fs.readFileSync(target);
      const type = contentType(target);
      return c.body(data as unknown as ArrayBuffer, 200, { "Content-Type": type });
    });
  } else {
    app.get("/", (c) => c.text("web not built — run `pnpm --filter @reviewer/web build`", 200));
  }

  return app;
}

function contentType(file: string): string {
  const ext = path.extname(file);
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
