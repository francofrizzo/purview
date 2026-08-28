import { diffWordsWithSpace } from "diff";
import { ApiError, CONFIRM_REQUIRED_PUBLIC_EDIT } from "../api/errors";
import type {
  AnalysisJob,
  ChatMessage,
  ChatRef,
  ChatState,
  DiffOfDiffs,
  DiscardPendingResult,
  DraftComment,
  EditCommentResult,
  MigrationReport,
  PrDetail,
  PrListEntry,
  ChatModelResult,
  ClaudeModel,
  GlobalConfig,
  GlobalConfigPatch,
  RepoConfig,
  RepoConfigPatch,
  RepoPathResult,
  RepoSummary,
  ReviewEvent,
  ReviewStatus,
  ReviewUnit,
  Staleness,
  StalenessReason,
  SubmitReviewResult,
  SyncResult,
} from "../api/types";
import { mockDetail, mockDrafts, mockList, mockRepoConfigs, mockRepos } from "./fixture";

/** Stand-in for the previous revision's body of the one hunk that changed. */
const MOCK_DOD_BEFORE: Record<string, string[]> = {
  a1b2c3d4e5f60001: [
    "  async charge(order: Order): Promise<ChargeResult> {",
    "    const key = idempotencyKey(order.id, order.total);",
    "    const existing = await this.ledger.findByKey(key);",
    "    if (existing) return existing.result;",
  ],
};

const MOCK_DOD_AFTER: Record<string, string[]> = {
  a1b2c3d4e5f60001: [
    "  async charge(order: Order): Promise<ChargeResult> {",
    "    const key = idempotencyKey(order.id, order.total, order.currency);",
    "    const existing = await this.ledger.findByKey(key);",
    "    if (existing) return existing.result;",
  ],
};

/** In-memory mutable copy so the UI behaves like a real backend under VITE_MOCK=1. */
const detail: PrDetail = structuredClone(mockDetail);
const list: PrListEntry[] = structuredClone(mockList);
const drafts: DraftComment[] = structuredClone(mockDrafts);
const repos: RepoSummary[] = structuredClone(mockRepos);
const repoConfigs: Record<string, RepoConfig> = structuredClone(mockRepoConfigs);

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/** The built-in fallback the server applies when nothing overrides it. */
const DEFAULT_AUTO_ANALYZE = false;

/** The real server's built-in model default; `null` anywhere resolves to it. */
const DEFAULT_MODEL: ClaudeModel = "sonnet";

/** `~/.purview/config.json`, the outermost layer. */
const globalConfig: { analysisModel: ClaudeModel | null; chatModel: ClaudeModel | null } = {
  analysisModel: null,
  chatModel: null,
};

/** Per-conversation model pins, keyed like the transcripts. */
const chatModels: Record<string, ClaudeModel | null> = {};

type Source = NonNullable<RepoConfig["sources"]>["chatModel"];

/** Mirrors repo-config.ts: repo local > committed > global > built-in. */
function resolveModel(
  rkey: string,
  field: "analysisModel" | "chatModel",
): { value: ClaudeModel; source: Source } {
  const config = repoConfigs[rkey];
  const local = config?.local[field] ?? null;
  const committed = (config?.committed.config as Record<string, ClaudeModel> | null)?.[field];
  const global = globalConfig[field];
  if (local) return { value: local, source: "repo" };
  if (committed) return { value: committed, source: "committed" };
  if (global) return { value: global, source: "global" };
  return { value: DEFAULT_MODEL, source: "default" };
}

/**
 * Recompute a repo's `effective`/`sources` blocks. On the real server this is
 * the resolver's job, so the mock has to do it too — the UI reads these
 * fields and never re-derives precedence itself.
 */
function relayer(rkey: string): void {
  const config = repoConfigs[rkey];
  if (!config) return;
  const committed = config.committed.config as { autoAnalyze?: boolean } | null;
  const analysisModel = resolveModel(rkey, "analysisModel");
  const chatModel = resolveModel(rkey, "chatModel");
  config.effective = {
    autoAnalyze: config.local.autoAnalyze ?? committed?.autoAnalyze ?? DEFAULT_AUTO_ANALYZE,
    repoPath: config.local.repoPath,
    analysisModel: analysisModel.value,
    chatModel: chatModel.value,
  };
  config.sources = {
    autoAnalyze:
      config.local.autoAnalyze !== null
        ? "repo"
        : committed?.autoAnalyze !== undefined
          ? "committed"
          : "default",
    repoPath: config.local.repoPath ? "repo" : "default",
    analysisModel: analysisModel.source,
    chatModel: chatModel.source,
  };
}

