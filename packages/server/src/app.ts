import { requestLog } from "./request-log.js";
import { log, shortKey } from "./log.js";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  analysisCoverage,
  applyAnalysisImport,
  buildAnalysisExport,
  discardRevision,
  hunkDiffOfDiffs,
  initPrAsync,
  keyToString,
  listPrs,
  listRepos,
  loadState,
  parseKey,
  parseRepoKey,
  prExists,
  readDiff,
  readFilesJson,
  changedUnits,
  changesWorthRefreshing,
  analysisUnits,
  isGeneratedUnit,
  reclassifyRepo,
  setGeneratedOverrideAsync,
  readMeta,
  readLocalChatInstructions,
  readLocalRubric,
  readMigrationReport,
  readRepoConfig,
  revisionLineChanges,
  UnknownRevisionError,
  type RevisionLineChanges,
  refreshPrAsync,
  repoKeyOf,
  repoKeyToString,
  setHunkViewed,
  setHunksViewed,
  setUnit,
  setUnitViewed,
  stateRoot,
  syncPrAsync,
  unitProgress,
  generatedHunkIds,
  hunkIdsOf,
  skippedHunkIds,
  updateMeta,
  writeLocalChatInstructions,
  writeLocalRubric,
  writeRepoConfig,
  cachedViewerLogin,
  AgentSelectionSchema,
  ChatAgentSelectionSchema,
  type Hunk,
  type Meta,
  type PrKey,
  type RepoConfig,
  type MigrationReport,
  type RepoKey,
  type State,
} from "@reviewer/core";
import {
  addComment,
  allCommentBodies,
  deleteComment,
  findAnchoringHunk,
  NewCommentSchema,
  reanchorDraftComments,
  readComments,
  commentEvents,
  pendingAgentNotes,
  markPickedUp,
  readDeletedComments,
  restoreDeletedComment,
  setCommentBody,
  setCommentNodeId,
  undoCommentEdit,
  updateCommentBody,
  updateCommentPosition,
  type Comment,
  isAgentActor,
  type CommentActor,
  CommentAudienceSchema,
  CommentNotDraftError,
  markPublished,
  setCommentAudience,
} from "./comments.js";
import { formatAgentNotes, waitForAgentNotes } from "./agent-notes.js";
import { headShaOf, recoverCommentNodeId, syncCommentsToGithub } from "./comment-sync.js";
import {
  assertAttachmentRefsExist,
  attachmentFilePath,
  deleteAttachment,
  findAttachment,
  pruneAttachments,
  readAttachments,
  resolveBodyForGithub,
  storeAttachment,
} from "./attachments.js";
import {
  REMOTE_IMAGE_CACHE_CONTROL,
  fetchRemoteImage,
  remoteImageFilePath,
} from "./remote-images.js";
import { proposeCommentReanchor } from "./comment-reanchor.js";
import {
  SUBMIT_EVENTS,
  discardPendingReview,
  reviewStatus,
  saveReviewBody,
  submitReview,
} from "./review.js";
import {
  classifyGhReviewError,
  createStandaloneReviewComment,
  updatePullRequestReviewCommentBody,
  type SubmitEvent,
} from "./github-review.js";
import { HttpError, classifyError } from "./http-error.js";
import { loadThreads, normalizeLogin, REACTION_CONTENTS, setReaction, setThreadResolved } from "./github-threads.js";
import { streamSSE } from "hono/streaming";
import {
  cancelAnalysis,
  isBusy,
  jobEvents,
  readJob,
  reconcileStaleJobs,
  startAnalysis,
} from "./analysis.js";
import {
  importAnalysisFromPr,
  probeSharedAnalysis,
  resolveAutoSharedAnalysis,
  shareAnalysisToPr,
} from "./analysis-share-server.js";
import {
  chatBusy,
  chatHandoff,
  startChatTurn,
  stopChatTurn,
  type ChatStreamEvent,
  type ChatTurn,
} from "./chat-session.js";
import { ChatRefSchema, clearChat, readChat, resolveRefs, rewindChat, setChatAgent } from "./chat.js";
import { prHead, resolveRepoPathInput, setRepoPath } from "./repo-path.js";
import { resolveCheckout } from "./worktree.js";
import { localOnlyGuard, loopbackOnly } from "./security.js";
import { LAN_WARNING, lanQrSvg, lanUrl } from "./lan.js";
import { checkStaleness, clearStalenessCache, needsUpdate } from "./staleness.js";
import { reviewEffort } from "./effort.js";
import { diffSize } from "./diff-size.js";
import { compareVersions, entriesSince, headSha, readChangelog } from "./changelog.js";
import { createUpdateChecker, noUpdateChecker, type UpdateChecker } from "./updates.js";
import { TagSchema, setTagFor } from "./tag.js";
import { authoredByYou, commentAudienceFor, setCommentAudienceFor } from "./comment-audience.js";
import {
  autoAnalyzeAllowed,
  autoAnalyzeBlocker,
  cachedCommittedConfigForRepo,
  effectiveConfig,
  effectiveRepoPath,
  isRepoArchived,
} from "./repo-config.js";
import { agentView, checkAgentSelection, resolveAgent, resolveChatAgent } from "./repo-config.js";
import { DEFAULT_HARNESS, getHarness, listedHarnessIds, registeredHarnessIds } from "./agent/registry.js";
import { generateLanToken, readConfig, writeConfig, type ReviewerConfig } from "./config.js";
import { cachedCommitted, loadCommittedConfig } from "./team-config.js";
import { importReviewRequests } from "./review-import.js";
import { getWatchStatus } from "./review-watch.js";
import { pruneCheckouts } from "./pr-checkout.js";
import { removeRepo, repoRemovalSummary } from "./repo-removal.js";
import { scheduleReviewRequestRefresh, type RefreshDeps } from "./review-request-refresh.js";
import { fileLinesAtHead } from "./file-content.js";
import { agentSkillRoutes } from "./agent-skill.js";
import { sinceLastReview } from "./since-review.js";

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
  /**
   * LAN access, when the run was started with `--lan` (see main.ts). Absent —
   * the default — keeps the loopback-only behaviour in every respect; `hosts`
   * is the interface scan, done once there rather than per request.
   */
  lan?: { token: string; hosts: string[] };
  /**
   * The background `reviewRequest` refresh `GET /api/prs` kicks off (see
   * review-request-refresh.ts). `false` turns it off; an object swaps its
   * clock/resolver (tests).
   */
  reviewRequestRefresh?: RefreshDeps | false;
  /**
   * The "is there a newer Purview?" check behind `GET /api/version` (see
   * updates.ts). `false` never asks the network (tests); an object swaps the
   * `git ls-remote` runner and clock.
   */
  updateChecker?: UpdateChecker | false;
}

const isYou = (author: string | undefined, login: string | null | undefined): boolean =>
  !!author && !!login && author.toLowerCase() === login.toLowerCase();

/**
 * Whether a PR counts as one of yours on the list: opened by the viewer, or by
 * a login the reader listed in `extraAuthors` (an agent's bot account). List-
 * only — `isMine` on threads and verdicts keeps meaning the viewer login.
 */
export { authoredByYou };

/**
 * Who is making a request, as far as comments are concerned. The reviewer-
 * state CLI always sends `X-Purview-Actor` (`chat` when its env has
 * PURVIEW_ACTOR=chat, which the chat's Claude child gets from chat-session.ts;
 * `you` otherwise); the web sends nothing, which is the reader.
 */
export const ACTOR_HEADER = "x-purview-actor";
/** Which harness a chat actor runs on (PURVIEW_AGENT in the chat's env). */
export const AGENT_HEADER = "x-purview-agent";

/**
 * The chat is an agent; everything else is the reader. The harness only
 * labels the agent (which one wrote a draft) — it grants nothing, and an
 * absent or malformed one is the default harness.
 */
function actorOf(c: { req: { header(name: string): string | undefined } }): CommentActor {
  if (c.req.header(ACTOR_HEADER)?.trim().toLowerCase() !== "chat") return "you";
  const harness = c.req.header(AGENT_HEADER)?.trim();
  return { agent: harness && /^[a-z0-9][a-z0-9-]{0,63}$/.test(harness) ? harness : DEFAULT_HARNESS };
}

/**
 * The chat may only ever touch drafts: pushed comments sit in the reader's
 * pending review and submitted ones are public. Enforced here rather than
 * only in the prompt, so a confused or injected model cannot get around it.
 */
function assertChatMayTouch(actor: CommentActor, target: Comment, verb: string): void {
  if (isAgentActor(actor) && target.status !== "draft") {
    throw new HttpError(
      409,
      "not_draft",
      `The review chat may only ${verb} draft comments; comment ${target.id} is ${target.status}` +
        (target.status === "pushed"
          ? " (in the reader's pending GitHub review)."
          : " (public on GitHub)."),
    );
  }
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
  // The generated unit and its hunks are left out: they are not reading
  // work, and a PR whose only unit is that one is still "not analyzed".
  // Neither are the hunks the analysis marked skippable (`skip: true`).
  const units = unitProgress(state);
  const generated = generatedHunkIds(state);
  const skipped = skippedHunkIds(state);
  const hunks = Object.entries(state.hunks).filter(([id]) => !generated.has(id) && !skipped.has(id));
  const hunkTotal = hunks.length;
  const hunkViewed = hunks.filter(([, h]) => h.viewed).length;
  const genPaths = new Set(state.generated.map((g) => g.path));
  const files = state.files.filter((f) => !genPaths.has(f.path));
  return {
    hunks: { viewed: hunkViewed, total: hunkTotal },
    units: {
      complete: units.filter((u) => u.complete).length,
      total: units.length,
    },
    files: {
      viewed: files.filter((f) => f.viewed).length,
      total: files.length,
    },
  };
}

/**
 * Re-analyzing costs real money and time, so a refresh only triggers one when
 * the migration actually left work to do: hunks the existing analysis cannot
 * already account for (new or unassigned), or — on an analyzed PR — units
 * whose code the revision reworked, so their description went stale (see
 * core's `changedUnits`). On a baseOnly revision (base moved, head unchanged)
 * a fuzzy/renamed rework came from the base branch, not the PR author, so it
 * does not count on its own (`changesWorthRefreshing`; MIGRATION-NOTES treats
 * baseOnly revisions the same way).
 */
