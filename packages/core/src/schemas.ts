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

/** Stored-state limits. The CLI truncates to these instead of rejecting (see truncateFindings). */
export const FINDING_TEXT_MAX = 300;
export const FINDING_EVIDENCE_MAX = 200;

export const FindingSchema = z.object({
  severity: FindingSeveritySchema,
  text: z.string().min(1).max(FINDING_TEXT_MAX),
  /** concrete location(s) checked, e.g. `internal/api/handler.go:88, internal/vep/client.go:41` */
  evidence: z.string().min(1).max(FINDING_EVIDENCE_MAX),
});
export type Finding = z.infer<typeof FindingSchema>;

/** At most this many findings ride on one unit; beyond it, keep the material ones. */
export const MAX_UNIT_FINDINGS = 5;

/**
 * Stored-state sanity cap for one changelog note. Deliberately far above what
 * a note needs: an earlier 160-char cap clipped real notes mid-sentence
 * ("…"), and a clipped changelog is worse than a slightly long one. The CLI
 * still truncates past it (see truncateFindings), but only runaway output
 * ever gets there.
 */
export const CHANGELOG_TEXT_MAX = 1000;

/**
 * One line about what a revision changed in a unit ("rounding switched to
 * banker's; added a .5 test"). Written by the incremental analysis through a
 * unit patch's `changelogEntry`; at most one per revision.
 */
export const UnitChangelogEntrySchema = z.object({
  revision: z.number().int(),
  text: z.string().min(1).max(CHANGELOG_TEXT_MAX),
});
export type UnitChangelogEntry = z.infer<typeof UnitChangelogEntrySchema>;

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
  /**
   * What each later revision changed in this unit, oldest first, one entry per
   * revision. Optional like `findings`. Grown by `changelogEntry` on a unit
   * patch (see ReviewUnitPatchSchema); carried through migration and kept on
   * husks. `analysis-set` replaces units wholesale, so a full re-analysis
   * starts fresh changelogs unless its payload carries them.
   */
  changelog: z.array(UnitChangelogEntrySchema).optional(),
  /**
   * Set by the reducer, never by analysis: the revision in which every hunk
   * of this unit left the PR. Such a unit is a "husk" — kept for exactly one
   * revision so the reader can see a decision was dropped, then deleted on
   * the next `revision-added`. Husks have no hunks and count toward nothing
   * (progress, readiness, effort, numbering). Giving one hunks again revives
   * it and clears both fields.
   */
  removedAtRevision: z.number().int().optional(),
  /** On a husk: every hunk it had was viewed when they left the PR. */
  readBeforeRemoval: z.boolean().optional(),
});
export type ReviewUnit = z.infer<typeof ReviewUnitSchema>;

/** A unit whose hunks all left the PR (see `removedAtRevision`). */
export function isRemovedUnit(u: { removedAtRevision?: number }): boolean {
  return u.removedAtRevision !== undefined;
}

/**
 * `changelogEntry` is patch-only: the reducer adds it to `changelog` under the
 * state's current revision, replacing that revision's entry if there is one,
 * so a re-run never duplicates.
 */
const changelogEntryField = z.string().min(1).max(CHANGELOG_TEXT_MAX).optional();

export const ReviewUnitPatchSchema = ReviewUnitSchema.partial().extend({
  changelogEntry: changelogEntryField,
});

/** A brand-new unit sent through `set-unit`: the full unit, plus the patch-only field. */
export const NewReviewUnitSchema = ReviewUnitSchema.extend({
  changelogEntry: changelogEntryField,
});
export type ReviewUnitPatch = z.infer<typeof ReviewUnitPatchSchema>;

