/**
 * Local mirrors of the core types described in SPEC.md.
 * Deliberately NOT imported from @reviewer/core: packages/web talks to the
 * server over REST only, and must stay compilable on its own.
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
   * Optional raw patch body for the hunk (the lines after the @@ header,
   * each still carrying its leading ' ', '+' or '-').
   * If the server omits it we recover it from the raw diff text.
   */
  lines?: string[];
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

/** Word-level diff-of-diffs payload, when the server computes it. */
export interface WordDiffPiece {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface DiffOfDiffs {
  /** Raw previous / current hunk bodies. Always safe to render. */
  before?: string;
  after?: string;
  /** Optional precomputed word-level pieces. */
  wordDiff?: WordDiffPiece[];
}

export interface HunkState {
  viewed: boolean;
  viewedAtRevision?: number;
  changedSinceViewed: boolean;
  predecessorId?: string;
  migration?: "identical" | "fuzzy" | "renamed" | "new";
  /** Present when changedSinceViewed; shape tolerated loosely. */
  diffOfDiffs?: DiffOfDiffs;
}

export interface FileRollup {
  viewed: boolean;
  viewedHunks: number;
  totalHunks: number;
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

/** GET /api/prs */
export interface PrListEntry {
  key: string;
  meta: PrMeta;
  /** optional convenience fields the server may add */
  title?: string;
  unitCount?: number;
  viewedHunks?: number;
  totalHunks?: number;
  updatedAt?: string;
}

/** GET /api/prs/:key */
export interface PrDetail {
  key: string;
  meta: PrMeta;
  state: PrState;
  files: FilesJson;
  diff: string;
}

export interface MigrationReportItem {
  hunkId: string;
  file?: string;
  predecessorId?: string;
  note?: string;
}

/** POST /api/prs/:key/refresh */
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
  noChange?: boolean;
}

export interface DraftComment {
  id: string;
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  createdAt?: string;
  status?: "pending" | "posted";
}

export interface SyncResult {
  filesSynced?: number;
  commentsPosted?: number;
  reviewUrl?: string;
  drift?: string[];
  message?: string;
}
