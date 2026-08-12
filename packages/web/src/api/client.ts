import { mockApi } from "../mocks/server";
import { frameJson, readSseStream } from "../lib/sse";
import { ApiError } from "./errors";
import type {
  AnalysisJob,
  ChatMessage,
  ChatRef,
  ChatState,
  ChatStreamEvent,
  CommentStatus,
  DiffOfDiffs,
  DiscardPendingResult,
  DraftComment,
  EditCommentResult,
  FileEntry,
  FileRollup,
  Hunk,
  MigrationReport,
  MigrationReportItem,
  PrDetail,
  PrListEntry,
  PrState,
  ReviewEvent,
  RepoPathResult,
  ReviewStatus,
  ReviewUnit,
  SubmitReviewResult,
  SyncResult,
} from "./types";

export const MOCK = import.meta.env.VITE_MOCK === "1";

export { ApiError, CONFIRM_REQUIRED_PUBLIC_EDIT, errorText, isConfirmRequired } from "./errors";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      (typeof body === "object" && body && "error" in body && String((body as any).error)) ||
      (typeof body === "string" && body) ||
      `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });

const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

export const encodeKey = (key: string) => encodeURIComponent(key);

/** The server may answer with a bare array or an envelope; tolerate both. */
function unwrap<T>(value: unknown, field: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as any)[field])) {
    return (value as any)[field] as T[];
  }
  return [];
}

/* ------------------------------------------------------------------------ */
/* Wire shapes: exactly what packages/server returns. Everything below       */
/* translates these into the view model in ./types.                          */
/* ------------------------------------------------------------------------ */

interface WireProgress {
  hunks: { viewed: number; total: number };
  units: { complete: number; total: number };
  files: { viewed: number; total: number };
}

interface WireListEntry {
  key: string;
  meta: PrListEntry["meta"];
  currentRevision: number;
  summary: string;
  progress: WireProgress;
  analysisJob?: AnalysisJob | null;
}

/** core's FileRollup — an array entry keyed by `path`, not a map. */
interface WireFileRollup {
  path: string;
  hunkIds: string[];
  viewedCount: number;
  total: number;
  viewed: boolean;
  changedSinceViewed: boolean;
  syncedToGithub?: boolean;
}

interface WireState {
  pr?: unknown;
  currentRevision: number;
  revisions: { revision: number; baseOnly?: boolean }[];
  summary: string;
  units: ReviewUnit[];
  hunks: PrState["hunks"];
  files: WireFileRollup[];
  unassignedHunkIds: string[];
}

interface WireHunk extends Omit<Hunk, "lines"> {
  /** raw hunk body without the @@ header, newline-joined */
  text?: string;
}

interface WireFile {
  path: string;
  oldPath?: string;
  status: FileEntry["status"];
  binary?: boolean;
  hunks: WireHunk[];
}

interface WirePrDetail {
  state: WireState;
  /** a bare array — NOT wrapped in a `{ files }` envelope */
  files: WireFile[];
  diff: string;
  meta: PrListEntry["meta"];
  analysisJob?: AnalysisJob | null;
}

interface WireMigrationEntry {
  status: "identical" | "fuzzy" | "renamed" | "archived" | "new";
  hunkId: string;
  previousHunkId?: string;
  file: string;
  previousFile?: string;
  score?: number;
  wasViewed?: boolean;
  changedSinceViewed?: boolean;
}

interface WireMigrationReport {
  revision: number;
  previousRevision?: number;
  baseOnly: boolean;
  counts: Record<"identical" | "fuzzy" | "renamed" | "archived" | "new", number>;
  entries: WireMigrationEntry[];
}

interface WireRefresh {
  key: string;
  revision: number;
  added: boolean;
  baseOnly: boolean;
  report: WireMigrationReport | null;
  state: WireState;
}

interface WireSync {
  files:
    | { ok: true; pushed: { file: string; viewed: boolean }[]; drift: { file: string; local: boolean; remote: string }[] }
    | { ok: false; error?: string };
  comments: { ok: boolean; pushed: number; reviewUrl?: string; error?: string };
  state: WireState;
}

interface WireComment {
  id: string;
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  createdAt: string;
  status: CommentStatus;
  githubCommentId?: number;
}

interface WireReviewStatus {
  draft: {
    body: string;
    pendingReviewId?: string;
    pendingReviewDatabaseId?: number;
    lastSyncedAt?: string;
    submittedAt?: string;
    submittedEvent?: ReviewEvent;
    submittedUrl?: string;
  };
  comments: {
    counts: { draft: number; pushed: number; submitted: number };
    included: ReviewStatus["included"];
  };
  pending: { known: boolean; exists: boolean; error?: string };
  readiness: ReviewStatus["readiness"];
  lastSubmission?: ReviewStatus["lastSubmission"];
}

/* ----------------------------------------------------------- adapters --- */

function adaptHunk(h: WireHunk): Hunk {
  // core stores the body as a single newline-joined string; the renderer wants
  // one entry per line. An empty body must stay empty, not [""].
  const lines = h.text ? h.text.split("\n") : undefined;
  return { ...h, lines };
}

function adaptFile(f: WireFile): FileEntry {
  const hunks = f.hunks.map(adaptHunk);
  // core doesn't carry per-file stats; they're a cheap fold over the hunks.
  let additions = 0;
  let deletions = 0;
  for (const h of f.hunks) {
    additions += h.addedLines?.length ?? 0;
    deletions += h.removedLines?.length ?? 0;
  }
  return {
    path: f.path,
    oldPath: f.oldPath,
    status: f.status,
    binary: f.binary,
    additions,
    deletions,
    hunks,
  };
}

function adaptState(s: WireState): PrState {
  const files: Record<string, FileRollup> = {};
  for (const f of s.files ?? []) {
    files[f.path] = {
      viewed: f.viewed,
      viewedHunks: f.viewedCount,
      totalHunks: f.total,
      changedSinceViewed: f.changedSinceViewed,
      syncedToGitHub: f.syncedToGithub,
    };
  }
  return {
    revision: s.currentRevision,
    summary: s.summary,
    units: s.units ?? [],
    hunks: s.hunks ?? {},
    files,
    baseOnly: s.revisions?.find((r) => r.revision === s.currentRevision)?.baseOnly ?? false,
  };
}

function adaptDetail(raw: WirePrDetail, key: string): PrDetail {
  return {
    key,
    meta: raw.meta,
    state: adaptState(raw.state),
    files: { files: (raw.files ?? []).map(adaptFile) },
    diff: raw.diff ?? "",
    analysisJob: raw.analysisJob ?? null,
  };
}

function adaptMigrationReport(res: WireRefresh): MigrationReport {
  const report = res.report;
  if (!report) {
    return { revision: res.revision, baseOnly: res.baseOnly, noChange: !res.added };
  }
  const bucket = (status: WireMigrationEntry["status"]): MigrationReportItem[] =>
    report.entries
      .filter((e) => e.status === status)
      .map((e) => ({
        hunkId: e.hunkId,
        file: e.file,
        predecessorId: e.previousHunkId,
        note:
          e.previousFile && e.previousFile !== e.file
            ? `was ${e.previousFile}`
            : e.score !== undefined
              ? `score ${e.score.toFixed(2)}`
              : undefined,
      }));
  return {
    revision: report.revision,
    baseOnly: report.baseOnly,
    // core names the unchanged-carry bucket "identical"; the UI calls it "carried".
    counts: {
      carried: report.counts.identical,
      fuzzy: report.counts.fuzzy,
      renamed: report.counts.renamed,
      archived: report.counts.archived,
      new: report.counts.new,
    },
    carried: bucket("identical"),
    fuzzy: bucket("fuzzy"),
    renamed: bucket("renamed"),
    archived: bucket("archived"),
    new: bucket("new"),
    noChange: !res.added,
  };
}

function adaptSync(res: WireSync): SyncResult {
  const messages: string[] = [];
  if (!res.files.ok) messages.push(`files: ${res.files.error ?? "sync failed"}`);
  if (!res.comments.ok && res.comments.error) messages.push(`comments: ${res.comments.error}`);
  return {
    filesSynced: res.files.ok ? res.files.pushed.length : 0,
    commentsPosted: res.comments.pushed ?? 0,
    reviewUrl: res.comments.reviewUrl,
    drift: res.files.ok
      ? res.files.drift.map((d) => `${d.file} (local ${d.local ? "viewed" : "unviewed"}, remote ${d.remote})`)
      : [],
    message: messages.join(" · ") || undefined,
  };
}

/**
 * The server already speaks draft/pushed/submitted, so this is a pass-through
 * that only defends against an older server (or a hand-edited comments.json)
 * still sending the old binary vocabulary.
 */
const adaptComment = (c: WireComment): DraftComment => ({
  ...c,
  status: c.status === "pushed" || c.status === "submitted" ? c.status : "draft",
});

/** Flattens the server's nested review envelope into the panel's view model. */
function adaptReview(raw: WireReviewStatus): ReviewStatus {
  return {
    body: raw.draft?.body ?? "",
    counts: raw.comments?.counts ?? { draft: 0, pushed: 0, submitted: 0 },
    included: raw.comments?.included ?? [],
    pending: raw.pending ?? { known: false, exists: false },
    readiness: raw.readiness,
    lastSubmission: raw.lastSubmission,
    submittedAt: raw.draft?.submittedAt,
    submittedEvent: raw.draft?.submittedEvent,
    submittedUrl: raw.draft?.submittedUrl,
  };
}

export const api = {
  async listPrs(): Promise<PrListEntry[]> {
    if (MOCK) return mockApi.listPrs();
    const entries = unwrap<WireListEntry>(await request<unknown>("/prs"), "prs");
    return entries.map((e) => ({
      key: e.key,
      meta: e.meta,
      title: e.meta?.title,
      currentRevision: e.currentRevision,
      summary: e.summary,
      unitCount: e.progress?.units.total,
      viewedHunks: e.progress?.hunks.viewed,
      totalHunks: e.progress?.hunks.total,
      analysisJob: e.analysisJob ?? null,
    }));
  },

  async addPr(url: string): Promise<PrListEntry> {
    if (MOCK) return mockApi.addPr(url);
    const res = await post<{ key: string; created: boolean; revision: number; state: WireState }>(
      "/prs",
      { url },
    );
    const state = adaptState(res.state);
    return {
      key: res.key,
      meta: (res.state.pr ?? {}) as PrListEntry["meta"],
      currentRevision: res.revision,
      summary: state.summary,
      unitCount: state.units.length,
      totalHunks: Object.keys(state.hunks).length,
      viewedHunks: Object.values(state.hunks).filter((h) => h.viewed).length,
    };
  },

  async getPr(key: string): Promise<PrDetail> {
    if (MOCK) return mockApi.getPr(key);
    return adaptDetail(await request<WirePrDetail>(`/prs/${encodeKey(key)}`), key);
  },

  async refresh(key: string): Promise<MigrationReport> {
    if (MOCK) return mockApi.refresh(key);
    return adaptMigrationReport(await post<WireRefresh>(`/prs/${encodeKey(key)}/refresh`));
  },

  async sync(key: string): Promise<SyncResult> {
    if (MOCK) return mockApi.sync(key);
    return adaptSync(await post<WireSync>(`/prs/${encodeKey(key)}/sync`));
  },

  /**
   * Word-level diff of a changed-since-viewed hunk against its predecessor.
   * Served on demand — it is not inlined on the hunk state.
   */
  async diffOfDiffs(key: string, hunkId: string): Promise<DiffOfDiffs> {
    if (MOCK) return mockApi.diffOfDiffs(key, hunkId);
    return request<DiffOfDiffs>(
      `/prs/${encodeKey(key)}/hunks/${encodeURIComponent(hunkId)}/diff-of-diffs`,
    );
  },

  async setHunkViewed(key: string, hunkId: string, viewed: boolean): Promise<void> {
    if (MOCK) return mockApi.setHunkViewed(key, hunkId, viewed);
    await post(`/prs/${encodeKey(key)}/hunks/${encodeURIComponent(hunkId)}/viewed`, { viewed });
  },

  async setUnitViewed(key: string, unitId: string): Promise<void> {
    if (MOCK) return mockApi.setUnitViewed(key, unitId);
    await post(`/prs/${encodeKey(key)}/units/${encodeURIComponent(unitId)}/viewed`);
  },

  async patchUnit(key: string, unitId: string, patch: Partial<ReviewUnit>): Promise<void> {
    if (MOCK) return mockApi.patchUnit(key, unitId, patch);
    await post(`/prs/${encodeKey(key)}/units/${encodeURIComponent(unitId)}`, patch);
  },

  async listComments(key: string): Promise<DraftComment[]> {
    if (MOCK) return mockApi.listComments(key);
    return unwrap<WireComment>(
      await request<unknown>(`/prs/${encodeKey(key)}/comments`),
      "comments",
    ).map(adaptComment);
  },

  async addComment(
    key: string,
    input: { file: string; line: number; side: "LEFT" | "RIGHT"; body: string },
  ): Promise<DraftComment> {
    if (MOCK) return mockApi.addComment(key, input);
    const res = await post<{ comment: WireComment }>(`/prs/${encodeKey(key)}/comments`, input);
    return adaptComment(res.comment);
  },

  /**
   * `confirm` is only ever sent for an already-submitted (public) comment, and
   * only after the reader confirmed in the UI — the server rejects it otherwise
   * with `confirm_required_public_edit`.
   */
  async editComment(
    key: string,
    input: { id: string; body: string; confirm?: boolean },
  ): Promise<EditCommentResult> {
    if (MOCK) return mockApi.editComment(key, input);
    const res = await patch<{ comment: WireComment; remote: EditCommentResult["remote"] }>(
      `/prs/${encodeKey(key)}/comments/${encodeURIComponent(input.id)}`,
      { body: input.body, ...(input.confirm ? { confirm: true } : {}) },
    );
    return { comment: adaptComment(res.comment), remote: res.remote ?? null };
  },

  async deleteComment(key: string, id: string): Promise<void> {
    if (MOCK) return mockApi.deleteComment(key, id);
    await del(`/prs/${encodeKey(key)}/comments/${encodeURIComponent(id)}`);
  },

  /* ------------------------------------------------------ review lifecycle */

  async getReview(key: string): Promise<ReviewStatus> {
    if (MOCK) return mockApi.getReview(key);
    return adaptReview(await request<WireReviewStatus>(`/prs/${encodeKey(key)}/review`));
  },

  async saveReviewBody(key: string, body: string): Promise<void> {
    if (MOCK) return mockApi.saveReviewBody(key, body);
    await post(`/prs/${encodeKey(key)}/review`, { body });
  },

  /**
   * `confirm: true` is required by the server; sending it is the API-level
   * counterpart of the UI's explicit confirmation step. Never send it from a
   * code path the reader did not deliberately trigger.
   */
  async submitReview(
    key: string,
    input: { event: ReviewEvent; body?: string },
  ): Promise<SubmitReviewResult> {
    if (MOCK) return mockApi.submitReview(key, input);
    return post<SubmitReviewResult>(`/prs/${encodeKey(key)}/review/submit`, {
      ...input,
      confirm: true,
    });
  },

  async discardPendingReview(key: string): Promise<DiscardPendingResult> {
    if (MOCK) return mockApi.discardPendingReview(key);
    return del<DiscardPendingResult>(`/prs/${encodeKey(key)}/review/pending`);
  },

  /* -------------------------------------------------------- analysis jobs */

  async getAnalysisJob(key: string): Promise<AnalysisJob | null> {
    if (MOCK) return mockApi.getAnalysisJob(key);
    const res = await request<{ job: AnalysisJob | null }>(`/prs/${encodeKey(key)}/analysis-job`);
    return res.job ?? null;
  },

  /** 409 when one is already queued or running — the caller surfaces that as-is. */
  async startAnalysis(key: string): Promise<AnalysisJob> {
    if (MOCK) return mockApi.startAnalysis(key);
    const res = await post<{ job: AnalysisJob }>(`/prs/${encodeKey(key)}/analyze`);
    return res.job;
  },

  async cancelAnalysis(key: string): Promise<AnalysisJob> {
    if (MOCK) return mockApi.cancelAnalysis(key);
    const res = await del<{ job: AnalysisJob }>(`/prs/${encodeKey(key)}/analyze`);
    return res.job;
  },

  /**
   * Subscribe to job transitions for one PR. Returns the unsubscribe function.
   * Reconnection is the browser's job for EventSource; the mock re-emits from
   * its own in-memory job runner.
   */
  subscribeAnalysis(key: string, onJob: (job: AnalysisJob) => void): () => void {
    if (MOCK) return mockApi.subscribeAnalysis(key, onJob);
    if (typeof EventSource === "undefined") return () => {};
    const source = new EventSource(`/api/prs/${encodeKey(key)}/events`);
    const handler = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as { job?: AnalysisJob } | AnalysisJob;
        const job = (parsed as { job?: AnalysisJob }).job ?? (parsed as AnalysisJob);
        if (job && typeof job.status === "string") onJob(job);
      } catch {
        /* a malformed frame is not worth breaking the subscription over */
      }
    };
    source.addEventListener("analysis-job", handler as EventListener);
    return () => {
      source.removeEventListener("analysis-job", handler as EventListener);
      source.close();
    };
  },

  /* ------------------------------------------------------------------ chat */

  async setRepoPath(key: string, path: string): Promise<RepoPathResult> {
    if (MOCK) return mockApi.setRepoPath(key, path);
    return post<RepoPathResult>(`/prs/${encodeKey(key)}/repo-path`, { path });
  },

  async getChat(key: string): Promise<ChatState> {
    if (MOCK) return mockApi.getChat(key);
    const res = await request<Partial<ChatState>>(`/prs/${encodeKey(key)}/chat`);
    return {
      messages: res.messages ?? [],
      sessionId: res.sessionId ?? null,
      busy: Boolean(res.busy),
    };
  },

  async clearChat(key: string): Promise<void> {
    if (MOCK) return mockApi.clearChat(key);
    await del(`/prs/${encodeKey(key)}/chat`);
  },

  /**
   * Send a message and consume the reply stream.
   *
   * This cannot use EventSource (it is a POST with a body), so the response is
   * read as a byte stream and decoded by the parser in lib/sse.ts. Both the
   * real server and the mock hand back a ReadableStream of the same wire text,
   * so exactly one decoding path is exercised in either mode.
   */
  async streamChat(
    key: string,
    input: { text: string; refs?: ChatRef[] },
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = MOCK
      ? mockApi.streamChat(key, input, signal)
      : await (async () => {
          const res = await fetch(`/api/prs/${encodeKey(key)}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify(input),
            signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new ApiError(text || `${res.status} ${res.statusText}`, res.status, text);
          }
          if (!res.body) throw new ApiError("The chat response carried no body", 500, null);
          return res.body;
        })();

    for await (const frame of readSseStream(body, signal)) {
      const event = decodeChatFrame(frame.event, frame.data);
      if (event) onEvent(event);
    }
  },
};

/** Map one SSE frame onto the chat event union; unknown frames are ignored. */
export function decodeChatFrame(event: string, data: string): ChatStreamEvent | null {
  const payload = frameJson<Record<string, unknown>>({ event, data });
  switch (event) {
    case "delta": {
      const text = typeof payload?.text === "string" ? payload.text : null;
      return text === null ? null : { type: "delta", text };
    }
    case "tool": {
      const name = typeof payload?.name === "string" ? payload.name : null;
      if (!name) return null;
      return {
        type: "tool",
        name,
        detail: typeof payload?.detail === "string" ? payload.detail : undefined,
      };
    }
    case "done": {
      const message = payload?.message as ChatMessage | undefined;
      if (!message || typeof message.text !== "string") return null;
      return { type: "done", message: { ...message, role: message.role ?? "assistant" } };
    }
    case "error":
      return {
        type: "error",
        error: typeof payload?.error === "string" ? payload.error : "The chat stream failed",
      };
    default:
      return null;
  }
}