/** Payload accepted by `reviewer-state set-analysis --file <json>`. */
export const AnalysisSchema = z.object({
  summary: z.string(),
  units: z.array(ReviewUnitSchema),
  /** hunk ids deliberately left out of every unit */
  unassigned: z.array(z.string()).default([]),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/* ---------------------------------------------------- analysis sharing */

/**
 * Purview-to-Purview analysis export. Versioned so a future shape change can
 * be detected and rejected with a clear message rather than silently
 * misparsed. `pr`/`revision`/`headSha`/`mergeBase` are the exporter's own
 * anchors — informational on import, since hunk ids (not shas) are what
 * re-anchoring uses. Only `units` rides along: viewed state lives elsewhere
 * (hunks/files) and must never travel with the analysis, and `unassigned`
 * hunks are recomputed on import against the importer's own revision.
 */
export const AnalysisExportSchema = z.object({
  format: z.literal("purview-analysis"),
  version: z.literal(1),
  pr: z.object({
    host: z.string(),
    owner: z.string(),
    repo: z.string(),
    number: z.number().int(),
  }),
  revision: z.number().int(),
  headSha: z.string(),
  mergeBase: z.string(),
  exportedAt: z.string(),
  summary: z.string(),
  units: z.array(ReviewUnitSchema),
});
export type AnalysisExport = z.infer<typeof AnalysisExportSchema>;

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

/** The PR a stacked PR sits on (see `Meta.basePr`). */
export const BasePrSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
});
export type BasePr = z.infer<typeof BasePrSchema>;

/**
 * A still-pending request for the authenticated user's review (see
 * `Meta.reviewRequest`). `via` is `"you"` for a direct request, or
 * `"team:<slug>"` when it came through one of the user's teams.
 */
