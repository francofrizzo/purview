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

export type FindingSeverity = "warning" | "note";

/**
 * A claim the analysis verified in the local checkout: `warning` = something
 * is likely wrong, `note` = a verified-OK answer to a question the reviewer
 * would otherwise have had to chase. `evidence` is the location(s) read.
 * Purely an annotation — nothing in the app acts on it.
 */
export interface Finding {
  severity: FindingSeverity;
  text: string;
  evidence: string;
}

export interface ReviewUnit {
  generated?: boolean;
  id: string;
  title: string;
  summary: string;
  kind: Kind;
  attention: Attention;
  attentionWhy: string;
  riskFlags: RiskFlag[];
  hunkIds: string[];
  order: number;
  /** absent on units that verified nothing, and on any state predating findings */
  findings?: Finding[];
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
  autoViewed?: boolean;
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
  authorAvatarUrl?: string;
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

/** GitHub's own lifecycle state for the PR. */
export type PrGithubState = "open" | "draft" | "merged" | "closed";

/** GitHub's aggregated review decision; null when GitHub reports none. */
export type ReviewDecision = "approved" | "changes_requested" | "review_required";

/**
 * GET /api/prs/:key/staleness — has the PR moved on GitHub since we last
 * fetched it? `error` is set when the `gh` call failed; the server still
 * answers 200 with `stale: false`, so a failing check is simply silent.
 */
export type StalenessReason = "new-commits" | "base-moved" | "state-changed";

export interface Staleness {
  stale: boolean;
  reasons: StalenessReason[];
  upstreamHeadSha: string | null;
  localHeadSha: string | null;
  upstreamState: PrGithubState | null;
  localState: PrGithubState | null;
  checkedAt: string;
  error?: string;
}

/**
 * `GET /api/prs`'s per-PR effort badge: "fast" for a PR that's mostly skim,
 * "heavy" for one with a large or risky must-read surface, `null` for
 * everything in between (deliberately most PRs). Absent/undefined only on a
 * server too old to send it; `null` means the server computed it and there's
 * nothing to badge (including "not analyzed yet").
 */
export type EffortBadge = "fast" | "heavy" | null;

export interface ReviewEffort {
  mustReadLines: number;
  /** kind-discounted lines — what the badge is derived from */
  weightedMustReadLines: number;
  mustReadUnits: number;
  riskCount: number;
  badge: EffortBadge;
}

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
  effort?: ReviewEffort | null;
  /** GitHub lifecycle state, as of the last fetch. */
  state: PrGithubState;
  reviewDecision: ReviewDecision | null;
  /** ISO timestamp of when this PR was added locally. */
  addedAt: string;
  /** Local-only: hides the PR behind the repo group's archived disclosure. */
  archived: boolean;
}

/* --------------------------------------------------------- repos & config */

/** One repo's most recent review-watch poll, from `GET /api/repos`. */
export interface RepoWatchStatus {
  checkedAt: string;
  imported: number;
  error?: string;
}

/** GET /api/repos → `{ repos }`. */
export interface RepoSummary {
  host: string;
  owner: string;
  repo: string;
  prCount: number;
  archivedCount: number;
  hasLocalConfig: boolean;
  hasCommittedConfig: boolean;
  /** the local checkout the server resolved for this repo, if any */
  repoPath: string | null;
  /** whether this machine polls the repo for review requests (see repo settings) */
  watchReviews: boolean;
  /** this repo's most recent poll, or null if the watcher has not reached it yet */
  watch: RepoWatchStatus | null;
}

/**
 * GET/PUT /api/repos/:rkey/config.
 *
 * `local` is what this machine stores; `committed` mirrors the target repo's
 * `.purview/` folder and is read-only here (the team maintains it via git);
 * `effective` is the server's own layering of the two plus the built-in
 * defaults, so the UI never has to recompute precedence.
 */