/** `host/owner/repo` out of a `host/owner/repo/number` PR key. */
function repoKeyOfPr(key: string): string {
  return key.split("/").slice(0, 3).join("/");
}

/** Keep the repo rollups honest after an archive/unarchive or an added PR. */
function syncRepoCounts() {
  const seen = new Set<string>();
  for (const pr of list) {
    const { host, owner, repo } = pr.meta;
    const rkey = `${host}/${owner}/${repo}`;
    seen.add(rkey);
    let summary = repos.find((r) => `${r.host}/${r.owner}/${r.repo}` === rkey);
    if (!summary) {
      summary = {
        host,
        owner,
        repo,
        prCount: 0,
        archivedCount: 0,
        hasLocalConfig: false,
        hasCommittedConfig: false,
        repoPath: null,
      };
      repos.push(summary);
      repoConfigs[rkey] ??= {
        local: {
          autoAnalyze: null,
          repoPath: null,
          analysisModel: null,
          chatModel: null,
          rubric: "",
          chatInstructions: "",
        },
        committed: { present: false, config: null, rubric: null, chat: null },
        effective: {
          autoAnalyze: DEFAULT_AUTO_ANALYZE,
          repoPath: null,
          analysisModel: DEFAULT_MODEL,
          chatModel: DEFAULT_MODEL,
        },
        sources: {
          autoAnalyze: "default",
          repoPath: "default",
          analysisModel: "default",
          chatModel: "default",
        },
      };
    }
  }
  for (const summary of repos) {
    const rkey = `${summary.host}/${summary.owner}/${summary.repo}`;
    const mine = list.filter((p) => `${p.meta.host}/${p.meta.owner}/${p.meta.repo}` === rkey);
    summary.prCount = mine.filter((p) => !p.archived).length;
    summary.archivedCount = mine.filter((p) => p.archived).length;
  }
}

/* ------------------------------------------------------------------------ */
/* Analysis jobs                                                             */
/*                                                                           */
/* The second fixture PR ships with no analysis at all, which is what makes  */
/* the live "queued → running → done" banner reachable in mock mode: running */
/* a job on it fills in units/hunks (borrowed from the analyzed fixture) so   */
/* the sidebar populates exactly the way it does against the real server.     */
/* ------------------------------------------------------------------------ */

const UNANALYZED_KEY = "github.com/acme/platform/1190";

const unanalyzed: PrDetail = {
  key: UNANALYZED_KEY,
  meta: list.find((p) => p.key === UNANALYZED_KEY)!.meta,
  state: { revision: 1, summary: "", units: [], hunks: {}, files: {} },
  files: { files: [] },
  diff: "",
  analysisJob: null,
};

const details: Record<string, PrDetail> = { [detail.key]: detail, [UNANALYZED_KEY]: unanalyzed };

const jobs: Record<string, AnalysisJob | null> = {};
const jobTimers: Record<string, ReturnType<typeof setTimeout>[]> = {};
const jobSubscribers: Record<string, Set<(job: AnalysisJob) => void>> = {};

const PROGRESS_STEPS = [
  "reading revision 1 diff (9 hunks, 8 files)…",
  "bucketing files: 3 must-read candidates…",
  "deep-reading src/billing/charge.ts…",
  "grouping hunks into review units…",
];

/* ------------------------------------------------------------- staleness */

/**
 * Upstream drift is faked from two localStorage keys, in the same spirit as
 * `reviewer.mockAnalysisFail`:
 *
 *   reviewer.mockStale     "1" (⇒ new-commits) or a comma-separated reason list
 *   reviewer.mockStaleSha  optional upstream head sha; changing it is what
 *                          makes the result *distinct* again after a dismiss
 */
