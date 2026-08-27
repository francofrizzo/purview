import { z } from "zod";

/* ---------------------------------------------------------------- taxonomy */

export const KindSchema = z.enum([
  "core-logic",
  "connective-tissue",
  "wiring",
  "ripple",
  "tests",
  "docs",
]);
export type Kind = z.infer<typeof KindSchema>;

export const AttentionSchema = z.enum(["must-read", "skim", "skip"]);
export type Attention = z.infer<typeof AttentionSchema>;

export const RiskFlagSchema = z.enum([
  "auth",
  "migration",
  "concurrency",
  "money",
  "external-call",
  "security",
]);
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

/* ------------------------------------------------------------------- hunks */

/**
 * A parsed hunk. The SPEC's `Hunk` fields are all present; `addedLines`,
 * `removedLines` and `text` are additive and are what hunk identity,
 * fuzzy migration and diff-of-diffs are computed from.
 */
export const HunkSchema = z.object({
  id: z.string(),
  file: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  header: z.string(),
  addedLines: z.array(z.string()),
  removedLines: z.array(z.string()),
  /** Raw hunk body (without the @@ header), as served by GitHub. */
  text: z.string(),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const FileStatusSchema = z.enum([
  "added",
  "modified",
  "removed",
  "renamed",
]);
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const FileDiffSchema = z.object({
  /** Normalized path: new path, or old path when the file was deleted. */
  path: z.string(),
  oldPath: z.string().optional(),
  status: FileStatusSchema,
  binary: z.boolean().default(false),
  oldMode: z.string().optional(),
  newMode: z.string().optional(),
  similarity: z.number().optional(),
  hunks: z.array(HunkSchema),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

/** revisions/<n>/files.json */
export const FilesJsonSchema = z.object({
  revision: z.number().int(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  mergeBase: z.string().optional(),
  files: z.array(FileDiffSchema),
});
export type FilesJson = z.infer<typeof FilesJsonSchema>;

/* ------------------------------------------------------------------- units */

/**
 * A verified observation the analysis made while reading the local checkout.
 *
 * Findings exist to answer the questions a `must-read` rationale raises, so
 * the human does not have to chase them by hand: "do all callers handle the
 * new error path?", "is the old code path still referenced anywhere?". They
 * are *not* review comments — nothing is posted anywhere from them, they never
 * block or approve, and they are only ever produced when a local checkout was
 * available to check the claim in.
 *
 *  - `warning` — something is likely wrong (a caller mishandles a new error
 *    path, a missed update, a real mismatch between the diff and its context).
 *  - `note` — a verified-OK answer to a question the reviewer would otherwise
 *    have had to chase ("all 3 callers map both paths to 403").
 *
 * `evidence` is required and non-empty on purpose: an unsourced finding is
 * indistinguishable from speculation, and speculation is what the discipline
 * in RUBRIC.md exists to keep out.
 */
export const FindingSeveritySchema = z.enum(["warning", "note"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingSchema = z.object({
  severity: FindingSeveritySchema,
  text: z.string().min(1).max(300),
  /** concrete location(s) checked, e.g. `internal/api/handler.go:88, internal/vep/client.go:41` */
  evidence: z.string().min(1).max(200),
});
export type Finding = z.infer<typeof FindingSchema>;

/** At most this many findings ride on one unit; beyond it, keep the material ones. */
export const MAX_UNIT_FINDINGS = 5;

export const ReviewUnitSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  kind: KindSchema,
  attention: AttentionSchema,
  attentionWhy: z.string(),
  riskFlags: z.array(RiskFlagSchema).default([]),
  hunkIds: z.array(z.string()).default([]),
  order: z.number().int(),
  /**
   * Optional, and stays optional: every event and state file written before
   * findings existed parses unchanged, and a unit with nothing verified says
   * so by having no `findings` key rather than an empty array.
   */
  findings: z.array(FindingSchema).max(MAX_UNIT_FINDINGS).optional(),
});
export type ReviewUnit = z.infer<typeof ReviewUnitSchema>;

export const ReviewUnitPatchSchema = ReviewUnitSchema.partial();
export type ReviewUnitPatch = z.infer<typeof ReviewUnitPatchSchema>;

/** Payload accepted by `reviewer-state set-analysis --file <json>`. */
export const AnalysisSchema = z.object({
  summary: z.string(),
  units: z.array(ReviewUnitSchema),
  /** hunk ids deliberately left out of every unit */
  unassigned: z.array(z.string()).default([]),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const MigrationKindSchema = z.enum([
  "identical",
  "fuzzy",
  "renamed",
  "new",
]);
export type MigrationKind = z.infer<typeof MigrationKindSchema>;

export const HunkStateSchema = z.object({
  viewed: z.boolean().default(false),
  viewedAtRevision: z.number().int().optional(),
  changedSinceViewed: z.boolean().default(false),
  predecessorId: z.string().optional(),
  migration: MigrationKindSchema.optional(),
  /** set for hunks first seen in a baseOnly revision */
  defaultAttention: AttentionSchema.optional(),
  defaultAttentionWhy: z.string().optional(),
});
export type HunkState = z.infer<typeof HunkStateSchema>;

/* ---------------------------------------------------------------- metadata */

/** open / draft / merged / closed — what the UI shows as the PR's status. */
export const PrStateSchema = z.enum(["open", "draft", "merged", "closed"]);
export type PrState = z.infer<typeof PrStateSchema>;

export const ReviewDecisionSchema = z.enum([
  "approved",
  "changes_requested",
  "review_required",
]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const MetaSchema = z.object({
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().optional(),
  createdAt: z.string(),
  /**
   * The PR's head branch name, refreshed from GitHub on every refresh. Used to
   * pick the right git worktree out of a multi-worktree checkout; optional
   * because state written before this existed simply doesn't have it.
   */
  headRef: z.string().optional(),
  /**
   * Absolute path to a local checkout of the PR's repo, when the reader has
   * pointed us at one. Optional and purely additive: everything works without
   * it, but Claude runs get the repo as an extra readable root so they can
   * read code the diff only shows in fragments.
   */
  repoPath: z.string().optional(),
  /**
   * GitHub PR state, collapsed from `state` + `merged` + `draft` into the four
   * values the UI shows. Captured on init and on every refresh; absent on
   * state written before it existed.
   */
  prState: PrStateSchema.optional(),
  /**
   * GitHub's aggregate review decision. Only GraphQL exposes it (the REST
   * pull payload has no such field), so it is fetched with one extra cheap
   * query and is `null` whenever GitHub has no decision — or whenever that
   * query failed, which must never break a refresh.
   */
  reviewDecision: ReviewDecisionSchema.nullable().optional(),
  /**
   * Archived PRs stay fully readable; they are only kept out of the way (and
   * out of the automatic analysis triggers, which cost money).
   */
  archived: z.boolean().default(false),
});
export type Meta = z.infer<typeof MetaSchema>;

/* ------------------------------------------------------- repo-level config */

/**
 * Which Claude model a run uses. Only the CLI's own aliases are accepted: they
 * are stable across model releases, whereas a pinned `claude-sonnet-5` id rots.
 * `--model` is always passed, so a run never silently inherits whatever the
 * user's `claude` CLI happens to default to (which may be an expensive model).
 */
export const ClaudeModelSchema = z.enum(["sonnet", "opus", "haiku"]);
export type ClaudeModel = z.infer<typeof ClaudeModelSchema>;

export const CLAUDE_MODELS = ClaudeModelSchema.options;

/**
 * `~/.purview/<host>/<owner>/<repo>/repo.json` — settings that apply to every
 * PR of one repository.
 *
 * `null` means "inherit" and is not the same as `false`: it is what lets a
 * repo sit between the committed team config and the global config without
 * pinning a value. Every field is nullable-with-a-null-default, so an empty
 * `{}` is a complete, valid, fully-inheriting config.
 */
export const RepoConfigSchema = z.object({
  autoAnalyze: z.boolean().nullable().default(null),
  repoPath: z.string().nullable().default(null),
  analysisModel: ClaudeModelSchema.nullable().default(null),
  chatModel: ClaudeModelSchema.nullable().default(null),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const EMPTY_REPO_CONFIG: RepoConfig = RepoConfigSchema.parse({});

/**
 * `.purview/config.json` committed in the *target* repo: the team's shared
 * defaults. Unknown keys are ignored (zod strips them), so a newer team config
 * never breaks an older client.
 */
export const TeamConfigSchema = z.object({
  autoAnalyze: z.boolean().optional(),
  analysisModel: ClaudeModelSchema.optional(),
  chatModel: ClaudeModelSchema.optional(),
});
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

/**
 * `revisions/<n>/team-config.json` — the committed config as read for one
 * revision, so the network round-trip happens once per revision rather than
 * once per prompt. `ref` is the head sha it was read at; a mismatch (or an
 * explicit refresh) invalidates it.
 */
export const TeamConfigCacheSchema = z.object({
  ref: z.string().default(""),
  fetchedAt: z.string(),
  source: z.enum(["checkout", "github", "none"]).default("none"),
  present: z.boolean().default(false),
  config: TeamConfigSchema.nullable().default(null),
  rubric: z.string().nullable().default(null),
  // Added after the initial cache shape shipped; a cache file written before
  // this field existed simply has no chat instructions on record, which the
  // default here reads as identical to "the committed repo has none" — a
  // re-read on the next revision fills it in, no migration needed.
  chatInstructions: z.string().nullable().default(null),
});
export type TeamConfigCache = z.infer<typeof TeamConfigCacheSchema>;

/* -------------------------------------------------------- analysis jobs */

export const AnalysisJobStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type AnalysisJobStatus = z.infer<typeof AnalysisJobStatusSchema>;

/**
 * One Claude analysis run for a (PR, revision), persisted as
 * `analysis-job.json` in the PR's state dir so its status survives a server
 * restart (a "running" record with no process behind it is reconciled to
 * "failed" on startup).
 */
export const AnalysisJobSchema = z.object({
  revision: z.number().int(),
  status: AnalysisJobStatusSchema,
  queuedAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  progress: z.string().optional(),
});
export type AnalysisJob = z.infer<typeof AnalysisJobSchema>;

/* --------------------------------------------------------------- migration */

export const MigrationEntrySchema = z.object({
  status: z.enum(["identical", "fuzzy", "renamed", "archived", "new"]),
  hunkId: z.string(),
  previousHunkId: z.string().optional(),
  file: z.string(),
  previousFile: z.string().optional(),
  score: z.number().optional(),
  wasViewed: z.boolean().optional(),
  changedSinceViewed: z.boolean().optional(),
});
export type MigrationEntry = z.infer<typeof MigrationEntrySchema>;

export const MigrationReportSchema = z.object({
  revision: z.number().int(),
  previousRevision: z.number().int().optional(),
  baseOnly: z.boolean().default(false),
  counts: z.object({
    identical: z.number().int(),
    fuzzy: z.number().int(),
    renamed: z.number().int(),
    archived: z.number().int(),
    new: z.number().int(),
  }),
  entries: z.array(MigrationEntrySchema),
});
export type MigrationReport = z.infer<typeof MigrationReportSchema>;

/* ------------------------------------------------------------------ events */

const base = { ts: z.string() };

export const RevisionFilesSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  hunkIds: z.array(z.string()),
});
export type RevisionFiles = z.infer<typeof RevisionFilesSchema>;

export const PrInitializedEventSchema = z.object({
  ...base,
  type: z.literal("pr-initialized"),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().optional(),
});

export const RevisionAddedEventSchema = z.object({
  ...base,
  type: z.literal("revision-added"),
  revision: z.number().int(),
  baseSha: z.string(),
  headSha: z.string(),
  mergeBase: z.string(),
  baseOnly: z.boolean().default(false),
  /** file -> hunk ids of this revision; makes state.json foldable from events alone */
  files: z.array(RevisionFilesSchema).default([]),
  /** how the previous revision's hunks map onto this one */
  migration: MigrationReportSchema.optional(),
});

export const AnalysisSetEventSchema = z.object({
  ...base,
  type: z.literal("analysis-set"),
  revision: z.number().int(),
  summary: z.string(),
  units: z.array(ReviewUnitSchema),
  unassigned: z.array(z.string()).default([]),
});

export const UnitUpdatedEventSchema = z.object({
  ...base,
  type: z.literal("unit-updated"),
  unitId: z.string(),
  patch: ReviewUnitPatchSchema,
});

export const HunkViewedEventSchema = z.object({
  ...base,
  type: z.literal("hunk-viewed"),
  hunkId: z.string(),
  revision: z.number().int(),
});

export const HunkUnviewedEventSchema = z.object({
  ...base,
  type: z.literal("hunk-unviewed"),
  hunkId: z.string(),
  revision: z.number().int(),
});

export const UnitViewedEventSchema = z.object({
  ...base,
  type: z.literal("unit-viewed"),
  unitId: z.string(),
  revision: z.number().int().optional(),
});

export const ClassificationCorrectedEventSchema = z.object({
  ...base,
  type: z.literal("classification-corrected"),
  hunkId: z.string(),
  from: z.string(),
  to: z.string(),
  note: z.string().default(""),
});

export const FileSyncedGithubEventSchema = z.object({
  ...base,
  type: z.literal("file-synced-github"),
  file: z.string(),
  viewed: z.boolean(),
});

export const ReviewEventSchema = z.enum([
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
]);
export type ReviewEventKind = z.infer<typeof ReviewEventSchema>;

/**
 * The reader finished the review and submitted it on GitHub. Terminal for a
 * round of review; a later round appends another one (the log keeps them all).
 */
export const ReviewSubmittedEventSchema = z.object({
  ...base,
  type: z.literal("review-submitted"),
  event: ReviewEventSchema,
  url: z.string().optional(),
  commentCount: z.number().int().default(0),
});

/**
 * A Claude analysis run started for a revision. Recorded in the log (rather
 * than only in analysis-job.json) so the history of "when was this analyzed,
 * and did it succeed" folds into state like everything else.
 */
export const AnalysisStartedEventSchema = z.object({
  ...base,
  type: z.literal("analysis-started"),
  revision: z.number().int(),
});

export const AnalysisFinishedEventSchema = z.object({
  ...base,
  type: z.literal("analysis-finished"),
  revision: z.number().int(),
  /** terminal states only */
  status: z.enum(["done", "failed", "cancelled"]),
  error: z.string().optional(),
});

export const EventSchema = z.discriminatedUnion("type", [
  PrInitializedEventSchema,
  RevisionAddedEventSchema,
  AnalysisSetEventSchema,
  UnitUpdatedEventSchema,
  HunkViewedEventSchema,
  HunkUnviewedEventSchema,
  UnitViewedEventSchema,
  ClassificationCorrectedEventSchema,
  FileSyncedGithubEventSchema,
  ReviewSubmittedEventSchema,
  AnalysisStartedEventSchema,
  AnalysisFinishedEventSchema,
]);
export type ReviewerEvent = z.infer<typeof EventSchema>;
export type EventType = ReviewerEvent["type"];
export type EventOfType<T extends EventType> = Extract<
  ReviewerEvent,
  { type: T }
>;
/** An event as authored (ts filled in by the store). */
export type NewEvent = DistributiveOmit<ReviewerEvent, "ts">;
type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

/* ------------------------------------------------------------------- state */

export const RevisionInfoSchema = z.object({
  revision: z.number().int(),
  baseSha: z.string(),
  headSha: z.string(),
  mergeBase: z.string(),
  baseOnly: z.boolean().default(false),
  addedAt: z.string(),
});
export type RevisionInfo = z.infer<typeof RevisionInfoSchema>;

export const FileRollupSchema = z.object({
  path: z.string(),
  hunkIds: z.array(z.string()),
  viewedCount: z.number().int(),
  total: z.number().int(),
  viewed: z.boolean(),
  changedSinceViewed: z.boolean(),
  syncedToGithub: z.boolean().optional(),
});
export type FileRollup = z.infer<typeof FileRollupSchema>;

/** One entry per `review-submitted` event, oldest first. */
export const ReviewSubmissionSchema = z.object({
  event: ReviewEventSchema,
  url: z.string().optional(),
  commentCount: z.number().int().default(0),
  ts: z.string(),
  /** revision that was current when the review was submitted */
  revision: z.number().int(),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export const ArchivedHunkSchema = z.object({
  hunkId: z.string(),
  file: z.string(),
  archivedAtRevision: z.number().int(),
  wasViewed: z.boolean(),
});
export type ArchivedHunk = z.infer<typeof ArchivedHunkSchema>;

export const StateSchema = z.object({
  pr: z
    .object({
      host: z.string(),
      owner: z.string(),
      repo: z.string(),
      number: z.number().int(),
      url: z.string(),
      title: z.string().optional(),
    })
    .optional(),
  currentRevision: z.number().int(),
  revisions: z.array(RevisionInfoSchema).default([]),
  summary: z.string().default(""),
  analysisRevision: z.number().int().optional(),
  units: z.array(ReviewUnitSchema).default([]),
  hunks: z.record(z.string(), HunkStateSchema).default({}),
  files: z.array(FileRollupSchema).default([]),
  unassignedHunkIds: z.array(z.string()).default([]),
  archived: z.array(ArchivedHunkSchema).default([]),
  /** every review submitted from the app, oldest first (empty on old logs) */
  reviewSubmissions: z.array(ReviewSubmissionSchema).default([]),
  /**
   * The most recent Claude analysis run folded from the log. Absent on logs
   * written before the analysis events existed — every consumer must treat
   * "no analysis run on record" and "never analyzed" as the same thing.
   */
  analysisRun: z
    .object({
      revision: z.number().int(),
      status: z.enum(["running", "done", "failed", "cancelled"]),
      startedAt: z.string(),
      finishedAt: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  corrections: z
    .array(
      z.object({
        hunkId: z.string(),
        from: z.string(),
        to: z.string(),
        note: z.string(),
        ts: z.string(),
      }),
    )
    .default([]),
  lastMigration: MigrationReportSchema.optional(),
});
export type State = z.infer<typeof StateSchema>;