export interface RepoConfig {
  local: {
    /** null means "inherit the global default" */
    autoAnalyze: boolean | null;
    repoPath: string | null;
    analysisModel: ClaudeModel | null;
    chatModel: ClaudeModel | null;
    /** null = inherit; "none" is a real pinned value (omit `--effort`) */
    analysisEffort: AnalysisEffort | null;
    /**
     * Poll GitHub for review requests every few minutes and import them. Not
     * layered like the other fields (it is a machine behavior, not team
     * policy) — `null`/`false` are both "off"; there is no "inherit".
     */
    watchReviews: boolean | null;
    rubric: string;
    chatInstructions: string;
  };
  committed: {
    present: boolean;
    config: Record<string, unknown> | null;
    rubric: string | null;
    chat: string | null;
  };
  effective: {
    autoAnalyze: boolean;
    repoPath: string | null;
    analysisModel: ClaudeModel;
    chatModel: ClaudeModel;
    analysisEffort: AnalysisEffort;
  };
  /** which layer each effective value came from */
  sources?: {
    autoAnalyze: ConfigSource;
    repoPath: ConfigSource;
    analysisModel: ConfigSource;
    chatModel: ConfigSource;
    analysisEffort: ConfigSource;
  };
}

export interface RepoConfigPatch {
  autoAnalyze?: boolean | null;
  repoPath?: string | null;
  analysisModel?: ClaudeModel | null;
  chatModel?: ClaudeModel | null;
  analysisEffort?: AnalysisEffort | null;
  watchReviews?: boolean | null;
  rubric?: string;
  chatInstructions?: string;
}

/** URL scheme "open in editor" links use; not layered, see server's config.ts. */
export type Editor = "zed" | "vscode";

export const EDITORS: Editor[] = ["zed", "vscode"];

/** GET/PUT /api/config — the machine-wide layer. */
export interface GlobalConfig {
  /** null = inherit, which at this layer means `defaults` */
  analysisModel: ClaudeModel | null;
  chatModel: ClaudeModel | null;
  analysisEffort: AnalysisEffort | null;
  editor: Editor;
  defaults: { analysisModel: ClaudeModel; chatModel: ClaudeModel; analysisEffort: AnalysisEffort };
}

export interface GlobalConfigPatch {
  analysisModel?: ClaudeModel | null;
  chatModel?: ClaudeModel | null;
  analysisEffort?: AnalysisEffort | null;
  editor?: Editor;
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

/**
 * What a comment is attached to. `"line"` is the historical shape (and the
 * default when the server omits the field); `"file"` comments hang off the
 * whole file and carry no line or side at all.
 */
export type CommentSubject = "line" | "file";

export interface DraftComment {
  id: string;
  file: string;
  /** null for file-level comments */
  line: number | null;
  /** null for file-level comments */
  side: "LEFT" | "RIGHT" | null;
  body: string;
  createdAt?: string;
  status?: CommentStatus;
  /** absent on older servers — treat as "line" */
  subjectType?: CommentSubject;
  /** set once the comment exists on GitHub; needed to mirror an edit remotely */
  githubCommentId?: number;
}

/** The one predicate the whole UI branches on. Tolerant of older payloads. */
export function isFileComment(c: {
  subjectType?: CommentSubject;
  line?: number | null;
}): boolean {
  return c.subjectType === "file" || c.line === null || c.line === undefined;
}

/**
 * POST /api/prs/:key/comments — one shape for both kinds, so callers can pass
 * a target around without branching until the wire.
 */
export type AddCommentInput =
  | { subjectType?: "line"; file: string; line: number; side: "LEFT" | "RIGHT"; body: string }
  | { subjectType: "file"; file: string; body: string };

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

/**
 * POST /api/prs/:key/comments/:id/reanchor — a one-shot, non-applying
 * proposal for where a draft comment that fell outside the current diff
 * should move to. `ok: false` means the run itself failed (no `claude` CLI,
 * a timeout, an unparseable response); `applicable: false` means the run
 * succeeded but concluded there's nowhere safe to move the comment to.
 */
export interface ReanchorProposal {
  applicable: boolean;
  file?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  reason: string;
}

export type ReanchorResult = { ok: true; proposal: ReanchorProposal } | { ok: false; reason: string };

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
    line: number | null;
    side: "LEFT" | "RIGHT" | null;
    body: string;
    status: CommentStatus;
    subjectType?: CommentSubject;
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

/**
 * The Claude model a run uses, named by the CLI's own aliases. Full model ids
 * are deliberately not offered: they change with every release.
 */
export type ClaudeModel = "sonnet" | "opus" | "haiku";

export const CLAUDE_MODELS: ClaudeModel[] = ["sonnet", "opus", "haiku"];

/**
 * Reasoning effort for an analysis run. `"none"` is not a level — it is a
 * real, pinnable value (distinct from `null`/"inherit" in the fields below)
 * that means "omit `--effort` entirely," for a `claude` CLI too old to know
 * the flag.
 */
export type AnalysisEffort = "low" | "medium" | "high" | "none";

export const ANALYSIS_EFFORTS: AnalysisEffort[] = ["low", "medium", "high", "none"];

/** Which configuration layer an effective value came from. */
export type ConfigSource = "pr" | "repo" | "committed" | "global" | "default";

/** GET /api/prs/:key/chat */
export interface ChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  busy: boolean;
  /** what the next message will be sent with */
  model: ClaudeModel;
  /** the repo/global default, i.e. what "inherit" resolves to */
  configuredModel: ClaudeModel;
  configuredModelSource: ConfigSource;
  /** non-null only when this conversation pins a model of its own */
  sessionModel: ClaudeModel | null;
}

