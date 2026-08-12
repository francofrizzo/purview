import { diffWordsWithSpace } from "diff";
import type {
  DiffOfDiffs,
  DiscardPendingResult,
  DraftComment,
  MigrationReport,
  PrDetail,
  PrListEntry,
  ReviewEvent,
  ReviewStatus,
  ReviewUnit,
  SubmitReviewResult,
  SyncResult,
} from "../api/types";
import { mockDetail, mockDrafts, mockList } from "./fixture";

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

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

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
    };
    list.unshift(entry);
    return entry;
  },

  async getPr(key: string): Promise<PrDetail> {
    await delay(120);
    if (key !== detail.key) {
      throw new Error(`Mock mode only carries one fully analyzed PR (${detail.key}).`);
    }
    recomputeFileRollups();
    return structuredClone(detail);
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

  async refresh(_key: string): Promise<MigrationReport> {
    await delay(700);
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
};