function readStaleFlag(): { reasons: StalenessReason[]; sha: string } | null {
  let raw: string | null = null;
  let sha: string | null = null;
  try {
    raw = localStorage.getItem("reviewer.mockStale");
    sha = localStorage.getItem("reviewer.mockStaleSha");
  } catch {
    return null;
  }
  if (!raw || raw === "0") return null;
  const reasons = (raw === "1" ? ["new-commits"] : raw.split(","))
    .map((r) => r.trim())
    .filter((r): r is StalenessReason =>
      r === "new-commits" || r === "base-moved" || r === "state-changed",
    );
  if (reasons.length === 0) return null;
  return { reasons, sha: sha || `upstream-${reasons.join("-")}` };
}

/** Shas a mock refresh has already "fetched"; they stop reading as stale. */
const acknowledgedSha: Record<string, string> = {};

/** Flip this in the console/devtools to exercise the failure banner. */
function failureRequested(): boolean {
  try {
    return localStorage.getItem("reviewer.mockAnalysisFail") === "1";
  } catch {
    return false;
  }
}

function emitJob(key: string, job: AnalysisJob) {
  jobs[key] = job;
  const entry = list.find((p) => p.key === key);
  if (entry) entry.analysisJob = job;
  const target = details[key];
  if (target) target.analysisJob = job;
  for (const fn of jobSubscribers[key] ?? []) fn(structuredClone(job));
}

function clearJobTimers(key: string) {
  for (const t of jobTimers[key] ?? []) clearTimeout(t);
  jobTimers[key] = [];
}

function schedule(key: string, ms: number, fn: () => void) {
  (jobTimers[key] ??= []).push(setTimeout(fn, ms));
}

/** Copy the analyzed fixture's units/hunks onto a PR whose job just finished. */
function applyAnalysisResult(key: string) {
  const target = details[key];
  if (!target || target.state.units.length) return;
  const source = structuredClone(mockDetail);
  target.state = { ...source.state, revision: target.state.revision };
  target.files = source.files;
  target.diff = source.diff;
  const entry = list.find((p) => p.key === key);
  if (entry) {
    entry.unitCount = target.state.units.length;
    entry.totalHunks = Object.keys(target.state.hunks).length;
    entry.viewedHunks = 0;
    entry.summary = target.state.summary;
  }
}

function runJob(key: string) {
  const revision = details[key]?.state.revision ?? 1;
  const startedAt = new Date().toISOString();
  emitJob(key, { revision, status: "queued", startedAt });
  clearJobTimers(key);

  schedule(key, 700, () =>
    emitJob(key, { revision, status: "running", startedAt, progress: PROGRESS_STEPS[0] }),
  );
  PROGRESS_STEPS.slice(1).forEach((progress, i) => {
    schedule(key, 1600 + i * 1100, () =>
      emitJob(key, { revision, status: "running", startedAt, progress }),
    );
  });
  schedule(key, 1600 + PROGRESS_STEPS.length * 1100, () => {
    if (failureRequested()) {
      emitJob(key, {
        revision,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: "claude exited with status 1: no repo path configured for this PR",
      });
      return;
    }
    applyAnalysisResult(key);
    emitJob(key, { revision, status: "done", startedAt, finishedAt: new Date().toISOString() });
  });
}

/** Mock counterpart of review.json. */
const review: {
  body: string;
  pending: boolean;
  lastSubmission?: ReviewStatus["lastSubmission"];
} = { body: "", pending: false };

function recomputeFileRollups() {
  const rollups: PrDetail["state"]["files"] = {};
  for (const f of detail.files.files) {
    const viewedHunks = f.hunks.filter((h) => detail.state.hunks[h.id]?.viewed).length;
    rollups[f.path] = {
      viewed: viewedHunks === f.hunks.length && f.hunks.length > 0,
      viewedHunks,
      totalHunks: f.hunks.length,
      syncedToGitHub: detail.state.files?.[f.path]?.syncedToGitHub,
    };
  }
  detail.state.files = rollups;
}

/* ------------------------------------------------------------------------ */
/* Chat                                                                      */
/* ------------------------------------------------------------------------ */

const chats: Record<string, ChatMessage[]> = {};
const repoPaths: Record<string, string> = {};

