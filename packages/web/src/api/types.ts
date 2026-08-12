/**
 * The view model packages/web renders.
 *
 * Deliberately NOT imported from @reviewer/core: the web app talks to the
 * server over REST only and must stay compilable on its own. The server's
 * actual wire shapes live in `client.ts`, which adapts them into the types
 * below — this file is the UI's contract, `client.ts` owns the translation.
 */

export type Kind =
  | "core-logic"
  | "connective-tissue"
  | "wiring"
  | "ripple"
  | "tests"
  | "docs";

export type Attention = "must-read" | "skim" | "skip";

export type RiskFlag =
  | "auth"
  | "migration"
  | "concurrency"
  | "money"
  | "external-call"
  | "security";

export const KINDS: Kind[] = [
  "core-logic",
  "connective-tissue",
  "wiring",
  "ripple",
  "tests",
  "docs",
];

export const ATTENTIONS: Attention[] = ["must-read", "skim", "skip"];

/** A hunk as listed in revisions/<n>/files.json. */
export interface Hunk {
  id: string;
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  /**
   * Raw patch body for the hunk (the lines after the @@ header, each still
   * carrying its leading ' ', '+' or '-'). Derived by `client.ts` from the
   * `text` field core writes into files.json; only absent for hunks that
   * predate that field, in which case we recover it from the raw diff text.
   */
  lines?: string[];
  /** Content lines only, as core computed hunk identity from. */
  addedLines?: string[];
  removedLines?: string[];
}

export interface FileEntry {
  path: string;
  oldPath?: string;
  status?: "added" | "modified" | "removed" | "renamed";
  additions?: number;
  deletions?: number;
  binary?: boolean;
  hunks: Hunk[];
}

export interface FilesJson {
  files: FileEntry[];
}

export interface ReviewUnit {
  id: string;
  title: string;
  summary: string;
  kind: Kind;
  attention: Attention;
  attentionWhy: string;
  riskFlags: RiskFlag[];
  hunkIds: string[];
  order: number;
}

/**
 * Word-level diff-of-diffs, as computed by core and served by
 * `GET /api/prs/:key/hunks/:id/diff-of-diffs`. It is line-oriented: each line
 * is unchanged/added/removed, or `modified` with a word-level breakdown.
 */
export interface WordPart {
  value: string;
  type: "same" | "added" | "removed";
}

export interface DiffOfDiffsLine {
  type: "unchanged" | "added" | "removed" | "modified";
  oldLine?: string;
  newLine?: string;
  /** word-level breakdown, only for `modified` lines */
  parts?: WordPart[];
}

export interface DiffOfDiffs {
  lines: DiffOfDiffsLine[];
  changed: boolean;
}

export interface HunkState {
  viewed: boolean;
  viewedAtRevision?: number;
  changedSinceViewed: boolean;
  predecessorId?: string;
  migration?: "identical" | "fuzzy" | "renamed" | "new";
}

export interface FileRollup {
  viewed: boolean;
  viewedHunks: number;
  totalHunks: number;
  changedSinceViewed?: boolean;
  syncedToGitHub?: boolean;
}

export interface PrMeta {
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
  author?: string;
  createdAt?: string;
}

export interface PrState {
  revision: number;
  summary?: string;
  units: ReviewUnit[];
  hunks: Record<string, HunkState>;
  files?: Record<string, FileRollup>;
  baseOnly?: boolean;
}

/* --------------------------------------------------------- analysis jobs */

/**
 * The lifecycle of the server-side automatic analysis of one revision.
 * `queued`/`running` are live states; the other three are terminal.
 */
export type AnalysisJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** GET /api/prs/:key/analysis-job → `{ job }` (null when none was ever run). */
export interface AnalysisJob {
  revision: number;
  status: AnalysisJobStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** free-form one-liner the runner reports while working */
  progress?: string;
}

export const isJobLive = (job?: AnalysisJob | null): boolean =>
  job?.status === "queued" || job?.status === "running";

/** GET /api/prs — flattened by `client.ts` from the server's progress envelope. */
export interface PrListEntry {
  key: string;
  meta: PrMeta;
  title?: string;
  currentRevision?: number;
  summary?: string;
  unitCount?: number;
  viewedHunks?: number;
  totalHunks?: number;
  analysisJob?: AnalysisJob | null;
}

