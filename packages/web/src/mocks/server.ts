import type {
  DraftComment,
  MigrationReport,
  PrDetail,
  PrListEntry,
  ReviewUnit,
  SyncResult,
} from "../api/types";
import { mockDetail, mockDrafts, mockList } from "./fixture";

/** In-memory mutable copy so the UI behaves like a real backend under VITE_MOCK=1. */
const detail: PrDetail = structuredClone(mockDetail);
const list: PrListEntry[] = structuredClone(mockList);
const drafts: DraftComment[] = structuredClone(mockDrafts);

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

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
      updatedAt: new Date().toISOString(),
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
    const posted = drafts.filter((d) => d.status !== "posted").length;
    for (const d of drafts) d.status = "posted";
    return {
      filesSynced: Object.values(detail.state.files ?? {}).filter((f) => f.viewed).length,
      commentsPosted: posted,
      reviewUrl: `${detail.meta.url}#pullrequestreview-mock`,
      message: "Mock sync: nothing left the machine.",
    };
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
      status: "pending",
      ...input,
    };
    drafts.push(draft);
    return draft;
  },
};