/** A canned answer, written to exercise every markdown feature the panel renders. */
const CANNED_REPLY = `The riskiest change here is the **ledger write ordering** in \`charge()\`. The
idempotency key is derived before the gateway call, but the ledger row is only
written *after* it returns — so a crash between the two leaves no record of an
in-flight charge, and the retry wrapper will happily charge again.

Three things I would push on:

- \`idempotencyKey(order.id, order.total, order.currency)\` concatenates fields
  with a separator that can itself appear in an id. Two different orders can
  collide.
- The retry wrapper's jitter is applied *after* the attempt counter check, so
  the final attempt has no backoff at all.
- \`charge_ledger\` has no index on \`key\`, and the replay lookup is on the hot
  path of every payment.

The write-before-call shape looks like this:

\`\`\`typescript
const key = idempotencyKey(order.id, order.total, order.currency);
const existing = await this.ledger.findByKey(key);
if (existing) return existing.result;

await this.ledger.reserve(key);           // durable marker, before the call
const res = await this.gateway.charge(order.total, order.currency, {
  idempotencyKey: key,
});
await this.ledger.record(key, res);
\`\`\`

That turns a crash into a *stuck* charge (recoverable by reconciliation) rather
than a *double* charge, which is the tradeoff you want on money paths. See the
notes in [docs/billing.md](https://example.com/docs/billing) for the reconciliation
job that would sweep reserved-but-unrecorded rows.`;

const TOOL_CALLS: { name: string; detail: string; at: number }[] = [
  { name: "read", detail: "src/billing/charge.ts", at: 0 },
  { name: "grep", detail: "idempotencyKey — 6 matches", at: 3 },
  { name: "read", detail: "src/billing/ledger.ts", at: 9 },
];

const encoder = new TextEncoder();

const frame = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Split into delta-sized pieces the way a real token stream arrives. */
function chunkReply(text: string): string[] {
  const out: string[] = [];
  const words = text.split(/(\s+)/);
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length >= 14) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

