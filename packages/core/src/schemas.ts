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

export const MetaSchema = z.object({
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().optional(),
  createdAt: z.string(),
});
export type Meta = z.infer<typeof MetaSchema>;

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