/** GET /api/prs/:key */
export interface PrDetail {
  key: string;
  meta: PrMeta;
  state: PrState;
  files: FilesJson;
  diff: string;
  analysisJob?: AnalysisJob | null;
}

export interface MigrationReportItem {
  hunkId: string;
  file?: string;
  predecessorId?: string;
  note?: string;
}

/**
 * POST /api/prs/:key/refresh.
 * Core reports one flat `entries` array tagged with a status (and calls
 * carried-over-unchanged hunks `identical`); `client.ts` buckets it into the
 * per-status lists this panel renders.
 */
export interface MigrationReport {
  revision?: number;
  baseOnly?: boolean;
  counts?: {
    carried?: number;
    fuzzy?: number;
    renamed?: number;
    archived?: number;
    new?: number;
  };
  carried?: MigrationReportItem[];
  fuzzy?: MigrationReportItem[];
  renamed?: MigrationReportItem[];
  archived?: MigrationReportItem[];
  new?: MigrationReportItem[];
  /** true when refresh found no new revision (head/base/mergeBase unchanged) */
  noChange?: boolean;
}

/**
 * Three states, mirroring the server:
 *   draft     — local only.
 *   pushed    — in your PENDING review on GitHub; private, still revocable.
 *   submitted — went out with a submitted review; public.
 */
export type CommentStatus = "draft" | "pushed" | "submitted";

export interface DraftComment {
  id: string;
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  createdAt?: string;
  status?: CommentStatus;
  /** set once the comment exists on GitHub; needed to mirror an edit remotely */
  githubCommentId?: number;
}

/**
 * PATCH /api/prs/:key/comments/:id
 *
 * `remote` is null for a purely local (draft) edit. For a pushed/submitted
 * comment it reports whether GitHub was updated too — `ok: false` means the
 * local edit is saved but GitHub still shows the old text.
 */
export interface EditCommentResult {
  comment: DraftComment;
  remote: { ok: true } | { ok: false; reason: string } | null;
}

export interface SyncResult {
  filesSynced?: number;
  commentsPosted?: number;
  reviewUrl?: string;
  drift?: string[];
  message?: string;
}

/* ------------------------------------------------------- review lifecycle */

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReadinessSummary {
  hunks: { viewed: number; total: number };
  units: { complete: number; total: number };
  mustRead: { complete: number; total: number; unviewed: number };
  changedSinceViewed: number;
  ready: boolean;
}

export interface ReviewSubmission {
  event: ReviewEvent;
  url?: string;
  commentCount: number;
  ts: string;
  revision: number;
}

/** GET /api/prs/:key/review */
export interface ReviewStatus {
  body: string;
  counts: { draft: number; pushed: number; submitted: number };
  /** everything a submit would carry, in file order */
  included: {
    id: string;
    file: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
    status: CommentStatus;
  }[];
  pending: {
    /** false when we could not reach GitHub — status is then unknown, not "none" */
    known: boolean;
    exists: boolean;
    error?: string;
  };
  readiness: ReadinessSummary;
  lastSubmission?: ReviewSubmission;
  submittedAt?: string;
  submittedEvent?: ReviewEvent;
  submittedUrl?: string;
}

export interface SubmitReviewResult {
  event: ReviewEvent;
  url?: string;
  commentCount: number;
}

export interface DiscardPendingResult {
  discarded: boolean;
  resetToDraft: number;
}

/* ------------------------------------------------------------------- chat */

/**
 * A pointer to something in the review the reader is asking about. The server
 * resolves it into whatever context Claude needs (the unit's hunks, the file's
 * diff, the quoted lines…), so the UI only ever carries the pointer.
 */
export type ChatRefKind = "unit" | "hunk" | "file" | "line-range" | "comment";

export interface ChatRef {
  kind: ChatRefKind;
  /** unit id, hunk id or comment id, depending on `kind` */
  id?: string;
  path?: string;
  /** 1-based, inclusive, for line-range refs (and the anchor line of a comment) */
  start?: number;
  end?: number;
  /** which side of the diff the line numbers belong to */
  side?: "old" | "new";
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  ts: string;
  refs?: ChatRef[];
}

/** GET /api/prs/:key/chat */
export interface ChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  busy: boolean;
}

/** POST /api/prs/:key/chat, decoded from the SSE frames. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: string };

/** POST /api/prs/:key/repo-path */
export interface RepoPathResult {
  ok: boolean;
  warning?: string;
}