export const mockApi = {
  async listPrs(): Promise<PrListEntry[]> {
    await delay(80);
    return structuredClone(list);
  },

  async addPr(url: string): Promise<PrListEntry> {
    await delay(300);
    const m = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
    if (!m) throw new Error("Not a recognizable pull request URL");
    const [, host, owner, repo, number] = m;
    const key = `${host}/${owner}/${repo}/${number}`;
    const existing = list.find((p) => p.key === key);
    if (existing) return existing;
    const entry: PrListEntry = {
      key,
      meta: { host, owner, repo, number: Number(number), url, title: `${repo}#${number}` },
      title: `${repo}#${number}`,
      unitCount: 0,
      viewedHunks: 0,
      totalHunks: 0,
      state: "open",
      reviewDecision: null,
      addedAt: new Date().toISOString(),
      archived: false,
    };
    list.unshift(entry);
    syncRepoCounts();
    return entry;
  },

  /** Local-only, exactly as the tooltip in the UI claims. */
  async setArchived(key: string, archived: boolean): Promise<void> {
    await delay(120);
    const entry = list.find((p) => p.key === key);
    if (!entry) throw new ApiError("not_found", 404, `No PR "${key}"`);
    entry.archived = archived;
    syncRepoCounts();
  },

  /* ----------------------------------------------------------------- repos */

  async listRepos(): Promise<RepoSummary[]> {
    await delay(80);
    syncRepoCounts();
    return structuredClone(repos);
  },

  async getRepoConfig(rkey: string): Promise<RepoConfig> {
    await delay(100);
    const config = repoConfigs[rkey];
    if (!config) throw new ApiError("not_found", 404, `No repo "${rkey}" is tracked locally.`);
    // The global layer may have moved since this repo was last written.
    relayer(rkey);
    return structuredClone(config);
  },

  /* ---------------------------------------------------------- global config */

  async getConfig(): Promise<GlobalConfig> {
    await delay(80);
    return {
      ...globalConfig,
      defaults: { analysisModel: DEFAULT_MODEL, chatModel: DEFAULT_MODEL },
    };
  },

  async saveConfig(patch: GlobalConfigPatch): Promise<GlobalConfig> {
    await delay(180);
    if (patch.analysisModel !== undefined) globalConfig.analysisModel = patch.analysisModel;
    if (patch.chatModel !== undefined) globalConfig.chatModel = patch.chatModel;
    for (const rkey of Object.keys(repoConfigs)) relayer(rkey);
    return {
      ...globalConfig,
      defaults: { analysisModel: DEFAULT_MODEL, chatModel: DEFAULT_MODEL },
    };
  },

  /**
   * A partial PUT, answered with the whole re-layered config — including the
   * `effective` block, which is the server's job to recompute (local wins over
   * committed, committed over the built-in default).
   */
  async saveRepoConfig(rkey: string, patch: RepoConfigPatch): Promise<RepoConfig> {
    await delay(220);
    const config = repoConfigs[rkey];
    if (!config) throw new ApiError("not_found", 404, `No repo "${rkey}" is tracked locally.`);
    if (patch.autoAnalyze !== undefined) config.local.autoAnalyze = patch.autoAnalyze;
    if (patch.repoPath !== undefined) config.local.repoPath = patch.repoPath || null;
    if (patch.analysisModel !== undefined) config.local.analysisModel = patch.analysisModel;
    if (patch.chatModel !== undefined) config.local.chatModel = patch.chatModel;
    if (patch.rubric !== undefined) config.local.rubric = patch.rubric;
    if (patch.chatInstructions !== undefined) config.local.chatInstructions = patch.chatInstructions;
    relayer(rkey);
    const summary = repos.find((r) => `${r.host}/${r.owner}/${r.repo}` === rkey);
    if (summary) {
      summary.repoPath = config.effective.repoPath;
      summary.hasLocalConfig =
        config.local.autoAnalyze !== null ||
        Boolean(config.local.repoPath) ||
        Boolean(config.local.analysisModel) ||
        Boolean(config.local.chatModel) ||
        Boolean(config.local.rubric.trim()) ||
        Boolean(config.local.chatInstructions.trim());
    }
    return structuredClone(config);
  },

  async getPr(key: string): Promise<PrDetail> {
    await delay(120);
    let target = details[key];
    if (!target) {
      const entry = list.find((p) => p.key === key);
      if (!entry) throw new Error(`No PR "${key}" in the fixture.`);
      // The extra fixture rows exist to populate the home screen's groups; they
      // get an empty detail so opening one is a no-op rather than an error.
      target = details[key] = {
        key,
        meta: entry.meta,
        state: { revision: 1, summary: "", units: [], hunks: {}, files: {} },
        files: { files: [] },
        diff: "",
        analysisJob: null,
      };
    }
    if (target === detail) recomputeFileRollups();
    target.analysisJob = jobs[key] ?? null;
    return structuredClone(target);
  },

  async setHunkViewed(_key: string, hunkId: string, viewed: boolean): Promise<void> {
    await delay(60);
    const prev = detail.state.hunks[hunkId] ?? { viewed: false, changedSinceViewed: false };
    detail.state.hunks[hunkId] = {
      ...prev,
      viewed,
      viewedAtRevision: viewed ? detail.state.revision : undefined,
      changedSinceViewed: viewed ? prev.changedSinceViewed : false,
    };
    recomputeFileRollups();
  },

  async setUnitViewed(_key: string, unitId: string): Promise<void> {
    await delay(90);
    const unit = detail.state.units.find((u) => u.id === unitId);
    if (!unit) return;
    for (const id of unit.hunkIds) {
      const prev = detail.state.hunks[id] ?? { viewed: false, changedSinceViewed: false };
      detail.state.hunks[id] = { ...prev, viewed: true, viewedAtRevision: detail.state.revision };
    }
    recomputeFileRollups();
  },

  async patchUnit(_key: string, unitId: string, patch: Partial<ReviewUnit>): Promise<void> {
    await delay(80);
    const unit = detail.state.units.find((u) => u.id === unitId);
    if (unit) Object.assign(unit, patch);
  },

  async refresh(key: string): Promise<MigrationReport> {
    await delay(700);
    // Mirrors the server: a refresh that lands new hunks on a PR with no
    // analysis auto-queues one, and the UI picks that up over /events.
    if (details[key] && !details[key].state.units.length && !isLive(jobs[key])) {
      runJob(key);
    }
    // A real refresh fetches whatever upstream had, so the drift it was
    // reporting is gone until upstream moves again.
    const flag = readStaleFlag();
    if (flag) acknowledgedSha[key] = flag.sha;
    return {
      revision: detail.state.revision,
      baseOnly: false,
      counts: { carried: 7, fuzzy: 1, renamed: 0, archived: 1, new: 1 },
      fuzzy: [
        {
          hunkId: "a1b2c3d4e5f60001",
          file: "src/billing/charge.ts",
          predecessorId: "a1b2c3d4e5f6ff01",
          note: "currency added to key derivation",
        },
      ],
      archived: [
        { hunkId: "a1b2c3d4e5f6fe07", file: "src/billing/legacy.ts", note: "file deleted upstream" },
      ],
      new: [
        { hunkId: "a1b2c3d4e5f60004", file: "migrations/0042_charge_ledger.sql", note: "unassigned" },
      ],
    };
  },

  async staleness(key: string): Promise<Staleness> {
    await delay(80);
    const flag = readStaleFlag();
    const localState = list.find((p) => p.key === key)?.state ?? "open";
    const base: Staleness = {
      stale: false,
      reasons: [],
      upstreamHeadSha: flag?.sha ?? "local-head",
      localHeadSha: "local-head",
      upstreamState: localState,
      localState,
      checkedAt: new Date().toISOString(),
    };
    if (!flag || acknowledgedSha[key] === flag.sha) return base;
    return {
      ...base,
      stale: true,
      reasons: flag.reasons,
      upstreamState: flag.reasons.includes("state-changed") ? "merged" : localState,
    };
  },

  async sync(_key: string): Promise<SyncResult> {
    await delay(600);
    const pushed = drafts.filter((d) => d.status === "draft").length;
    for (const d of drafts) if (d.status === "draft") d.status = "pushed";
    review.pending = true;
    return {
      filesSynced: Object.values(detail.state.files ?? {}).filter((f) => f.viewed).length,
      commentsPosted: pushed,
      reviewUrl: `${detail.meta.url}#pullrequestreview-mock`,
      message: "Mock sync: nothing left the machine.",
    };
  },

  async diffOfDiffs(_key: string, hunkId: string): Promise<DiffOfDiffs> {
    await delay(150);
    const before = MOCK_DOD_BEFORE[hunkId];
    const after = MOCK_DOD_AFTER[hunkId];
    if (!before || !after) {
      throw new Error(`No predecessor recorded for hunk ${hunkId}`);
    }
    const lines: DiffOfDiffs["lines"] = before.map((oldLine, i) => {
      const newLine = after[i] ?? "";
      if (oldLine === newLine) return { type: "unchanged", oldLine, newLine };
      return {
        type: "modified",
        oldLine,
        newLine,
        parts: diffWordsWithSpace(oldLine, newLine).map((p) => ({
          value: p.value,
          type: p.added ? "added" : p.removed ? "removed" : "same",
        })),
      };
    });
    return { lines, changed: lines.some((l) => l.type !== "unchanged") };
  },

  async listComments(_key: string): Promise<DraftComment[]> {
    await delay(60);
    return structuredClone(drafts);
  },

  async addComment(
    _key: string,
    input: { file: string; line: number; side: "LEFT" | "RIGHT"; body: string },
  ): Promise<DraftComment> {
    await delay(120);
    const draft: DraftComment = {
      id: `draft-${drafts.length + 1}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      status: "draft",
      ...input,
    };
    drafts.push(draft);
    return draft;
  },

  /**
   * Mirrors the server's PATCH semantics exactly: draft edits are local-only,
   * pushed/submitted edits report a `remote` outcome, an already-public
   * comment needs `confirm`, and an unchanged body is a no-op.
   */
  async editComment(
    _key: string,
    input: { id: string; body: string; confirm?: boolean },
  ): Promise<EditCommentResult> {
    await delay(180);
    if (!input.body.trim()) throw new ApiError("invalid_body", 400, "Body must be non-empty");
    const target = drafts.find((d) => d.id === input.id);
    if (!target) throw new ApiError("not_found", 404, `No comment "${input.id}"`);
    if (target.body === input.body) return { comment: structuredClone(target), remote: null };
    if (target.status === "submitted" && input.confirm !== true) {
      throw new ApiError(
        CONFIRM_REQUIRED_PUBLIC_EDIT,
        400,
        "Editing a submitted (public) comment is visible to others; resend with { confirm: true }",
      );
    }
    target.body = input.body;
    const comment = structuredClone(target);
    if (target.status === "draft") return { comment, remote: null };
    // Mock GitHub: comments we never got an id back for cannot be mirrored.
    if (target.githubCommentId === undefined) {
      return {
        comment,
        remote: {
          ok: false,
          reason:
            "No GitHub comment id on record for this comment, so the edit could not be mirrored " +
            "remotely. Discard the pending review and re-sync to pick up an id, then retry.",
        },
      };
    }
    return { comment, remote: { ok: true } };
  },

  async deleteComment(_key: string, id: string): Promise<void> {
    await delay(80);
    const i = drafts.findIndex((d) => d.id === id);
    if (i >= 0) drafts.splice(i, 1);
  },

  /* ------------------------------------------------------ review lifecycle */

  async getReview(_key: string): Promise<ReviewStatus> {
    await delay(80);
    const units = detail.state.units;
    const complete = (u: (typeof units)[number]) =>
      u.hunkIds.length > 0 && u.hunkIds.every((id) => detail.state.hunks[id]?.viewed);
    const mustRead = units.filter((u) => u.attention === "must-read");
    const hunks = Object.values(detail.state.hunks);
    const mustReadUnviewed = mustRead.filter((u) => !complete(u)).length;
    return {
      body: review.body,
      counts: {
        draft: drafts.filter((d) => d.status === "draft").length,
        pushed: drafts.filter((d) => d.status === "pushed").length,
        submitted: drafts.filter((d) => d.status === "submitted").length,
      },
      included: drafts
        .filter((d) => d.status !== "submitted")
        .map((d) => ({
          id: d.id,
          file: d.file,
          line: d.line,
          side: d.side,
          body: d.body,
          status: d.status ?? "draft",
        })),
      pending: { known: true, exists: review.pending },
      readiness: {
        hunks: { viewed: hunks.filter((h) => h.viewed).length, total: hunks.length },
        units: { complete: units.filter(complete).length, total: units.length },
        mustRead: {
          complete: mustRead.filter(complete).length,
          total: mustRead.length,
          unviewed: mustReadUnviewed,
        },
        changedSinceViewed: hunks.filter((h) => h.changedSinceViewed).length,
        ready: mustReadUnviewed === 0,
      },
      lastSubmission: review.lastSubmission,
      submittedAt: review.lastSubmission?.ts,
      submittedEvent: review.lastSubmission?.event,
      submittedUrl: review.lastSubmission?.url,
    };
  },

  async saveReviewBody(_key: string, body: string): Promise<void> {
    await delay(60);
    review.body = body;
  },

  async submitReview(
    _key: string,
    input: { event: ReviewEvent; body?: string },
  ): Promise<SubmitReviewResult> {
    await delay(500);
    const included = drafts.filter((d) => d.status !== "submitted");
    for (const d of included) d.status = "submitted";
    review.pending = false;
    review.lastSubmission = {
      event: input.event,
      url: `${detail.meta.url}#pullrequestreview-mock`,
      commentCount: included.length,
      ts: new Date().toISOString(),
      revision: detail.state.revision,
    };
    return {
      event: input.event,
      url: review.lastSubmission.url,
      commentCount: included.length,
    };
  },

  async discardPendingReview(_key: string): Promise<DiscardPendingResult> {
    await delay(200);
    const reset = drafts.filter((d) => d.status === "pushed");
    for (const d of reset) d.status = "draft";
    const discarded = review.pending;
    review.pending = false;
    return { discarded, resetToDraft: reset.length };
  },

  /* -------------------------------------------------------- analysis jobs */

  async getAnalysisJob(key: string): Promise<AnalysisJob | null> {
    await delay(50);
    return jobs[key] ? structuredClone(jobs[key]!) : null;
  },

  async startAnalysis(key: string): Promise<AnalysisJob> {
    await delay(120);
    if (isLive(jobs[key])) {
      throw new ApiError("already_running", 409, "An analysis is already queued for this PR");
    }
    runJob(key);
    return structuredClone(jobs[key]!);
  },

  async cancelAnalysis(key: string): Promise<AnalysisJob> {
    await delay(80);
    clearJobTimers(key);
    const current = jobs[key];
    const cancelled: AnalysisJob = {
      revision: current?.revision ?? details[key]?.state.revision ?? 1,
      status: "cancelled",
      startedAt: current?.startedAt,
      finishedAt: new Date().toISOString(),
    };
    emitJob(key, cancelled);
    return structuredClone(cancelled);
  },

  subscribeAnalysis(key: string, onJob: (job: AnalysisJob) => void): () => void {
    (jobSubscribers[key] ??= new Set()).add(onJob);
    return () => {
      jobSubscribers[key]?.delete(onJob);
    };
  },

  /* ------------------------------------------------------------------ chat */

  async setRepoPath(key: string, path: string): Promise<RepoPathResult> {
    await delay(150);
    const value = path.trim();
    if (!value) throw new ApiError("invalid_path", 400, "A repo path is required");
    repoPaths[key] = value;
    return {
      ok: true,
      warning: value.startsWith("/")
        ? undefined
        : "That looks like a relative path; it is resolved against the server's working directory.",
    };
  },

  async getChat(key: string): Promise<ChatState> {
    await delay(60);
    const messages = chats[key] ?? [];
    const configured = resolveModel(repoKeyOfPr(key), "chatModel");
    const sessionModel = chatModels[key] ?? null;
    return {
      messages: structuredClone(messages),
      sessionId: messages.length ? `mock-session-${key}` : null,
      busy: false,
      model: sessionModel ?? configured.value,
      configuredModel: configured.value,
      configuredModelSource: configured.source,
      sessionModel,
    };
  },

  async setChatModel(key: string, model: ClaudeModel | null): Promise<ChatModelResult> {
    await delay(140);
    chatModels[key] = model;
    const configured = resolveModel(repoKeyOfPr(key), "chatModel");
    return {
      model: model ?? configured.value,
      configuredModel: configured.value,
      configuredModelSource: configured.source,
      sessionModel: model,
      // The real CLI resumes a session under a different model, so the
      // transcript survives; the mock says the same thing.
      restartedSession: false,
    };
  },

  async clearChat(key: string): Promise<void> {
    await delay(90);
    chats[key] = [];
    chatModels[key] = null;
  },

  /**
   * The reply arrives as a real `text/event-stream` byte stream, so mock mode
   * exercises the same parser (lib/sse.ts) as the server does. Sending a
   * message containing "fail" streams an `error` event instead, which is how
   * the composer's retry row is reachable without a broken backend.
   */
  streamChat(
    key: string,
    input: { text: string; refs?: ChatRef[] },
    signal?: AbortSignal,
  ): ReadableStream<Uint8Array> {
    const store = (chats[key] ??= []);
    store.push({
      role: "user",
      text: input.text,
      ts: new Date().toISOString(),
      refs: input.refs?.length ? structuredClone(input.refs) : undefined,
    });

    const shouldFail = /\bfail\b/i.test(input.text);
    const chunks = chunkReply(CANNED_REPLY);
    let cancelled = false;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const stop = () => cancelled || signal?.aborted;
        signal?.addEventListener("abort", () => {
          cancelled = true;
        });

        await delay(320);
        if (stop()) return controller.close();

        if (shouldFail) {
          controller.enqueue(
            frame("error", { error: "claude-cli exited before answering (mock failure)" }),
          );
          controller.close();
          store.pop();
          return;
        }

        let text = "";
        for (let i = 0; i < chunks.length; i++) {
          for (const tool of TOOL_CALLS) {
            if (tool.at === i) {
              controller.enqueue(frame("tool", { name: tool.name, detail: tool.detail }));
              await delay(420);
            }
          }
          if (stop()) return controller.close();
          text += chunks[i];
          controller.enqueue(frame("delta", { text: chunks[i] }));
          await delay(18 + Math.round(Math.random() * 26));
        }

        const message: ChatMessage = { role: "assistant", text, ts: new Date().toISOString() };
        store.push(message);
        controller.enqueue(frame("done", { message }));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
  },
};

const isLive = (job?: AnalysisJob | null) => job?.status === "queued" || job?.status === "running";
