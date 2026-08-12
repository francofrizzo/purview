import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
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
import { addComment, deleteComment, readComments } from "./comments.js";
import { syncCommentsToGithub } from "./comment-sync.js";
import { HttpError, classifyError } from "./http-error.js";

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export interface AppOptions {
  /** Overrides @reviewer/core's REVIEWER_STATE_DIR-based default; mainly for tests. */
  stateDir?: string;
  /** Directory to serve statically at `/`; defaults to ../../web/dist relative to this file. */
  webDist?: string;
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
  const webDist =
    opts.webDist ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../../web/dist");

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (origin && LOCALHOST_ORIGIN.test(origin) ? origin : ""),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
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
    return c.json({
      key: keyToString(result.key),
      created: result.created,
      revision: result.revision,
      state: result.state,
    });
  });

  /* -------------------------------------------------------------- one PR */

  app.post("/api/prs/:key/refresh", (c) => {
    const key = keyParam(c);
    const result = refreshPr(key, root);
    return c.json({
      key: keyToString(key),
      revision: result.revision,
      added: result.added,
      baseOnly: result.baseOnly,
      report: result.report ?? null,
      state: result.state,
    });
  });

  app.get("/api/prs/:key", (c) => {
    const key = keyParam(c);
    const meta = readMeta(key, root);
    const state = loadState(key, root);
    const filesJson = readFilesJson(key, state.currentRevision, root);
    const diff = readDiff(key, state.currentRevision, root);
    return c.json({ state, files: filesJson.files, diff, meta });
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
    const removed = deleteComment(key, id, root);
    if (!removed) throw new HttpError(404, "not_found", `No comment "${id}"`);
    return c.json({ ok: true });
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