export function refreshLeavesWork(
  key: PrKey,
  report: MigrationReport,
  root: string,
): boolean {
  const state = loadState(key, root);
  // New hunks — not the ones Purview already put in its generated unit: a
  // lockfile-only push costs nothing.
  const generated = new Set(state.units.filter(isGeneratedUnit).flatMap(hunkIdsOf));
  const newWork = report.entries.some((e) => e.status === "new" && !generated.has(e.hunkId));
  if (newWork || state.unassignedHunkIds.length > 0) return true;
  if (analysisUnits(state).length === 0) return false;
  const filesOf = (rev: number | undefined) => {
    if (rev === undefined) return undefined;
    try {
      return readFilesJson(key, rev, root).files;
    } catch {
      return undefined;
    }
  };
  const changes = changedUnits(state, report, {
    previousFiles: filesOf(report.previousRevision),
    currentFiles: filesOf(report.revision),
  });
  return changesWorthRefreshing(changes).length > 0;
}

export function createApp(opts: AppOptions = {}): Hono {
  const app = new Hono();
  const root = opts.stateDir ?? stateRoot();
  // A failure to compute effort must never break the PR list.
  const safeEffort = (key: PrKey) => {
    try {
      return reviewEffort(key, root);
    } catch {
      return null;
    }
  };
  const autoAnalyze = opts.autoAnalyze ?? true;
  const updateChecker =
    opts.updateChecker === false ? noUpdateChecker : (opts.updateChecker ?? createUpdateChecker());
  // A "running" job record can only be stale at boot — nothing is running yet.
  reconcileStaleJobs(root);

  /**
   * `?analyze=false` opts a single init/refresh out of the automatic run.
   * `autoAnalyze` is the process-wide kill switch (env / tests); the actual
   * consent is layered per repo and resolved in `autoAnalyzeAllowed`, which
   * also refuses to spend anything on an archived PR.
   */
  const analyzeRequested = (
    c: { req: { query(k: string): string | undefined } },
    key: PrKey,
  ) => autoAnalyze && c.req.query("analyze") !== "false" && autoAnalyzeAllowed(key, root);

  /**
   * Why `analyzeRequested` said no. `"archived"` only when archiving is the
   * one thing that held the run back; every other opt-out (the process kill
   * switch, `?analyze=false`, the layered config) is `"disabled"`.
   */
  const analysisSkipReason = (
    c: { req: { query(k: string): string | undefined } },
    key: PrKey,
  ): "archived" | "disabled" | null => {
    if (!autoAnalyze || c.req.query("analyze") === "false") return "disabled";
    return autoAnalyzeBlocker(key, root);
  };

  /** Auto-triggers are best-effort: a failed spawn must not fail the request. */
  const triggerAnalysis = (key: PrKey) => {
    try {
      return startAnalysis(key, root, { timeoutMs: opts.analysisTimeoutMs });
    } catch (err) {
      log.warn("analysis", `${shortKey(key)}  not started`, { reason: (err as Error).message });
      return null;
    }
  };
  const webDist =
    opts.webDist ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../../web/dist");

  const port = opts.port ?? DEFAULT_PORT;
  /**
   * `null` unless this run serves the LAN — that is decided by the command
   * line, before anything binds, and cannot change afterwards. `token` is
   * mutable on purpose: regenerating has to lock the old devices out of the
   * *running* server, and the guard reads it off this object per request.
   */
  const lan = opts.lan ? { token: opts.lan.token, hosts: opts.lan.hosts } : null;

  // No CORS middleware at all: the UI is served from this same origin, so it
  // needs none, and emitting none is what stops a foreign page from reading any
  // response. What replaces it is a Host + Origin guard — see security.ts for
  // why CORS alone was never enough (it gates reads, not requests).
  //
  // Loopback-only, the guard covers `/api/*`: nothing else it serves is worth
  // attacking cross-origin. With LAN access on it covers everything, because
  // the token check has to apply to the app shell and its assets too — a
  // device without the cookie must not get the page either.
  app.use("/api/*", requestLog());
  app.use(lan ? "/*" : "/api/*", localOnlyGuard({ port, devOrigins: opts.devOrigins, lan }));

  /**
   * Requests from the reviewer-state CLI (they carry the actor header) come
   * from this machine, always; one arriving from the LAN is refused. A chat-
   * originated request is further confined to the comment routes and to
   * marking hunks viewed (the reader asks it to tick moved code) — the chat
   * has no business reaching anything else through this API, whatever its
   * Bash allowlist says.
   */
  const chatMayWrite = /^\/api\/prs\/.+\/(comments(\/|$)|hunks\/(viewed$|[^/]+\/viewed$))/;
  const cliLoopbackOnly = loopbackOnly({ port });
  app.use("/api/*", (c, next) =>
    c.req.header(ACTOR_HEADER) === undefined ? next() : cliLoopbackOnly(c, next),
  );
  app.use("/api/*", async (c, next) => {
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase());
    if (isAgentActor(actorOf(c)) && mutating && !chatMayWrite.test(c.req.path)) {
      return c.json(
        { error: "forbidden_actor", detail: "The review chat may only change draft comments and viewed marks." },
        403,
      );
    }
    return next();
  });

  app.onError((err, c) => {
    const httpErr = classifyError(err);
    return c.json({ error: httpErr.message, detail: httpErr.detail }, httpErr.status as 400);
  });

  app.route("/api/skill", agentSkillRoutes(port));

  /* -------------------------------------------------------------- PR list */

  app.get("/api/prs", (c) => {
    const keys = listPrs(root);
    // Whose PRs are "yours": the cached login only, so the list never waits on
    // `gh`. Adding a PR and the review-request refresh below both look it up,
    // so it is there from the second load on; until then nothing is marked.
    const logins = new Map<string, string | null>();
    const loginOf = (host: string) => {
      if (!logins.has(host)) logins.set(host, cachedViewerLogin(host, root));
      return logins.get(host) ?? null;
    };
    const { extraAuthors } = readConfig(root);
    const metas: { key: PrKey; meta: Meta }[] = [];
    // One repo.json read per repo, not per PR.
    const repoArchived = new Map<string, boolean>();
    const prs = keys.map((key) => {
      const meta = readMeta(key, root);
      const rkey = repoKeyToString(repoKeyOf(key));
      if (!repoArchived.has(rkey)) repoArchived.set(rkey, isRepoArchived(repoKeyOf(key), root));
      const inArchivedRepo = repoArchived.get(rkey) === true;
      // The background lookup gates on `archived`; hand it the effective
      // value so a PR of an archived repo is left alone like an archived PR.
      metas.push({ key, meta: inArchivedRepo ? { ...meta, archived: true } : meta });
      const state = loadState(key, root);
      return {
        key: keyToString(key),
        meta,
        // Flattened onto the item because the list UI sorts and filters on
        // them; `meta` keeps carrying the same values for older clients.
        title: meta.title ?? state.pr?.title ?? "",
        state: meta.prState ?? "open",
        reviewDecision: meta.reviewDecision ?? null,
        ci: meta.ci,
        // `[]` = GitHub said nobody; absent = not fetched yet.
        reviewers: meta.reviewers,
        // GitHub holds commits the stored revision does not (see staleness.ts).
        needsUpdate: needsUpdate(meta, state),
        // Absent (not `null`) until first looked up: `null` means "nothing pending".
        reviewRequest: meta.reviewRequest,
        authoredByYou: authoredByYou(meta.author, loginOf(key.host), extraAuthors),
        addedAt: meta.createdAt,
        // The PR's own flag. `repoArchived` is its repo's, kept apart so that
        // unarchiving the repo restores each PR exactly as it was.
        archived: meta.archived === true,
        repoArchived: inArchivedRepo,
        currentRevision: state.currentRevision,
        summary: state.summary,
        progress: progressOf(state),
        analysisJob: readJob(key, root),
        // Best-effort: a broken computation for one PR must never take the
        // whole list down.
        effort: safeEffort(key),
        // GitHub's "+120 −34" for the row; null until the revision's files exist.
        diffSize: diffSize(key, state.currentRevision, root),
      };
    });
    // Nothing else re-reads every tracked PR, so the list load is the trigger
    // for keeping "requested 3d ago" fresh. Fire-and-forget: rate-limited per
    // PR, capped in concurrency, and never awaited by this response.
    if (opts.reviewRequestRefresh !== false) {
      try {
        scheduleReviewRequestRefresh(metas, root, opts.reviewRequestRefresh ?? {});
      } catch (err) {
        log.warn("watch", "review requests not scheduled", { reason: (err as Error).message });
      }
    }
    return c.json({ prs });
  });

  app.post("/api/prs", async (c) => {
    const body = await readJsonBody(c) as { url?: string };
    if (!body.url) throw new HttpError(400, "missing_url", "Body must include { url }");
    let key: PrKey;
    try {
      key = parseKey(body.url);
    } catch (err) {
      throw classifyError(err);
    }
    const result = await initPrAsync(key, root);
    // Adding a PR you had archived is asking for it back: bring it out of the
    // archive instead of leaving the add looking like it did nothing. (Only
    // this explicit add; the background importer never resurrects one.)
    let unarchived = false;
    if (!result.created && readMeta(key, root).archived) {
      updateMeta(key, { archived: false }, root);
      unarchived = true;
    }
    // A freshly tracked PR has no analysis at all, so init would normally kick
    // one off (unless the caller opted out with ?analyze=false) — but first
    // check whether a teammate already shared one for this exact revision on
    // the PR itself, which is free to import and saves the paid run entirely.
    let job = null as ReturnType<typeof triggerAnalysis>;
    let sharedAnalysis: { author?: string; postedAt: string } | null = null;
    if (analyzeRequested(c, key)) {
      const auto = await resolveAutoSharedAnalysis(key, root);
      if (auto.imported) {
        sharedAnalysis = auto.sharedAnalysis ?? null;
      } else if (!auto.foundDifferentCommit) {
        // No shared analysis at all -> analyze fresh, same as before this
        // feature existed. (foundDifferentCommit: leave it to the UI to
        // suggest importing or analyzing fresh — see the PR-view banner.)
        job = triggerAnalysis(key);
      }
    }
    return c.json({
      key: keyToString(result.key),
      created: result.created,
      unarchived,
      revision: result.revision,
      state: sharedAnalysis ? loadState(key, root) : result.state,
      analysisJob: job,
      sharedAnalysis,
    });
  });

  /* -------------------------------------------------------------- one PR */


  app.post("/api/prs/:key/refresh", async (c) => {
    const key = keyParam(c);
    log.info("review", `${shortKey(key)}  refresh started`);
    let result: Awaited<ReturnType<typeof refreshPrAsync>>;
    try {
      result = await refreshPrAsync(key, root);
    } catch (err) {
      log.error("review", `${shortKey(key)}  refresh failed`, { reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    log.info("review", `${shortKey(key)}  ${result.added ? "refresh finished" : "nothing changed"}`, { revision: result.revision });
    // A migration report means the diff actually changed shape; that's
    // exactly when a draft comment's hunk can have slid out from under it,
    // so reconcile drafts here too, not just on push — see comments.ts. A
    // bug here must never fail a refresh.
    if (result.report) {
      try {
        reanchorDraftComments(key, root);
      } catch (err) {
        log.warn("review", `${shortKey(key)}  comment reanchor failed`, { reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // We just fetched the truth; any cached "this PR moved" answer is now
    // about a revision we hold, so it must not outlive the refresh.
    clearStalenessCache(key, root);
    const hasNewWork = !!result.report && refreshLeavesWork(key, result.report, root);
    const analysisSkipped = hasNewWork ? analysisSkipReason(c, key) : null;
    const job = hasNewWork && !analysisSkipped ? triggerAnalysis(key) : null;
    // Remember an archive-skipped revision so the PR view can say so after a
    // reload (the refresh may well have come from another tab). A started run
    // clears it itself (startAnalysis); a new revision with nothing left to
    // analyze makes it moot. A no-op refresh (no report) leaves it alone: the
    // work it describes is still there.
    if (analysisSkipped === "archived") {
      updateMeta(key, { analysisPending: { revision: result.revision, reason: "archived" } }, root);
    } else if (result.report && !hasNewWork && readMeta(key, root).analysisPending) {
      updateMeta(key, { analysisPending: undefined }, root);
    }
    return c.json({
      key: keyToString(key),
      revision: result.revision,
      added: result.added,
      baseOnly: result.baseOnly,
      report: result.report ?? null,
      state: result.state,
      analysisJob: job,
      analysisSkipped,
    });
  });

  /**
   * Throw away the latest revision — a refresh that caught the author
   * mid-rebase — so the next refresh diffs against the one before it. Core
   * guards the revision itself and comments written since it (409, with
   * core's refusal code); the in-process work is guarded here, since a queued
   * or running analysis, or a chat turn, could still write into it.
   */
  app.post("/api/prs/:key/revisions/:n/discard", (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n)) {
      throw new HttpError(400, "invalid_revision", `Invalid revision "${c.req.param("n")}"`);
    }
    if (isBusy(key)) {
      throw new HttpError(
        409,
        "analysis_in_progress",
        `An analysis is queued or running for ${keyToString(key)}; cancel it or let it finish first.`,
      );
    }
    if (chatBusy(key)) {
      throw new HttpError(409, "chat_busy", "A chat reply is still streaming; wait for it to finish.");
    }
    const result = discardRevision(key, n, root);
    // The staleness answer compared GitHub against the discarded head.
    clearStalenessCache(key, root);
    return c.json({
      key: keyToString(key),
      discarded: result.discarded,
      revision: result.revision,
      state: result.state,
    });
  });

  app.get("/api/prs/:key", async (c) => {
    const key = keyParam(c);
    const meta = readMeta(key, root);
    const state = loadState(key, root);
    const filesJson = readFilesJson(key, state.currentRevision, root);
    const diff = readDiff(key, state.currentRevision, root);
    // Resolving here is what makes a stale checkout visible in the UI without
    // waiting for a run to say so; it is additive, so a client that predates
    // the field is unaffected.
    const checkout = await resolveCheckout(
      effectiveRepoPath(key, root, { meta }),
      prHead(key, root),
    );
    return c.json({
      state,
      files: filesJson.files,
      diff,
      meta,
      analysisJob: readJob(key, root),
      checkoutMismatch: checkout.mismatch ?? null,
      // Lets the header's "stacked on #n" chip link inside Purview when the
      // base PR is tracked here too, and out to GitHub otherwise.
      basePrTracked: meta.basePr
        ? prExists({ ...repoKeyOf(key), number: meta.basePr.number }, root)
        : false,
      reviewRequest: meta.reviewRequest,
      analysisPending: meta.analysisPending ?? null,
      commentAudience: commentAudienceFor(key, root),
      // Same rule as the list: the cached login only, never a `gh` call.
      authoredByYou: authoredByYou(meta.author, cachedViewerLogin(key.host, root), readConfig(root).extraAuthors),
      // Whether the PR behaves as archived because its whole repo is; the
      // header offers "unarchive repo" then rather than a per-PR unarchive.
      repoArchived: isRepoArchived(repoKeyOf(key), root),
      // The PR-level "since your last review" toggle (see since-review.ts).
      sinceReview: sinceLastReview(key, state, filesJson.files, root),
    });
  });

  /**
   * The reader's "Not generated" / "Treat as generated" on one file: written
   * to the repo's `generated.exclude` / `generated.include` (so it holds for
   * every PR of the repo), then the current revision is re-classified and the
   * generated unit rebuilt. A file leaving the unit lands in no unit, for the
   * next (incremental) analysis to place; nothing is started here.
   */
  const GeneratedOverrideSchema = z.object({ path: z.string().min(1), generated: z.boolean() }).strict();
  app.post("/api/prs/:key/generated", async (c) => {
    const key = keyParam(c);
    const parsed = GeneratedOverrideSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_body", "Body must be { path: string, generated: boolean }");
    }
    readMeta(key, root); // 404s an untracked PR
    let res;
    try {
      res = await setGeneratedOverrideAsync(key, parsed.data.path, parsed.data.generated, root);
    } catch (err) {
      throw new HttpError(400, "invalid_path", (err as Error).message);
    }
    return c.json({ ok: true, generated: res.generated });
  });

  /* ------------------------------------------------- Claude: analysis job */

  app.get("/api/prs/:key/analysis-job", (c) => {
    const key = keyParam(c);
    readMeta(key, root); // 404s for an unknown PR instead of reporting "no job"
    return c.json({ job: readJob(key, root) });
  });

  // An explicit request, so it runs on an archived PR too: only the
  // *automatic* triggers (analyzeRequested) stay away from archived PRs.
  app.post("/api/prs/:key/analyze", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    // `{fresh: true}` starts over (first-analysis flow); the body is optional.
    const body: { fresh?: unknown } = await c.req.json<{ fresh?: unknown }>().catch(() => ({}));
    const fresh = body.fresh === true;
    return c.json({ job: startAnalysis(key, root, { timeoutMs: opts.analysisTimeoutMs, fresh }) });
  });

  /** The reader dismissed the "archived, so not analyzed" banner. */
  app.delete("/api/prs/:key/analysis-pending", (c) => {
    const key = keyParam(c);
    const meta = readMeta(key, root);
    if (meta.analysisPending) updateMeta(key, { analysisPending: undefined }, root);
    return c.json({ ok: true });
  });

  app.delete("/api/prs/:key/analyze", (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    return c.json({ job: cancelAnalysis(key, root) });
  });

  /* --------------------------------------------------- Purview-to-Purview */

  /**
   * Download the current analysis as a portable envelope another reader can
   * import into their own tracked copy of the same PR. Throws (409, via
   * classifyError) when there is no analysis yet.
   */
  app.get("/api/prs/:key/analysis/export", (c) => {
    const key = keyParam(c);
    const envelope = buildAnalysisExport(key, root);
    const filename = `${key.owner}-${key.repo}-${key.number}-analysis.json`;
    return c.body(JSON.stringify(envelope, null, 2), 200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
  });

  /**
   * Import an envelope exported from another reader's copy of the same PR.
   * Re-anchors by hunk id onto the importer's current revision and replaces
   * the current analysis. 409s while an analysis run is in flight for this
   * PR — importing mid-run would race the run's own `set-analysis` call.
   */
  app.post("/api/prs/:key/analysis/import", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    if (isBusy(key)) {
      throw new HttpError(
        409,
        "analysis_in_progress",
        `An analysis is currently running for ${keyToString(key)}; try again once it finishes.`,
      );
    }
    const body = await readJsonBody(c);
    const { report } = applyAnalysisImport(key, body, root);
    return c.json({ report });
  });

  /**
   * Post (or update) the canonical `purview-analysis`-marked comment on the
   * PR's own conversation tab. Public and 409s while an analysis run is in
   * flight, for the same reason the file import does: it would race the
   * run's own `set-analysis` call, and this reads the current analysis to
   * build the envelope.
   */
  app.post("/api/prs/:key/analysis/share-to-pr", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    if (isBusy(key)) {
      throw new HttpError(
        409,
        "analysis_in_progress",
        `An analysis is currently running for ${keyToString(key)}; try again once it finishes.`,
      );
    }
    const result = await shareAnalysisToPr(key, root);
    return c.json(result);
  });

  /**
   * Import the newest marked comment on the PR's own conversation tab,
   * verifying it is for this PR and re-anchoring it exactly as the file
   * import does. 409s mid-run for the same reason `analysis/import` does.
   */
  app.post("/api/prs/:key/analysis/import-from-pr", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    if (isBusy(key)) {
      throw new HttpError(
        409,
        "analysis_in_progress",
        `An analysis is currently running for ${keyToString(key)}; try again once it finishes.`,
      );
    }
    const result = await importAnalysisFromPr(key, root);
    return c.json(result);
  });

  /**
   * Cheap read-only probe: is there a shared analysis comment on this PR, and
   * does it match the revision the reader is currently looking at? Used by
   * the PR-view banner (only when there is no local analysis and no live
   * job) — never polled, and never throws: a `gh` failure degrades to
   * `{ found: false, error }` with 200, same idiom as `/staleness`.
   */
  app.get("/api/prs/:key/analysis/shared", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    return c.json(await probeSharedAnalysis(key, root));
  });

  app.post("/api/prs/:key/repo-path", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const body = await readJsonBody(c) as { path?: unknown };
    const result = await setRepoPath(key, body.path, root);
    return c.json({
      ok: true,
      path: result.path,
      warning: result.warning,
      checkoutMismatch: result.checkoutMismatch ?? null,
    });
  });

  /** One local tag per PR; null removes it. `stack: true` applies it to every PR stacked with this one. */
  app.post("/api/prs/:key/tag", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const body = await readJsonBody(c) as { tag?: unknown; stack?: unknown };
    const parsed = TagSchema.nullable().safeParse(body?.tag);
    if (!parsed.success) throw new HttpError(400, "invalid_body", "Tag must be null or 1–24 characters after normalization");
    return c.json(setTagFor(key, parsed.data, root, { stack: body?.stack === true }));
  });

  /**
   * Archiving is a shelf, not a delete: an archived PR keeps every byte of its
   * state and stays fully readable, it just drops out of the active list and
   * can no longer trigger an automatic (paid) analysis run.
   */
  /**
   * Who new comments on this PR are for. `null` goes back to the default by
   * author (your own PRs: notes for an agent; anyone else's: your review).
   */
  app.post("/api/prs/:key/comment-audience", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const body = await readJsonBody(c) as { audience?: unknown };
    const parsed = CommentAudienceSchema.nullable().safeParse(body.audience);
    if (!parsed.success) {
      throw new HttpError(400, "invalid_body", 'Body must include { audience: "github" | "agent" | null }');
    }
    return c.json(setCommentAudienceFor(key, parsed.data, root));
  });

  app.post("/api/prs/:key/archive", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const body = await readJsonBody(c) as { archived?: unknown };
    if (typeof body.archived !== "boolean") {
      throw new HttpError(400, "invalid_body", "Body must include { archived: boolean }");
    }
    const meta = updateMeta(key, { archived: body.archived }, root);
    // An archived PR no longer needs its managed checkout; drop it in the
    // background (the response never waits on a worktree removal).
    if (meta.archived) {
      void pruneCheckouts(root).catch((err: unknown) =>
        log.warn("checkout", "prune failed", { reason: (err as Error).message }),
      );
    }
    return c.json({ ok: true, archived: meta.archived === true });
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
        wake?.();
      });
      const queue: { event: string; data: string }[] = [];
      let wake: (() => void) | null = null;
      const onJob = (payload: { key: PrKey; job: unknown }) => {
        if (keyToString(payload.key) !== keyStr) return;
        queue.push({ event: "analysis-job", data: JSON.stringify({ type: "analysis-job", job: payload.job }) });
        wake?.();
        wake = null;
      };
      // Subscribe before the first write: a transition landing during that
      // write would otherwise fall in the gap and never reach the client.
      const onComments = (payload: { key: PrKey }) => {
        if (keyToString(payload.key) !== keyStr) return;
        queue.push({ event: "comments", data: JSON.stringify({ type: "comments" }) });
        wake?.();
        wake = null;
      };
      commentEvents.on("comments", onComments);
      jobEvents.on("job", onJob);
      try {
        await stream.writeSSE({
          event: "analysis-job",
          data: JSON.stringify({ type: "analysis-job", job: readJob(key, root), replay: true }),
        });

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
          await stream.writeSSE(queue.shift()!);
        }
      } finally {
        jobEvents.off("job", onJob);
        commentEvents.off("comments", onComments);
      }
    });
  });

  /* -------------------------------------------------------- Claude: chat */

  /** `null` means "follow the repo/global default again", not "no agent". */
  const ChatAgentPutSchema = z
    .object({ agent: ChatAgentSelectionSchema.strict().nullable() })
    .strict();

  /** The chat's agent: the conversation's own pin over the layered configuration. */
  function chatAgentPayload(key: PrKey, meta: ReturnType<typeof readMeta>, pin: ReturnType<typeof readChat>["agent"]) {
    return {
      /** what the next message will actually be sent with */
      agent: agentView(resolveChatAgent(key, root, { meta }, pin)),
      /** the layered configuration, i.e. what "inherit" means */
      configuredAgent: agentView(resolveChatAgent(key, root, { meta })),
      /** null when the conversation simply follows `configuredAgent` */
      sessionAgent: pin ?? null,
    };
  }

  app.get("/api/prs/:key/chat", (c) => {
    const key = keyParam(c);
    const meta = readMeta(key, root);
    const chat = readChat(key, root);
    return c.json({
      messages: chat.messages,
      sessionId: chat.session?.id ?? null,
      sessionHarness: chat.session?.harness ?? null,
      busy: chatBusy(key),
      ...chatAgentPayload(key, meta, chat.agent),
    });
  });

  /**
   * Pin the agent for this conversation. It applies to the next message: the
   * turn in flight (if any) keeps what it was spawned with. A different model
   * on the same harness continues the session (`claude --resume` accepts a
   * different `--model`); a different harness cannot continue another's
   * session, so the next turn starts a new one — `restartedSession` says so.
   */
  app.post("/api/prs/:key/chat/agent", async (c) => {
    const key = keyParam(c);
    const meta = readMeta(key, root);
    const parsed = ChatAgentPutSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_body",
        "Body must be { agent: { harness, model? } | null } (null to inherit)",
      );
    }
    const chat = setChatAgent(key, checkAgentSelection(parsed.data.agent, "agent"), root);
    const payload = chatAgentPayload(key, meta, chat.agent);
    return c.json({
      ...payload,
      restartedSession: chat.session != null && chat.session.harness !== payload.agent.harness,
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
   * disconnects halfway through. Shared by every route that starts a turn
   * (plain send, and edit-then-resend) so the SSE plumbing exists once.
   */
  function streamChatTurn(c: Context, turn: ChatTurn) {
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
              data: JSON.stringify({ name: event.name, detail: event.detail, kind: event.kind }),
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
  }

  app.post("/api/prs/:key/chat", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const body = await readJsonBody(c) as { text?: string; refs?: unknown };
    const refs = z.array(ChatRefSchema).default([]).parse(body.refs ?? []);
    const turn = startChatTurn(key, { text: body.text ?? "", refs }, root, { serverPort: port });
    return streamChatTurn(c, turn);
  });

  /**
   * Stop the turn in flight: SIGTERM to the agent child (SIGKILL after a
   * grace), and the reply so far is kept as an `interrupted` assistant
   * message. Answers only once the turn has finalized, so a send issued right
   * after is not refused as `chat_busy`. 409 `chat_idle` when nothing runs.
   */
  app.post("/api/prs/:key/chat/stop", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const message = await stopChatTurn(key);
    return c.json({ ok: true, message });
  });

  /**
   * "Continue in Claude Code": the shell one-liner that forks this chat's
   * session into the reader's own terminal, with the PR context written to a
   * file next to the state. Loopback-only, like `/api/lan`: the command spells
   * out local paths, and it only runs on the machine Purview runs on anyway.
   */
  app.use("/api/prs/:key/chat/handoff", loopbackOnly({ port }));
  app.post("/api/prs/:key/chat/handoff", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    return c.json(await chatHandoff(key, root));
  });

  /**
   * Discard the message at `index` and everything after it, and clear the
   * session id: the next turn starts fresh and replays what's kept (see
   * `buildChatPrompt` in chat.ts). 409s while a turn is running for the same
   * reason the plain send does — a reply mid-flight is about to append to the
   * very messages this would remove.
   */
  app.post("/api/prs/:key/chat/rewind", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    if (chatBusy(key)) {
      throw new HttpError(409, "chat_busy", `A chat turn is already running for ${keyToString(key)}`);
    }
    const parsed = z.object({ index: z.number() }).strict().safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_body", "Body must include { index: number }");
    }
    const { removed } = rewindChat(key, parsed.data.index, root);
    const chat = readChat(key, root);
    return c.json({
      messages: chat.messages,
      model: chat.agent?.model ?? null,
      sessionId: chat.session?.id ?? null,
      removed,
    });
  });

  /**
   * Edit a previously sent user message: rewind to it (dropping it and
   * everything after, same as `/chat/rewind`), then immediately resend it
   * with the new text/refs. Streams exactly like a plain send.
   */
  app.post("/api/prs/:key/chat/edit", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    if (chatBusy(key)) {
      throw new HttpError(409, "chat_busy", `A chat turn is already running for ${keyToString(key)}`);
    }
    const parsed = z
      .object({ index: z.number(), text: z.string(), refs: z.array(ChatRefSchema).optional() })
      .strict()
      .safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_body", "Body must include { index: number, text: string }");
    }
    const { index, text } = parsed.data;
    const target = readChat(key, root).messages[index];
    if (!target || target.role !== "user") {
      throw new HttpError(400, "invalid_index", `index ${index} is not a user message`);
    }
    // Refs default to the message's own, so editing just the text keeps what
    // it was pointing at.
    const refs = parsed.data.refs ?? target.refs ?? [];
    // Everything that can reject this send has to reject it BEFORE the rewind:
    // truncating and then failing to start the turn would destroy messages
    // with nothing to show for it. Empty text and unresolvable refs are the
    // two rejections `startChatTurn` would otherwise raise after the fact.
    if (!text.trim()) {
      throw new HttpError(400, "invalid_body", "Body must include a non-empty { text }");
    }
    resolveRefs(key, refs, root);
    rewindChat(key, index, root);
    const turn = startChatTurn(key, { text, refs }, root, { serverPort: port });
    return streamChatTurn(c, turn);
  });

  // Batch form (the per-file checkbox). Registered before the per-hunk route
  // so "viewed" is never read as a hunk id.
  app.post("/api/prs/:key/hunks/viewed", async (c) => {
    const key = keyParam(c);
    const body = await readJsonBody(c) as { hunkIds?: unknown; viewed?: unknown };
    if (
      !Array.isArray(body.hunkIds) ||
      !body.hunkIds.every((id) => typeof id === "string") ||
      typeof body.viewed !== "boolean"
    ) {
      throw new HttpError(400, "invalid_body", "Body must be { hunkIds: string[], viewed: boolean }");
    }
    try {
      const state = setHunksViewed(key, body.hunkIds as string[], body.viewed, root);
      return c.json({ state });
    } catch (err) {
      throw new HttpError(400, "unknown_hunk", (err as Error).message);
    }
  });

  app.post("/api/prs/:key/hunks/:id/viewed", async (c) => {
    const key = keyParam(c);
    const hunkId = c.req.param("id");
    const body = await readJsonBody(c) as { viewed?: boolean };
    if (typeof body.viewed !== "boolean") {
      throw new HttpError(400, "invalid_body", "Body must include { viewed: boolean }");
    }
    const state = setHunkViewed(key, hunkId, body.viewed, root);
    return c.json({ state });
  });

  app.post("/api/prs/:key/units/:id/viewed", async (c) => {
    const key = keyParam(c);
    const unitId = c.req.param("id");
    const body = await readJsonBody(c) as { viewed?: boolean };
    const viewed = body.viewed ?? true;
    const state = setUnitViewed(key, unitId, viewed, root);
    return c.json({ state });
  });

  app.post("/api/prs/:key/units/:id", async (c) => {
    const key = keyParam(c);
    const unitId = c.req.param("id");
    const body = await readJsonBody(c) as { note?: string } & Record<string, unknown>;
    const { note, ...patch } = body;
    const state = setUnit(key, unitId, patch, { note }, root);
    return c.json({ state });
  });

  app.post("/api/prs/:key/sync", async (c) => {
    const key = keyParam(c);
    let fileSync: Awaited<ReturnType<typeof syncPrAsync>> | undefined;
    let fileSyncError: string | undefined;
    try {
      fileSync = await syncPrAsync(key, root);
    } catch (err) {
      fileSyncError = classifyError(err).message + ": " + String((err as Error).message ?? err);
    }
    const commentSync = await syncCommentsToGithub(key, root);
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
  /**
   * A whole file at the current revision's head, as lines — what "expand
   * context" reveals around hunks. `lines: null` means the file does not exist
   * there (deleted by the PR). Checkout first, contents API otherwise.
   */
  app.get("/api/prs/:key/file", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const filePath = c.req.query("path");
    if (!filePath) throw new HttpError(400, "missing_path", "Query must include ?path=");
    try {
      return c.json(await fileLinesAtHead(key, filePath, root));
    } catch (err) {
      throw new HttpError(502, "file_unavailable", `Could not read ${filePath}: ${(err as Error).message}`);
    }
  });

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

  app.get("/api/prs/:key/agent-notes", (c) => {
    const key = keyParam(c);
    const meta = readMeta(key, root);
    const revision = loadState(key, root).currentRevision;
    const pending = pendingAgentNotes(readComments(key, root));
    const files = readFilesJson(key, revision, root).files;
    return c.json({ pending, markdown: formatAgentNotes(pending, { meta, revision, files }) });
  });

  app.post("/api/prs/:key/agent-notes/pickup", async (c) => {
    const key = keyParam(c);
    readMeta(key, root);
    const { agent, wait } = z.object({
      agent: z.string().trim().min(1),
      wait: z.number().finite().min(0).default(0).transform((n) => Math.min(n, 30)),
    }).parse(await readJsonBody(c));
    await waitForAgentNotes(key, root, wait, c.req.raw.signal);
    if (c.req.raw.signal.aborted) throw new HttpError(499, "request_aborted");
    const meta = readMeta(key, root);
    const revision = loadState(key, root).currentRevision;
    const pending = pendingAgentNotes(readComments(key, root));
    const files = readFilesJson(key, revision, root).files;
    const markdown = formatAgentNotes(pending, { meta, revision, files });
    const marked = markPickedUp(key, pending.map((n) => n.id), agent, root);
    const notes = pending.map((n) => marked.find((m) => m.id === n.id)!);
    return c.json({ notes, markdown, revision });
  });

  /* ------------------------------------------------------------ comments */

  // Experimental tools bind a draft mutation to the revision they read.
  // Check after reading the request body, immediately before synchronous
  // validation/write, so a refresh while HTTP is in flight cannot reanchor it.
  function assertCommentRevision(key: PrKey, expected: string | undefined) {
    if (expected !== undefined && expected !== String(loadState(key, root).currentRevision)) {
      throw new HttpError(409, "stale_revision", "The PR revision changed; start a new run.");
    }
  }

  app.get("/api/prs/:key/comments", (c) => {
    const key = keyParam(c);
    // `deleted` is the trash (deleted drafts, restorable for a while) — see
    // comments.ts. It is never mixed into `comments`.
    return c.json({ comments: readComments(key, root), deleted: readDeletedComments(key, root) });
  });

  app.post("/api/prs/:key/comments", async (c) => {
    const key = keyParam(c);
    const actor = actorOf(c);
    const body = await readJsonBody(c);
    assertCommentRevision(key, c.req.header("X-Purview-Revision"));
    // CLI-created comments (the chat's included) must land inside the current
    // diff: nobody is looking at the line they chose, and a comment outside
    // the diff would only fail later, at push time. The web picks lines from
    // the rendered diff, so it is not re-checked. Replies are exempt.
    if (c.req.header(ACTOR_HEADER) !== undefined) {
      const parsed = NewCommentSchema.safeParse(body);
      // A reply is anchored by its thread, which may well be outdated (its
      // line gone from the diff) — GitHub accepts it regardless.
      if (parsed.success && !parsed.data.inReplyTo) {
        const state = loadState(key, root);
        const files = readFilesJson(key, state.currentRevision, root).files;
        const { file, line, side, subjectType, startLine } = parsed.data;
        if (!files.some((f) => f.path === file)) {
          throw new HttpError(
            422,
            "comment_outside_diff",
            `${file} is not one of the files changed in revision ${state.currentRevision}`,
          );
        }
        if (subjectType === "line" && !findAnchoringHunk(files, file, line!, side!, startLine)) {
          const where = startLine !== undefined ? `${startLine}–${line}` : `${line}`;
          throw new HttpError(
            422,
            "comment_outside_diff",
            `${file}:${where} (${side === "LEFT" ? "old" : "new"} side) is not part of the current diff` +
              (startLine !== undefined ? " — a multi-line comment must stay inside one hunk" : ""),
          );
        }
      }
    }
    // A body may name attachments (`purview-attachment:<id>`); each must
    // exist on this PR, whoever wrote the body — see attachments.ts.
    if (typeof (body as { body?: unknown })?.body === "string") {
      assertAttachmentRefsExist(key, (body as { body: string }).body, root);
    }
    try {
      // Without an explicit audience a comment follows the reader's switch,
      // whoever writes it: the web, the CLI, the chat.
      const comment = addComment(key, body, root, actor, commentAudienceFor(key, root).effective);
      return c.json({ comment }, 201);
    } catch (err) {
      throw classifyError(err);
    }
  });

  /**
   * "Publish now": one GitHub draft goes out as a standalone review comment,
   * public the moment GitHub accepts it — no pending review, no submit. The
   * confirmation is the same friction as submitting a review, for the same
   * reason: there is no taking it back. The chat never publishes anything.
   */
  app.post("/api/prs/:key/comments/:id/publish", async (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const body = await readJsonBody(c) as { confirm?: unknown };
    const actor = actorOf(c);
    if (isAgentActor(actor)) {
      throw new HttpError(409, "not_allowed", "The review chat may not publish comments; only the reader can.");
    }
    const target = readComments(key, root).find((c2) => c2.id === id);
    if (!target) throw new HttpError(404, "not_found", `No comment "${id}"`);
    if (target.audience === "agent") {
      throw new HttpError(400, "agent_comment", "This comment is a note for an agent; move it to GitHub first.");
    }
    if (target.status !== "draft") {
      throw new HttpError(400, "not_draft", `Only a draft can be published; comment ${id} is ${target.status}`);
    }
    if (target.inReplyTo) {
      throw new HttpError(400, "reply_not_publishable", "A reply goes out with the review it belongs to.");
    }
    if (body.confirm !== true) {
      throw new HttpError(
        400,
        "confirmation_required",
        "Publishing a comment is public and irreversible; resend with { confirm: true }",
      );
    }
    const state = loadState(key, root);
    if (target.subjectType === "line") {
      const files = readFilesJson(key, state.currentRevision, root).files;
      if (!findAnchoringHunk(files, target.file, target.line!, target.side!, target.startLine)) {
        throw new HttpError(
          422,
          "comment_outside_diff",
          `${target.file}:${target.line} is not part of the current diff — edit its position or use "Suggest new anchor"`,
        );
      }
    }
    const commitId = headShaOf(key, root);
    if (!commitId) throw new HttpError(400, "no_commit_id", "No head sha on record for the current revision");
    // Pictures go up first, exactly as at push time; the local text takes the
    // rewritten form once GitHub has it.
    let outgoing: string;
    try {
      outgoing = await resolveBodyForGithub(key, target.body, root);
    } catch (err) {
      throw new HttpError(502, "attachment_upload_failed", err instanceof Error ? err.message : String(err));
    }
    const input =
      target.subjectType === "file"
        ? { subjectType: "file" as const, path: target.file, body: outgoing }
        : {
            subjectType: "line" as const,
            path: target.file,
            line: target.line!,
            side: target.side!,
            ...(target.startLine !== undefined
              ? { startLine: target.startLine, startSide: target.startSide ?? target.side! }
              : {}),
            body: outgoing,
          };
    let created;
    try {
      created = await createStandaloneReviewComment(key, commitId, input);
      log.info("github", `${shortKey(key)}  comment published`, { id: created.databaseId });
    } catch (err) {
      const e = classifyGhReviewError(err);
      throw new HttpError(e.status ?? 502, e.code, e.message);
    }
    const comment = markPublished(
      key,
      id,
      { githubCommentId: created.databaseId, githubCommentNodeId: created.nodeId, body: outgoing },
      root,
    );
    clearStalenessCache(key, root);
    return c.json({ comment, url: created.htmlUrl });
  });

  app.delete("/api/prs/:key/comments/:id", async (c) => {
    const key = keyParam(c);
    assertCommentRevision(key, c.req.header("X-Purview-Revision"));
    const id = c.req.param("id");
    const actor = actorOf(c);
    const target = readComments(key, root).find((cc) => cc.id === id);
    if (!target) throw new HttpError(404, "not_found", `No comment "${id}"`);
    assertChatMayTouch(actor, target, "delete");
    const result = await deleteComment(key, id, root, actor);
    if (!result.removed) throw new HttpError(404, "not_found", `No comment "${id}"`);
    // Its pictures go with it, unless another comment (or the trash, which
    // can bring a draft back) still refers to them. Local files only.
    pruneAttachments(key, allCommentBodies(key, root), root);
    // A failed remote delete is reported, never fatal — see comments.ts.
    return c.json({ ok: true, trashed: result.trashed ?? false, remote: result.remote ?? null });
  });

  /** Bring a deleted draft back out of the trash (same id, still a draft). */
  app.post("/api/prs/:key/comments/:id/restore", (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const comment = restoreDeletedComment(key, id, root);
    if (!comment) {
      throw new HttpError(404, "not_found", `No deleted comment "${id}" to restore (it may have expired)`);
    }
    return c.json({ comment });
  });

  /** Put back the body a draft had before its latest edit (see `undoCommentEdit`). */
  app.post("/api/prs/:key/comments/:id/undo-edit", (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const result = undoCommentEdit(key, id, root);
    if (!result.ok) {
      if (result.reason === "not_found") throw new HttpError(404, "not_found", `No comment "${id}"`);
      if (result.reason === "not_draft") {
        throw new HttpError(409, "not_draft", "Only a draft's edits can be undone");
      }
      throw new HttpError(409, "no_history", "This comment has no earlier body to go back to");
    }
    return c.json({ comment: result.comment });
  });

  /**
   * Re-anchoring a draft comment that fell outside the current diff and that
   * `reanchorDraftComments` couldn't place deterministically (its hunk itself
   * changed or vanished, so there's no exact offset to carry over). Only ever
   * proposes — nothing is applied here; the reader accepts via the PATCH
   * below. 400s for anything but a draft line comment: pushed/submitted
   * comments are anchored on GitHub already, and a file comment has no line
   * to re-anchor.
   */
  app.post("/api/prs/:key/comments/:id/reanchor", async (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const target = readComments(key, root).find((cc) => cc.id === id);
    if (!target) throw new HttpError(404, "not_found", `No comment "${id}"`);
    if (target.status !== "draft" || target.subjectType !== "line" || target.inReplyTo) {
      throw new HttpError(
        400,
        "not_reanchorable",
        "Only draft line comments can be re-anchored (not replies, which follow their thread)",
      );
    }
    const result = await proposeCommentReanchor(key, target, root);
    return c.json(result);
  });

  /**
   * Editing a comment. Two independent things ride this one route:
   *
   *   - `{ body }` — edit the text. What happens beyond the local write
   *     depends on status:
   *       draft     — local only, no GitHub call.
   *       pushed    — local write always happens, then a best-effort GraphQL
   *                   update via the stored githubCommentId. That id can be
   *                   missing (a known backfill gap, see comment-sync.ts);
   *                   when it is, we still save locally and report a
   *                   structured remote failure instead of hard-failing.
   *       submitted — same remote update, but the edit is publicly visible so
   *                   it requires an explicit { confirm: true }.
   *     An unchanged body is a 200 no-op before any of the above, including
   *     the confirm requirement.
   *
   *   - `{ line?, file? }` — move a draft's anchor (the accept step of
   *     "Suggest new anchor", or a manual re-anchor). Draft line comments
   *     only — 400 for pushed/submitted (already anchored on GitHub) or
   *     file-level comments. The target must land inside a hunk of the
   *     current diff; GitHub itself is never consulted for this, since a
   *     draft never left the local store.
   */
  app.patch("/api/prs/:key/comments/:id", async (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const body = await readJsonBody(c) as {
      body?: unknown;
      confirm?: boolean;
      line?: unknown;
      file?: unknown;
      audience?: unknown;
    };

    assertCommentRevision(key, c.req.header("X-Purview-Revision"));
    const actor = actorOf(c);
    const existing = readComments(key, root);
    let target = existing.find((c2) => c2.id === id);
    if (!target) throw new HttpError(404, "not_found", `No comment "${id}"`);
    assertChatMayTouch(actor, target, "edit");

    // Audience first: it may come alone ("move to agent") or with an edit.
    if (body.audience !== undefined) {
      const parsedAudience = CommentAudienceSchema.safeParse(body.audience);
      if (!parsedAudience.success) {
        throw new HttpError(400, "invalid_body", 'audience must be "github" or "agent"');
      }
      try {
        const moved = setCommentAudience(key, id, parsedAudience.data, root);
        if (!moved) throw new HttpError(404, "not_found", `No comment "${id}"`);
        target = moved;
      } catch (err) {
        if (err instanceof CommentNotDraftError) throw new HttpError(400, "not_draft", err.message);
        throw err;
      }
      if (body.body === undefined && body.line === undefined && body.file === undefined) {
        return c.json({ comment: target, remote: null });
      }
    }

    if (body.line !== undefined || body.file !== undefined) {
      if (target.status !== "draft") {
        throw new HttpError(400, "not_draft", "Only draft comments can be repositioned");
      }
      if (target.subjectType !== "line") {
        throw new HttpError(400, "not_line_comment", "Only line comments can be repositioned");
      }
      if (target.inReplyTo) {
        throw new HttpError(400, "reply_not_movable", "A reply sits on its thread and cannot be repositioned");
      }
      const nextLine = body.line !== undefined ? body.line : target.line;
      const nextFile = body.file !== undefined ? body.file : target.file;
      if (typeof nextLine !== "number" || !Number.isInteger(nextLine)) {
        throw new HttpError(400, "invalid_body", "line must be an integer");
      }
      if (typeof nextFile !== "string" || nextFile.trim() === "") {
        throw new HttpError(400, "invalid_body", "file must be a non-empty string");
      }
      const state = loadState(key, root);
      const currentFiles = readFilesJson(key, state.currentRevision, root).files;
      // A range moves as a whole (see `updateCommentPosition`), so the whole
      // shifted range has to land inside one hunk.
      const nextStart =
        target.startLine !== undefined ? target.startLine + (nextLine - target.line!) : undefined;
      const hunk = findAnchoringHunk(currentFiles, nextFile, nextLine, target.side ?? "RIGHT", nextStart);
      if (!hunk) {
        throw new HttpError(
          422,
          "comment_outside_diff",
          `${nextFile}:${nextStart !== undefined ? `${nextStart}–` : ""}${nextLine} is not part of the current diff`,
        );
      }
      const moved = updateCommentPosition(key, id, { line: nextLine, file: nextFile }, root);
      if (!moved.found || !moved.comment) throw new HttpError(404, "not_found", `No comment "${id}"`);
      return c.json({ comment: moved.comment });
    }

    if (typeof body.body !== "string" || body.body.trim() === "") {
      throw new HttpError(400, "invalid_body", "Body must include a non-empty { body: string }");
    }
    const newBody = body.body;

    if (target.body === newBody) {
      return c.json({ comment: target, remote: null });
    }
    assertAttachmentRefsExist(key, newBody, root);

    if (target.status === "submitted" && body.confirm !== true) {
      throw new HttpError(
        400,
        "confirm_required_public_edit",
        "Editing a submitted (public) comment is visible to others; resend with { confirm: true }",
      );
    }

    const result = updateCommentBody(key, id, newBody, root, actor);
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
      nodeId = await recoverCommentNodeId(key, target, root);
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
    // An edit may add a picture to a comment that is already on GitHub: it
    // is uploaded here, exactly as at push time, and the local text takes
    // the rewritten form once GitHub has it. A failed upload is reported
    // like a failed remote update — saved locally, GitHub not updated.
    let outgoing: string;
    try {
      outgoing = await resolveBodyForGithub(key, newBody, root);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return c.json({ comment: result.comment, remote: { ok: false, reason } });
    }
    try {
      await updatePullRequestReviewCommentBody(key, nodeId, outgoing);
      if (outgoing !== newBody) setCommentBody(key, id, outgoing, root);
      return c.json({
        comment: { ...result.comment, body: outgoing, githubCommentNodeId: nodeId },
        remote: { ok: true },
      });
    } catch (err) {
      const e = classifyGhReviewError(err);
      return c.json({ comment: result.comment, remote: { ok: false, reason: e.message } });
    }
  });

  /* ---------------------------------------------------------- attachments */

  /**
   * Pictures for comments, kept under the PR's state dir until a push uploads
   * them to GitHub (see attachments.ts). The upload is the raw file as the
   * body, its name in the query — the same shape GitHub's own endpoint takes,
   * and what `fetch(url, { body: file })` sends without a multipart dance.
   */
  app.get("/api/prs/:key/attachments", (c) => {
    const key = keyParam(c);
    return c.json({ attachments: readAttachments(key, root) });
  });

  app.post("/api/prs/:key/attachments", async (c) => {
    const key = keyParam(c);
    if (!prExists(key, root)) throw new HttpError(404, "not_found", `${keyToString(key)} is not tracked`);
    const name = c.req.query("name")?.trim();
    if (!name) throw new HttpError(400, "missing_name", "`?name=<file name>` is required");
    const bytes = Buffer.from(await c.req.arrayBuffer());
    const attachment = storeAttachment(key, { name, mime: c.req.header("content-type"), bytes }, root);
    return c.json({ attachment }, 201);
  });

  /** The local copy, for previews — before the push and after it. */
  app.get("/api/prs/:key/attachments/:id", (c) => {
    const key = keyParam(c);
    const attachment = findAttachment(key, c.req.param("id"), root);
    const file = attachment ? attachmentFilePath(key, attachment, root) : undefined;
    if (!attachment || !file || !fs.existsSync(file)) {
      throw new HttpError(404, "not_found", `No attachment "${c.req.param("id")}"`);
    }
    return new Response(fs.readFileSync(file), {
      headers: {
        "content-type": attachment.mime,
        "content-disposition": "inline",
        // The id is a UUID minted at upload: the bytes behind it never change.
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        // An SVG is a document: opened directly it could run script on this
        // origin. Sandboxed, it still draws fine inside an <img>.
        ...(attachment.mime === "image/svg+xml" ? { "content-security-policy": "sandbox" } : {}),
      },
    });
  });

  /** Drop a local attachment nothing refers to (a thumbnail removed, a composer discarded). */
  app.delete("/api/prs/:key/attachments/:id", (c) => {
    const key = keyParam(c);
    const id = c.req.param("id");
    const outcome = deleteAttachment(key, id, allCommentBodies(key, root), root);
    if (outcome === "missing") throw new HttpError(404, "not_found", `No attachment "${id}"`);
    if (outcome === "referenced") {
      throw new HttpError(409, "attachment_in_use", "A comment still refers to this attachment");
    }
    return c.json({ ok: true });
  });

  /**
   * Someone else's picture — the description's screenshots, an image in a
   * review or a comment — fetched once from GitHub with the reader's token and
   * kept under the PR (see remote-images.ts). The page only ever talks to
   * this server; GitHub's image hosts are the only ones proxied.
   */
  app.get("/api/prs/:key/image", async (c) => {
    const key = keyParam(c);
    if (!prExists(key, root)) throw new HttpError(404, "not_found", `${keyToString(key)} is not tracked`);
    const url = c.req.query("url")?.trim();
    if (!url) throw new HttpError(400, "missing_url", "`?url=<picture URL>` is required");
    const image = await fetchRemoteImage(key, url, root);
    return new Response(fs.readFileSync(remoteImageFilePath(key, image, root)), {
      headers: {
        "content-type": image.mime,
        "content-disposition": "inline",
        "cache-control": REMOTE_IMAGE_CACHE_CONTROL,
        "x-content-type-options": "nosniff",
        // An SVG is a document: sandboxed, it draws inside an <img> but runs
        // nothing on this origin.
        ...(image.mime === "image/svg+xml" ? { "content-security-policy": "sandbox" } : {}),
      },
    });
  });

  /* ------------------------------------------------------ review threads */

  /**
   * The PR's GitHub review threads (everyone's), live, cached in threads.json.
   * Always 200: when GitHub is unreachable the cached copy (or none) comes
   * back with `error` set — see github-threads.ts.
   */
  function trackedKey(c: Context): PrKey {
    const key = keyParam(c);
    if (!prExists(key, root)) throw new HttpError(404, "not_found", `${keyToString(key)} is not tracked`);
    return key;
  }

  app.get("/api/prs/:key/threads", async (c) => {
    const key = trackedKey(c);
    return c.json(await loadThreads(key, { root, aiReviewers: readConfig(root).aiReviewers }));
  });

  app.post("/api/prs/:key/comments/:commentId/reactions", async (c) => {
    const key = trackedKey(c);
    const { content, on } = z.object({
      content: z.enum(REACTION_CONTENTS),
      on: z.boolean(),
    }).parse(await readJsonBody(c));
    try {
      const result = await setReaction(key, c.req.param("commentId"), content, on, root);
      log.info("github", `${shortKey(key)}  reaction toggled`, { content, on });
      return c.json(result);
    } catch (err) {
      throw classifyError(err);
    }
  });

  for (const action of ["resolve", "unresolve"] as const) {
    app.post(`/api/prs/:key/threads/:id/${action}`, async (c) => {
      const key = trackedKey(c);
      const id = c.req.param("id");
      try {
        const result = await setThreadResolved(key, id, action === "resolve", root);
        log.info("github", `${shortKey(key)}  thread ${action === "resolve" ? "resolved" : "unresolved"}`, { id });
        return c.json(result);
      } catch (err) {
        throw classifyError(err);
      }
    });
  }

  /* -------------------------------------------------------------- review */

  app.get("/api/prs/:key/review", async (c) => {
    const key = keyParam(c);
    const remote = c.req.query("remote") !== "0";
    return c.json(await reviewStatus(key, root, { checkRemote: remote }));
  });

  app.post("/api/prs/:key/review", async (c) => {
    const key = keyParam(c);
    const body = await readJsonBody(c) as { body?: unknown };
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
    const body = await readJsonBody(c) as {
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
    const result = await submitReview(
      key,
      { event: body.event as SubmitEvent, body: body.body },
      root,
    );
    // Its cached answer predates the review's effect on the decision.
    clearStalenessCache(key, root);
    return c.json({ ...result, state: loadState(key, root) });
  });

  app.delete("/api/prs/:key/review/pending", async (c) => {
    const key = keyParam(c);
    return c.json(await discardPendingReview(key, root));
  });

  /* --------------------------------------------------------------- repos */

  /**
   * The repo view of the same state tree. A repo exists here as soon as one of
   * its PRs is tracked (or it has settings of its own), and every field is
   * answered from disk: this endpoint must stay network-free, so the committed
   * flag reports the latest *cached* team config rather than fetching one.
   */
  app.get("/api/repos", (c) => {
    const repos = listRepos(root).map((repo) => {
      const prs = listPrs(root).filter(
        (k) => k.host === repo.host && k.owner === repo.owner && k.repo === repo.repo,
      );
      let archivedCount = 0;
      for (const pr of prs) {
        try {
          if (readMeta(pr, root).archived === true) archivedCount++;
        } catch {
          /* an unreadable meta shouldn't hide the whole repo */
        }
      }
      const local = readRepoConfig(repo, root);
      return {
        ...repo,
        prCount: prs.length,
        archivedCount,
        // The repo-level shelf (see schemas.ts). State, not configuration, so
        // it does not count towards `hasLocalConfig`.
        archived: local.archived === true,
        // "Has local config" means something is actually set — the empty
        // repo.json auto-created with the first PR is not configuration.
        hasLocalConfig:
          local.autoAnalyze !== null ||
          local.repoPath !== null ||
          local.analysisAgent !== null ||
          local.chatAgent !== null ||
          local.watchReviews !== null ||
          readLocalRubric(repo, root).trim() !== "" ||
          readLocalChatInstructions(repo, root).trim() !== "",
        hasCommittedConfig: cachedCommittedConfigForRepo(repo, root)?.present ?? false,
        repoPath: local.repoPath,
        // Machine-local, not layered (see schemas.ts): the raw setting is the
        // whole story, so no `effectiveConfig` resolution is involved.
        watchReviews: local.watchReviews === true,
        watch: getWatchStatus().repos[repoKeyToString(repo)] ?? null,
      };
    });
    return c.json({ repos });
  });

  /** `:rkey` = URL-encoded `host/owner/repo`. */
  function repoKeyParam(c: { req: { param(name: string): string | undefined } }): RepoKey {
    const raw = c.req.param("rkey");
    if (!raw) throw new HttpError(400, "missing_key", "Repo key is required");
    try {
      return parseRepoKey(raw);
    } catch (err) {
      throw classifyError(err);
    }
  }

  /** The newest tracked PR of a repo — the one that speaks for it. */
  function newestPr(repo: RepoKey): PrKey | undefined {
    const prs = listPrs(root).filter(
      (k) => k.host === repo.host && k.owner === repo.owner && k.repo === repo.repo,
    );
    let best: { key: PrKey; meta: Meta } | undefined;
    for (const key of prs) {
      let meta: Meta;
      try {
        meta = readMeta(key, root);
      } catch {
        continue;
      }
      if (!best || meta.createdAt > best.meta.createdAt) best = { key, meta };
    }
    return best?.key;
  }

  /**
   * One shape for both GET and PUT: the caller always gets back the whole
   * resolved picture (what is stored locally, what the team committed, what
   * the two of them add up to), so a write needs no follow-up read.
   */
  async function repoConfigPayload(repo: RepoKey) {
    const local = readRepoConfig(repo, root);
    const pr = newestPr(repo);
    // Reading the committed config may go to GitHub; it is cached per
    // revision, so this is one fetch per revision and free afterwards.
    const committed = pr
      ? await (async () => {
          try {
            return await loadCommittedConfig(pr, root);
          } catch {
            return cachedCommitted(pr, root);
          }
        })()
      : null;
    const effective = effectiveConfig(repo, root, {
      local,
      committed: committed?.config ?? null,
    });
    return {
      repo: repoKeyToString(repo),
      local: {
        autoAnalyze: local.autoAnalyze,
        repoPath: local.repoPath,
        analysisAgent: local.analysisAgent,
        chatAgent: local.chatAgent,
        watchReviews: local.watchReviews,
        generated: local.generated,
        rubric: readLocalRubric(repo, root),
        chatInstructions: readLocalChatInstructions(repo, root),
      },
      committed: {
        present: committed?.present ?? false,
        config: committed?.config ?? null,
        rubric: committed?.rubric ?? null,
        chat: committed?.chatInstructions ?? null,
      },
      effective: {
        autoAnalyze: effective.autoAnalyze.value,
        repoPath: effective.repoPath.value,
        analysisAgent: agentView(effective.analysisAgent),
        chatAgent: agentView(effective.chatAgent),
      },
      sources: {
        autoAnalyze: effective.autoAnalyze.source,
        repoPath: effective.repoPath.source,
      },
    };
  }

  /* ------------------------------------------------- global (machine) config */

  /**
   * `~/.purview/config.json`, the outermost layer. Only the settings a UI has
   * any business changing are exposed; onboarding owns the rest of the file.
   */
  function globalConfigPayload() {
    const config = readConfig(root);
    return {
      analysisAgent: config.analysisAgent,
      chatAgent: config.chatAgent,
      managedCheckouts: config.managedCheckouts,
      aiReviewers: config.aiReviewers,
      extraAuthors: config.extraAuthors,
      updateCheck: config.updateCheck,
      /** what this layer resolves to on its own — the end of the inheritance chain */
      effective: {
        analysisAgent: agentView(resolveAgent("analysis", [["global", config.analysisAgent]], true)),
        chatAgent: agentView(resolveAgent("chat", [["global", config.chatAgent]], false)),
      },
    };
  }

  const dedupeLogins = (logins: string[]): string[] => {
    const seen = new Set<string>();
    return logins.filter((l) => {
      const k = l.toLowerCase();
      return seen.has(k) ? false : (seen.add(k), true);
    });
  };

  const GlobalConfigPutSchema = z
    .object({
      analysisAgent: AgentSelectionSchema.strict().nullable().optional(),
      chatAgent: ChatAgentSelectionSchema.strict().nullable().optional(),
      managedCheckouts: z.boolean().optional(),
      /** logins treated as AI reviewers; the whole list, replacing the stored one */
      aiReviewers: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
      /** logins whose PRs count as yours on the list; the whole list, replacing the stored one */
      extraAuthors: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
      /** ask origin for newer releases once a day */
      updateCheck: z.boolean().optional(),
      /** what new comments are for: the GitHub review, or notes for an agent */
    })
    .strict();

  app.get("/api/config", (c) => c.json(globalConfigPayload()));

  /* ------------------------------------------------------------- version */

  /**
   * The running version (the newest CHANGELOG.md heading), the checkout's
   * commit, the last version this reader was shown, the entries to show now,
   * and — when the reader allows the daily check — the newer release on
   * origin, if any. The web asks on the home page: "What's new" when `unseen`
   * is not empty, an update chip when `latest` is set.
   */
  app.get("/api/version", async (c) => {
    const entries = readChangelog();
    const config = readConfig(root);
    const version = entries[0]?.version ?? null;
    const update = config.updateCheck ? await updateChecker.status(version) : { latest: null, checkedAt: null };
    return c.json({
      version,
      sha: headSha(),
      lastSeen: config.lastSeenVersion,
      unseen: entriesSince(entries, config.lastSeenVersion),
      entries,
      latest: update.latest,
      checkedAt: update.checkedAt,
      updateCheck: config.updateCheck,
    });
  });

  /** "Check now": ask origin regardless of the daily cache; the flag still has to be on. */
  app.post("/api/version/check", async (c) => {
    const config = readConfig(root);
    if (!config.updateCheck) throw new HttpError(409, "update_check_off", "The update check is turned off");
    const version = readChangelog()[0]?.version ?? null;
    return c.json(await updateChecker.check(version));
  });

  /** The reader closed "What's new": remember the version, never go backwards. */
  app.post("/api/version/seen", async (c) => {
    const body = await readJsonBody(c) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version) {
      throw new HttpError(400, "invalid_body", "Body must include { version: string }");
    }
    const current = readConfig(root).lastSeenVersion;
    const next = current && compareVersions(current, body.version) >= 0 ? current : body.version;
    if (next !== current) writeConfig({ lastSeenVersion: next }, root);
    return c.json({ lastSeen: next });
  });

  /**
   * The harnesses this server can run, as their manifests describe them: the
   * settings UI builds its choices from these, and copy names the agent by
   * `agentName` instead of assuming one.
   */
  app.get("/api/agents", (c) =>
    c.json({
      default: DEFAULT_HARNESS,
      harnesses: registeredHarnessIds().map((id) => {
        const { toolNames: _toolNames, inlineOutputLimit: _limit, ...manifest } = getHarness(id).manifest;
        // Unlisted: registered by the private override only, so the settings
        // pickers leave it out while a chat already on it can still name models.
        return { ...manifest, listed: listedHarnessIds().includes(id) };
      }),
    }),
  )

  app.put("/api/config", async (c) => {
    const parsed = GlobalConfigPutSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(
        400,
        "invalid_body",
        `${issue.path.join(".") || "(body)"}: ${issue.message}`,
      );
    }
    const body = parsed.data;
    const patch: Partial<ReviewerConfig> = {};
    if (body.analysisAgent !== undefined) {
      patch.analysisAgent = checkAgentSelection(body.analysisAgent, "analysisAgent");
    }
    if (body.chatAgent !== undefined) patch.chatAgent = checkAgentSelection(body.chatAgent, "chatAgent");
    if (body.managedCheckouts !== undefined) patch.managedCheckouts = body.managedCheckouts;
    // Both login lists are stored as typed, minus case-insensitive duplicates.
    if (body.aiReviewers !== undefined) patch.aiReviewers = dedupeLogins(body.aiReviewers);
    if (body.extraAuthors !== undefined) patch.extraAuthors = dedupeLogins(body.extraAuthors);
    if (body.updateCheck !== undefined) patch.updateCheck = body.updateCheck;
    if (Object.keys(patch).length > 0) writeConfig(patch, root);
    return c.json(globalConfigPayload());
  });

  /* ---------------------------------------------------------- LAN access */

  /**
   * Both endpoints are loopback-only: the payload contains a URL with the
   * token in it, and the whole point of the token is that a LAN client cannot
   * obtain one by asking. `active` is the honest answer to "can another device
   * reach this?" — it is false for every run not started with `--lan`, and
   * there is nothing here that could change that without a restart.
   */
  async function lanPayload() {
    const url = lan ? lanUrl(lan.hosts, port, lan.token) : null;
    return {
      active: lan !== null,
      url,
      qrSvg: url ? await lanQrSvg(url) : null,
      warning: LAN_WARNING,
    };
  }

  app.use("/api/lan", loopbackOnly({ port }));
  app.use("/api/lan/*", loopbackOnly({ port }));

  app.get("/api/lan", async (c) => c.json(await lanPayload()));

  /**
   * A fresh token. Every device that scanned an older QR code is locked out —
   * immediately, not at the next restart, because the guard reads the token
   * off the same object this writes.
   */
  app.post("/api/lan/token", async (c) => {
    const token = generateLanToken();
    writeConfig({ lan: { token } }, root);
    if (lan) lan.token = token;
    return c.json(await lanPayload());
  });

  app.get("/api/repos/:rkey/config", async (c) => {
    return c.json(await repoConfigPayload(repoKeyParam(c)));
  });

  const ImportReviewsSchema = z
    .object({ days: z.number().int().min(1).max(90).default(7) })
    .strict();

  /**
   * Bulk-import every open, review-requested PR of this repo updated in the
   * last `days` days, exactly as `POST /api/prs` would for each one. Mirrors
   * that endpoint's auto-analyze gating: the process-wide switch, then the
   * per-repo/committed/global layering via `autoAnalyzeAllowed` — evaluated
   * once here (a bulk import is one request; the layers do not change hunk to
   * hunk within it), not per PR like the single-PR endpoint does.
   */
  app.post("/api/repos/:rkey/import-reviews", async (c) => {
    const repo = repoKeyParam(c);
    const parsed = ImportReviewsSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(
        400,
        "invalid_body",
        `${issue.path.join(".") || "(body)"}: ${issue.message}`,
      );
    }
    const { days } = parsed.data;
    // Repo-scoped, not PR-scoped, so there is no `meta.archived` to check —
    // `autoAnalyzeAllowed`'s archive guard only applies once a PR exists.
    // Each newly imported PR is untracked by definition, so only its repo can
    // make it archived: an archived repo's imports land on the shelf too, and
    // an explicit import is not consent to spend on them.
    const analyze =
      autoAnalyze && effectiveConfig(repo, root).autoAnalyze.value && !isRepoArchived(repo, root);
    const result = await importReviewRequests(repo, days, root, { analyze });
    return c.json({ ...result, days });
  });

  /** 404 for a repo with no local state at all (no PR dir, no repo.json). */
  function assertRepoTracked(repo: RepoKey): void {
    const tracked = listRepos(root).some(
      (r) => r.host === repo.host && r.owner === repo.owner && r.repo === repo.repo,
    );
    if (!tracked) {
      throw new HttpError(404, "not_found", `${repoKeyToString(repo)} is not tracked in Purview`);
    }
  }

  /**
   * Archive (or unarchive) a whole repo. A flag in `repo.json`, not a sweep
   * over the PRs: each PR's own `meta.archived` is left exactly as it was, so
   * unarchiving restores the previous mix of archived and active PRs. While
   * it is set, every PR in the repo behaves as archived (`isEffectivelyArchived`)
   * and the review watcher stops importing for it.
   */
  app.post("/api/repos/:rkey/archive", async (c) => {
    const repo = repoKeyParam(c);
    assertRepoTracked(repo);
    const body = await readJsonBody(c) as { archived?: unknown };
    if (typeof body.archived !== "boolean") {
      throw new HttpError(400, "invalid_body", "Body must include { archived: boolean }");
    }
    // `null`, not `false`, when unarchiving: absent and off are one state.
    const local = writeRepoConfig(repo, { archived: body.archived ? true : null }, root);
    // Same as a PR archive: its managed checkouts are no longer needed.
    if (local.archived) {
      void pruneCheckouts(root).catch((err: unknown) =>
        log.warn("checkout", "prune failed", { reason: (err as Error).message }),
      );
    }
    return c.json({ ok: true, archived: local.archived === true });
  });

  /**
   * What removing the repo would lose (PRs, unsubmitted comments) and what
   * blocks it right now. Read-only; the confirm UI shows it before anything
   * is deleted.
   */
  app.get("/api/repos/:rkey/removal", (c) => {
    return c.json(repoRemovalSummary(repoKeyParam(c), root));
  });

  /**
   * Remove a repo from Purview: every byte of its local state and its managed
   * checkouts. Nothing on GitHub changes. Loopback-only — it is the one
   * endpoint that deletes a whole tree of state — and 409 while any of its
   * PRs has an analysis queued/running or a chat reply streaming.
   */
  app.delete("/api/repos/:rkey", loopbackOnly({ port }), async (c) => {
    const repo = repoKeyParam(c);
    const result = await removeRepo(repo, root);
    const prefix = `v2|${repoKeyToString(repo)}/`;
    for (const k of [...lineChangesCache.keys()]) if (k.startsWith(prefix)) lineChangesCache.delete(k);
    return c.json({ ok: true, ...result });
  });

  /**
   * Partial by design: only the keys present in the body are written, and
   * `null` means "inherit again" (which is not the same as `false`). An empty
   * `rubric` deletes `RUBRIC.local.md`.
   */
  const RepoConfigPutSchema = z
    .object({
      autoAnalyze: z.boolean().nullable().optional(),
      repoPath: z.string().nullable().optional(),
      analysisAgent: AgentSelectionSchema.strict().nullable().optional(),
      chatAgent: ChatAgentSelectionSchema.strict().nullable().optional(),
      watchReviews: z.boolean().nullable().optional(),
      /** either list replaces the stored one; blank lines are dropped */
      generated: z
        .object({
          include: z.array(z.string().max(500)).max(500).optional(),
          exclude: z.array(z.string().max(500)).max(500).optional(),
        })
        .strict()
        .optional(),
      rubric: z.string().optional(),
      chatInstructions: z.string().optional(),
    })
    .strict();

  app.put("/api/repos/:rkey/config", async (c) => {
    const repo = repoKeyParam(c);
    const parsed = RepoConfigPutSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(
        400,
        "invalid_body",
        `${issue.path.join(".") || "(body)"}: ${issue.message}`,
      );
    }
    const body = parsed.data;

    const patch: Partial<RepoConfig> = {};
    if ("autoAnalyze" in body) patch.autoAnalyze = body.autoAnalyze ?? null;
    if (body.analysisAgent !== undefined) {
      patch.analysisAgent = checkAgentSelection(body.analysisAgent, "analysisAgent");
    }
    if (body.chatAgent !== undefined) patch.chatAgent = checkAgentSelection(body.chatAgent, "chatAgent");
    if ("watchReviews" in body) patch.watchReviews = body.watchReviews ?? null;
    let generatedChanged = false;
    if (body.generated) {
      const current = readRepoConfig(repo, root).generated;
      const clean = (list: string[] | undefined, fallback: string[]) =>
        list === undefined ? fallback : [...new Set(list.map((g) => g.trim()).filter((g) => g !== ""))];
      patch.generated = {
        include: clean(body.generated.include, current.include),
        exclude: clean(body.generated.exclude, current.exclude),
      };
      generatedChanged = JSON.stringify(patch.generated) !== JSON.stringify(current);
    }
    if ("repoPath" in body) {
      // Same validation as the per-PR endpoint: a path that isn't there is a
      // typo, and storing it would only fail later, silently.
      const raw = body.repoPath;
      patch.repoPath =
        raw === null || raw === undefined || raw.trim() === ""
          ? null
          : resolveRepoPathInput(raw);
    }
    if (Object.keys(patch).length > 0) writeRepoConfig(repo, patch, root);
    // Cached facts only: re-classifying a repo's PRs must not hit the network.
    if (generatedChanged) reclassifyRepo(repo, root);
    if (body.rubric !== undefined) writeLocalRubric(repo, body.rubric, root);
    if (body.chatInstructions !== undefined) {
      writeLocalChatInstructions(repo, body.chatInstructions, root);
    }

    return c.json(await repoConfigPayload(repo));
  });

  /* ------------------------------------------------ revision line changes */

  /**
   * The lines one revision changed, mapped forward onto the current
   * revision's hunk ids — what the unit changelog highlights in the diff.
   * Revisions never change once written, so the answer only moves when the
   * PR gains a revision: cached per (PR, revision, current revision).
   */
  const lineChangesCache = new Map<string, RevisionLineChanges>();
  app.get("/api/prs/:key/revisions/:n/line-changes", (c) => {
    const key = keyParam(c);
    const n = Number(c.req.param("n"));
    const state = loadState(key, root);
    // `v2`: positional payload (lines/removedAt); never serve a text-multiset entry.
    const cacheKey = `v2|${keyToString(key)}|${n}|${state.currentRevision}`;
    const cached = lineChangesCache.get(cacheKey);
    if (cached) return c.json(cached);
    let result: RevisionLineChanges;
    try {
      result = revisionLineChanges(key, n, root);
    } catch (err) {
      if (err instanceof UnknownRevisionError) throw new HttpError(404, "not_found", err.message);
      throw err;
    }
    // Bounded: a reader clicks through a handful of revisions, not hundreds.
    if (lineChangesCache.size >= 64) {
      const oldest = lineChangesCache.keys().next().value;
      if (oldest !== undefined) lineChangesCache.delete(oldest);
    }
    lineChangesCache.set(cacheKey, result);
    return c.json(result);
  });

  /* -------------------------------------------------------- misc / debug */

  app.get("/api/prs/:key/migration/:revision", (c) => {
    const key = keyParam(c);
    const revision = Number(c.req.param("revision"));
    const report = readMigrationReport(key, revision, root);
    if (!report) throw new HttpError(404, "not_found", `No migration report for revision ${revision}`);
    return c.json(report);
  });

  /**
   * "Has this PR moved since we last fetched it?" — one cheap `gh` call,
   * cached per PR (see staleness.ts), answering 200 even when `gh` fails so a
   * polling client can never break the view.
   */
  app.get("/api/prs/:key/staleness", async (c) => {
    const key = keyParam(c);
    readMeta(key, root); // 404s for an unknown PR before spending a gh call
    return c.json(await checkStaleness(key, root));
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