/** POST /api/prs/:key/chat/model */
export interface ChatModelResult {
  model: ClaudeModel;
  configuredModel: ClaudeModel;
  configuredModelSource: ConfigSource;
  sessionModel: ClaudeModel | null;
  /** true only if the switch had to abandon the transcript */
  restartedSession: boolean;
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

/* ------------------------------------------------- Purview-to-Purview share */

/**
 * The report `POST /api/prs/:key/analysis/import` answers with. Hunk ids are
 * content-derived, so importing re-anchors the export's units onto the
 * importer's own current revision by id intersection: `hunksUnassigned`
 * counts hunks of the current revision the export didn't cover,
 * `unitsDropped` counts units whose every hunk id fell out of the current
 * revision.
 */
export interface AnalysisImportReport {
  unitsImported: number;
  unitsDropped: number;
  hunksMatched: number;
  hunksUnassigned: number;
  /** false when the importer's revision differs from the exporter's */
  sameRevision: boolean;
}

/** POST /api/repos/:rkey/import-reviews */
export interface ImportReviewsResult {
  imported: string[];
  alreadyTracked: string[];
  failed: { key: string; error: string }[];
  days: number;
  /**
   * Which of `imported`'s PRs got a shared analysis imported off the PR's own
   * conversation tab instead of a fresh (paid) Claude run — additive, so an
   * older server (or a test fixture predating this) simply never populates it.
   */
  sharedImports?: { key: string; author?: string; postedAt: string }[];
}

/* --------------------------------------------- PR-comment analysis sharing */

/** POST /api/prs/:key/analysis/share-to-pr */
/** Rides on POST /api/prs when adding imported a shared analysis for free. */
export interface SharedAnalysisNote {
  author?: string;
  postedAt: string;
}

export interface ShareAnalysisResult {
  commentUrl: string;
  /** true when an existing marked comment was updated rather than a new one posted */
  updated: boolean;
}

/** POST /api/prs/:key/analysis/import-from-pr */
export interface ImportFromPrResult {
  report: AnalysisImportReport;
  author?: string;
  postedAt: string;
  commentUrl: string;
}

/**
 * GET /api/prs/:key/analysis/shared — a cheap, read-only probe: is there a
 * shared analysis comment on this PR, and does it match the revision the
 * reader is currently looking at? Never throws server-side (a `gh` failure
 * degrades to `{ found: false, error }`), same idiom as `Staleness`. Called
 * on demand only — never polled.
 */
export interface SharedAnalysisProbe {
  found: boolean;
  author?: string;
  postedAt?: string;
  headSha?: string;
  sameCommit?: boolean;
  error?: string;
}

/* ------------------------------------------------------- go to definition */

/**
 * GET /api/prs/:key/definition?symbol=<name> — cmd+click "go to definition"
 * in the diff viewer. `engine` says which tier answered: `ctags` when
 * universal-ctags is on the server's PATH, `grep` for the heuristic fallback
 * (see packages/server/src/definitions.ts) — the web shows a quiet hint when
 * it's the fallback.
 */
export interface DefinitionSnippet {
  /** 1-based */
  startLine: number;
  lines: string[];
}

export interface DefinitionCandidate {
  /** repo-relative */
  path: string;
  absPath: string;
  /** 1-based */
  line: number;
  kind?: string;
  signature?: string;
  snippet: DefinitionSnippet;
}

export type DefinitionResult =
  | { checkout: false; reason: string }
  | { checkout: true; engine: "ctags" | "grep"; candidates: DefinitionCandidate[] };