export const ReviewRequestSchema = z.object({
  /** ISO timestamp of the `review_requested` event. */
  at: z.string(),
  /** Login of whoever requested it ("" when GitHub does not say). */
  by: z.string(),
  via: z.string(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const MetaSchema = z.object({
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().optional(),
  /** GitHub login/avatar of the PR author; refreshed (and backfilled onto
   *  older state) by every refresh. */
  author: z.string().optional(),
  authorAvatarUrl: z.string().optional(),
  createdAt: z.string(),
  /**
   * The PR's head branch name, refreshed from GitHub on every refresh. Used to
   * pick the right git worktree out of a multi-worktree checkout; optional
   * because state written before this existed simply doesn't have it.
   */
  headRef: z.string().optional(),
  /**
   * The branch the PR targets (GitHub's `base.ref`), refreshed like `headRef`.
   * Optional because state written before it existed doesn't have it; the
   * staleness poll backfills it (server/staleness.ts).
   */
  baseRef: z.string().optional(),
  /**
   * The open PR whose head is `baseRef`, when the PR is stacked (targets a
   * branch other than the repo's default). `null` = not stacked, or stacked on
   * a branch no open PR heads; absent = not resolved yet.
   */
  basePr: BasePrSchema.nullable().optional(),
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
   * The user's still-pending review request on this PR, folded out of the
   * issue timeline (`github.ts` `foldReviewRequest`). `null` = none pending;
   * absent = not fetched yet. Refreshed on init/refresh, by the staleness
   * poll, and in the background when the PR list is served.
   */
  reviewRequest: ReviewRequestSchema.nullable().optional(),
  /** When `reviewRequest` was last looked up (success or not); rate-limits it. */
  reviewRequestCheckedAt: z.string().optional(),
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
 * Reasoning effort for a Claude run (`claude --effort`). `"none"` is not a
 * level — it is the escape hatch that means "omit the flag entirely", for a
 * `claude` CLI old enough not to know it. It is a real, pinnable value at
 * every layer, distinct from `null` ("inherit"), so it needs its own spot in
 * the enum rather than being folded into the nullability.
 */
export const AnalysisEffortSchema = z.enum(["low", "medium", "high", "none"]);
export type AnalysisEffort = z.infer<typeof AnalysisEffortSchema>;

export const ANALYSIS_EFFORTS = AnalysisEffortSchema.options;

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
  /** Reasoning effort for analysis runs; `null` inherits, same as the models above. */
  analysisEffort: AnalysisEffortSchema.nullable().default(null),
  /**
   * Poll GitHub every few minutes for review requests and import them
   * automatically (see review-watch.ts). Machine behavior, not team policy —
   * this field never participates in the committed `.purview/config.json`
   * layer, so it is resolved as `local.watchReviews === true` directly rather
   * than through `effectiveConfig`. `null` (the default) is off.
   */
  watchReviews: z.boolean().nullable().default(null),
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
  analysisEffort: AnalysisEffortSchema.optional(),
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
/**
 * Where an analysis run's wall time went, derived from the `claude -p
 * --output-format stream-json` event stream (see claude-runner.ts's `result`
 * event and analysis.ts's `runOne`). Every field is best-effort: a run that
 * never reaches a phase simply omits its key.
 */
export const AnalysisMetricsSchema = z.object({
  /** `num_turns` from the result line */
  turns: z.number().int().optional(),
  /** `duration_ms` from the result line */
  durationMs: z.number().optional(),
  /** `duration_api_ms` from the result line */
  apiMs: z.number().optional(),
  /** `total_cost_usd` from the result line */
  costUsd: z.number().optional(),
  usage: z
    .object({
      input: z.number().int().optional(),
      cacheCreation: z.number().int().optional(),
      cacheRead: z.number().int().optional(),
      output: z.number().int().optional(),
    })
    .optional(),
  /** count of tool calls per tool name (Read, Bash, Write, Edit, Glob, Grep …) */
  toolCalls: z.record(z.string(), z.number().int()).default({}),
  /** Bash calls, classified by what the command does; a call may count in
   *  several. `state` = touches the PR's state dir (files.json, diff.patch,
   *  events.jsonl) — the triage reads, however they are spelled. */
  bash: z
    .object({
      cli: z.number().int().default(0),
      state: z.number().int().default(0),
      grep: z.number().int().default(0),
      sed: z.number().int().default(0),
      other: z.number().int().default(0),
    })
    .default({ cli: 0, state: 0, grep: 0, sed: 0, other: 0 }),
  /** Read calls, classified by what path they read. */
  reads: z
    .object({
      filesJson: z.number().int().default(0),
      diffPatch: z.number().int().default(0),
      skill: z.number().int().default(0),
      checkout: z.number().int().default(0),
      other: z.number().int().default(0),
    })
    .default({ filesJson: 0, diffPatch: 0, skill: 0, checkout: 0, other: 0 }),
  /** 1-based index of the tool call at which each phase first began. */
  phases: z
    .object({
      firstInvestigationAt: z.number().int().optional(),
      firstWriteAt: z.number().int().optional(),
      setAnalysisAt: z.number().int().optional(),
    })
    .optional(),
});
export type AnalysisMetrics = z.infer<typeof AnalysisMetricsSchema>;

export const AnalysisJobSchema = z.object({
  revision: z.number().int(),
  status: AnalysisJobStatusSchema,
  queuedAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  progress: z.string().optional(),
  metrics: AnalysisMetricsSchema.optional(),
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
  /**
   * Provenance: absent/undefined for a normal skill-produced analysis,
   * `"import"` when the units came from another reader's exported analysis
   * (see analysis-share.ts) rather than a fresh Claude run. Additive and
   * optional, so every event written before this existed parses unchanged.
   */
  origin: z.literal("import").optional(),
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
  metrics: AnalysisMetricsSchema.optional(),
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
  /** the live unit that held this hunk when it was archived (see `changedUnits`) */
  unitId: z.string().optional(),
});
export type ArchivedHunk = z.infer<typeof ArchivedHunkSchema>;

/**
 * Bumped whenever the reducer's output for an existing event log changes
 * (a new derived field, a new rule). `loadState` re-folds any state.json
 * written under an older version, so stored PRs pick the change up on their
 * next read instead of only on their next appended event.
 */
export const STATE_SHAPE_VERSION = 3;

export const StateSchema = z.object({
  /** see STATE_SHAPE_VERSION; absent on every state.json written before it existed */
  shapeVersion: z.number().int().optional(),
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
  /** provenance of the current analysis; absent = produced by a normal Claude run */
  analysisOrigin: z.literal("import").optional(),
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
