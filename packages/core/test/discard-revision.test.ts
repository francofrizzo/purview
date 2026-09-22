import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setGhRunner } from "../src/github.js";
import {
  DiscardRefusedError,
  discardRevision,
  initPr,
  refreshPr,
  setAnalysis,
  setHunkViewed,
  setUnit,
} from "../src/service.js";
import { appendEvent, loadState, readEvents, readFilesJson, readMeta, rebuildState, updateMeta } from "../src/store.js";
import { analysisJobPath, commentsPath, revisionDir, statePath, type PrKey } from "../src/paths.js";
import { applyEvent, fold, nextRevisionNumber, priorRevisions, withoutDiscarded } from "../src/reducer.js";
import type { ReviewerEvent, State } from "../src/schemas.js";

const fixture = (name: string) =>
  fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const REV1 = fixture("rev1.patch");
const REV2 = fixture("rev2.patch");
const REV3 = REV2 + fixture("rev3-extra.patch");

const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 9 };

/** Stubbed `gh`: whatever `remote` says is on GitHub right now. */
const remote = { headSha: "head1", diff: REV1 };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-discard-test-"));
  process.env.REVIEWER_STATE_DIR = root;
  remote.headSha = "head1";
  remote.diff = REV1;
  setGhRunner((args) => {
    if (args[0] !== "api") throw new Error(`unexpected gh ${args.join(" ")}`);
    if (args.includes("-H")) return remote.diff;
    const endpoint = args[1];
    if (endpoint.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    if (/\/pulls\/\d+$/.test(endpoint))
      return JSON.stringify({
        node_id: "PR_kwABC",
        number: key.number,
        title: "Add widgets",
        html_url: "https://github.com/acme/widgets/pull/9",
        state: "open",
        base: { ref: "main", sha: "base1" },
        head: { ref: "feature", sha: remote.headSha },
      });
    throw new Error(`unexpected gh api ${endpoint}`);
  });
});

afterEach(() => {
  setGhRunner(null);
  delete process.env.REVIEWER_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

function refreshOnto(diff: string, headSha: string) {
  remote.diff = diff;
  remote.headSha = headSha;
  return refreshPr(key, root);
}

/** Revision 1, fully analyzed (one unit per file) with a couple of hunks viewed. */
function seedAnalyzedRev1(): State {
  initPr(key, root);
  const files = readFilesJson(key, 1, root).files;
  setAnalysis(
    key,
    {
      summary: "s",
      units: files.map((f, i) => ({
        id: `u${i}`,
        title: f.path,
        summary: "s",
        kind: "core-logic",
        attention: "skim",
        attentionWhy: "why",
        riskFlags: [],
        hunkIds: f.hunks.map((h) => h.id),
        order: i,
      })),
    },
    {},
    root,
  );
  setHunkViewed(key, files[0].hunks[0].id, true, root);
  setHunkViewed(key, files[1].hunks[0].id, true, root);
  return loadState(key, root);
}

describe("withoutDiscarded / nextRevisionNumber (pure)", () => {
  const ts = "2026-01-01T00:00:00.000Z";
  const added = (revision: number): ReviewerEvent => ({
    ts,
    type: "revision-added",
    revision,
    baseSha: "b",
    headSha: `h${revision}`,
    mergeBase: "m",
    baseOnly: false,
    files: [],
  });
  const viewed = (hunkId: string, revision: number): ReviewerEvent => ({
    ts,
    type: "hunk-viewed",
    hunkId,
    revision,
  });
  const discarded = (revision: number): ReviewerEvent => ({ ts, type: "revision-discarded", revision });
  const synced: ReviewerEvent = { ts, type: "file-synced-github", file: "a.ts", viewed: true };
  const submitted: ReviewerEvent = { ts, type: "review-submitted", event: "COMMENT", commentCount: 0 };

  it("drops everything from the revision's revision-added up to the discard, keeping GitHub facts", () => {
    const events = [added(1), viewed("x", 1), added(2), viewed("y", 2), synced, submitted, discarded(2)];
    expect(withoutDiscarded(events)).toEqual([added(1), viewed("x", 1), synced, submitted]);
  });

  it("unwinds a discard of N and then of N-1, and ignores one naming an unknown revision", () => {
    const events = [added(1), added(2), viewed("a", 2), added(3), synced, discarded(3), discarded(2)];
    expect(withoutDiscarded(events)).toEqual([added(1), synced]);
    expect(withoutDiscarded([added(1), discarded(7)])).toEqual([added(1)]);
  });

  it("drops a revision added after an earlier discard too (numbers are not reused)", () => {
    const events = [added(1), added(2), discarded(2), added(3), viewed("z", 3), discarded(3), viewed("w", 1)];
    expect(withoutDiscarded(events)).toEqual([added(1), viewed("w", 1)]);
    expect(nextRevisionNumber(events)).toBe(4);
  });

  it("counts discarded revisions when numbering the next one", () => {
    expect(nextRevisionNumber([])).toBe(1);
    expect(nextRevisionNumber([added(1), added(2), discarded(2)])).toBe(3);
  });

  it("priorRevisions walks only revisions still on record, newest first", () => {
    const state = fold([added(1), added(2), discarded(2), added(3), added(4)]);
    expect(priorRevisions(state)).toEqual([3, 1]);
  });
});

describe("discardRevision", () => {
  it("restores revision N-1 exactly, keeping only what already happened on GitHub", () => {
    const before = seedAnalyzedRev1();

    // The mid-rebase revision: hunks go missing, the reader keeps working.
    const r2 = refreshOnto(REV2, "head2");
    expect(r2.report!.counts.archived).toBeGreaterThan(0);
    const r2Files = readFilesJson(key, 2, root).files;
    setHunkViewed(key, r2Files[0].hunks[0].id, true, root);
    setUnit(key, "u0", { changelogEntry: "reworked mid-rebase" }, {}, root);
    // ...and things happen on GitHub meanwhile.
    appendEvent(key, { type: "file-synced-github", file: before.files[0].path, viewed: true }, root);
    appendEvent(key, { type: "review-submitted", event: "COMMENT", commentCount: 0 }, root);

    const res = discardRevision(key, 2, root);
    expect(res).toMatchObject({ discarded: 2, revision: 1 });

    const events = readEvents(key, root);
    const kept = events.filter((e) => e.type === "file-synced-github" || e.type === "review-submitted");
    const expected = kept.reduce(applyEvent, before);
    expect(res.state).toEqual(expected);
    expect(res.state.currentRevision).toBe(1);
    expect(res.state.revisions.map((r) => r.revision)).toEqual([1]);
    expect(res.state.units).toEqual(before.units);
    expect(res.state.hunks).toEqual(before.hunks);
    expect(res.state.archived).toEqual([]);
    expect(res.state.reviewSubmissions).toHaveLength(1);
    expect(res.state.files[0].syncedToGithub).toBe(true);

    // The log was only appended to, and revision 2's files stay on disk.
    expect(events.at(-1)).toMatchObject({ type: "revision-discarded", revision: 2 });
    expect(events.filter((e) => e.type === "revision-added")).toHaveLength(2);
    expect(fs.existsSync(revisionDir(key, 2, root))).toBe(true);

    // The snapshot is the fold, however it is rebuilt.
    expect(loadState(key, root)).toEqual(res.state);
    fs.rmSync(statePath(key, root));
    expect(loadState(key, root)).toEqual(res.state);
    expect(rebuildState(key, root)).toEqual(res.state);
  });

  it("never reuses the number, and the next refresh migrates from N-1", () => {
    const before = seedAnalyzedRev1();
    refreshOnto(REV2, "head2");
    discardRevision(key, 2, root);

    // Same head as revision 1: nothing moved relative to the revision in force.
    const noop = refreshOnto(REV1, "head1");
    expect(noop).toMatchObject({ added: false, revision: 1 });

    // The finished push lands as r3, compared against r1 in one step.
    const r3 = refreshOnto(REV3, "head3");
    expect(r3.revision).toBe(3);
    expect(r3.report!.previousRevision).toBe(1);
    expect(r3.state.revisions.map((r) => r.revision)).toEqual([1, 3]);
    const r1Ids = new Set(before.files.flatMap((f) => f.hunkIds));
    for (const e of r3.report!.entries) {
      if (e.previousHunkId) expect(r1Ids.has(e.previousHunkId)).toBe(true);
      if (e.status === "archived") expect(r1Ids.has(e.hunkId)).toBe(true);
    }
    // Viewed marks from r1 carried straight across.
    const carried = r3.report!.entries.find((e) => e.status === "identical" && before.hunks[e.hunkId]?.viewed);
    expect(carried && r3.state.hunks[carried.hunkId].viewed).toBe(true);

    // A second discard (of r3) goes back to r1 again, and numbering moves on to 4.
    expect(discardRevision(key, 3, root).revision).toBe(1);
    expect(refreshOnto(REV2, "head4").revision).toBe(4);
  });

  it("refuses anything but the current revision, and the only one", () => {
    seedAnalyzedRev1();
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(DiscardRefusedError);
        return (err as DiscardRefusedError).code;
      }
      throw new Error("expected a refusal");
    };
    expect(refusal(() => discardRevision(key, 1, root))).toBe("only_revision");
    refreshOnto(REV2, "head2");
    expect(refusal(() => discardRevision(key, 1, root))).toBe("not_latest");
    expect(refusal(() => discardRevision(key, 3, root))).toBe("not_latest");
    expect(loadState(key, root).currentRevision).toBe(2);
  });

  it("refuses while an analysis is queued or running", () => {
    seedAnalyzedRev1();
    refreshOnto(REV2, "head2");
    fs.writeFileSync(analysisJobPath(key, root), JSON.stringify({ revision: 2, status: "running" }));
    expect(() => discardRevision(key, 2, root)).toThrow(/analysis is running/);
    fs.writeFileSync(analysisJobPath(key, root), JSON.stringify({ revision: 2, status: "queued" }));
    expect(() => discardRevision(key, 2, root)).toThrow(/analysis is queued/);
  });

  it("refuses while comments written since the revision was added exist, and says how many", () => {
    seedAnalyzedRev1();
    refreshOnto(REV2, "head2");
    const addedAt = loadState(key, root).revisions.find((r) => r.revision === 2)!.addedAt;
    const later = new Date(Date.parse(addedAt) + 1000).toISOString();
    const earlier = new Date(Date.parse(addedAt) - 1000).toISOString();
    const comment = (id: string, createdAt: string, status: string) => ({
      id,
      file: "src/auth.ts",
      subjectType: "line",
      line: 3,
      side: "RIGHT",
      body: "b",
      createdAt,
      status,
    });
    fs.writeFileSync(
      commentsPath(key, root),
      JSON.stringify([comment("a", earlier, "draft"), comment("b", later, "draft"), comment("c", later, "pushed")]),
    );
    expect(() => discardRevision(key, 2, root)).toThrow(/^2 comments were written since r2/);

    // Comments from before the revision refer to r1's diff: they do not block.
    // Nor do submitted ones: they are on GitHub and can't be deleted.
    fs.writeFileSync(
      commentsPath(key, root),
      JSON.stringify([comment("a", earlier, "draft"), comment("s", later, "submitted")]),
    );
    expect(discardRevision(key, 2, root).revision).toBe(1);
  });

  it("clears the revision's archived-skip note and its last run's record", () => {
    seedAnalyzedRev1();
    refreshOnto(REV2, "head2");
    updateMeta(key, { analysisPending: { revision: 2, reason: "archived" } }, root);
    fs.writeFileSync(analysisJobPath(key, root), JSON.stringify({ revision: 2, status: "done" }));
    discardRevision(key, 2, root);
    expect(readMeta(key, root).analysisPending).toBeUndefined();
    expect(fs.existsSync(analysisJobPath(key, root))).toBe(false);
  });

  it("keeps a run record and a note that belong to the revision in force", () => {
    seedAnalyzedRev1();
    updateMeta(key, { analysisPending: { revision: 1, reason: "archived" } }, root);
    fs.writeFileSync(analysisJobPath(key, root), JSON.stringify({ revision: 1, status: "done" }));
    refreshOnto(REV2, "head2");
    discardRevision(key, 2, root);
    expect(readMeta(key, root).analysisPending).toEqual({ revision: 1, reason: "archived" });
    expect(fs.existsSync(analysisJobPath(key, root))).toBe(true);
  });
});
