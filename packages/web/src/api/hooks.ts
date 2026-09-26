import { useEffect, useRef } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { api } from "./client";
import { applyArchive, applyRepoArchive } from "../lib/prList";
import { stalenessPollInterval } from "../lib/staleness";
import type {
  AnalysisImportReport,
  AnalysisJob,
  DiffOfDiffs,
  RevisionLineChanges,
  DiscardPendingResult,
  DiscardRevisionResult,
  AddCommentInput,
  DeletedComment,
  DraftComment,
  EditCommentResult,
  GlobalConfig,
  GlobalConfigPatch,
  ImportFromPrResult,
  ImportReviewsResult,
  LanAccess,
  MigrationReport,
  PrDetail,
  PrListEntry,
  ReanchorResult,
  RepoConfig,
  RepoConfigPatch,
  PrGithubState,
  RepoRemovalSummary,
  RepoSummary,
  ReviewEvent,
  ReviewStatus,
  ReviewUnit,
  ShareAnalysisResult,
  SharedAnalysisProbe,
  Staleness,
  SubmitReviewResult,
  SyncResult,
} from "./types";

export const qk = {
  prs: ["prs"] as const,
  repos: ["repos"] as const,
  repoConfig: (rkey: string) => ["repo-config", rkey] as const,
  repoRemoval: (rkey: string) => ["repo-removal", rkey] as const,
  config: ["config"] as const,
  lan: ["lan"] as const,
  pr: (key: string) => ["pr", key] as const,
  comments: (key: string) => ["comments", key] as const,
  /** under qk.comments, so every comments invalidation refreshes the trash too */
  deletedComments: (key: string) => ["comments", key, "deleted"] as const,
  review: (key: string) => ["review", key] as const,
  analysisJob: (key: string) => ["analysis-job", key] as const,
  staleness: (key: string) => ["staleness", key] as const,
  diffOfDiffs: (key: string, hunkId: string) => ["dod", key, hunkId] as const,
  lineChanges: (key: string, n: number, currentRevision: number) =>
    ["line-changes", key, n, currentRevision] as const,
};

/**
 * The lines each highlighted revision changed (for the changelog highlight):
 * one query per revision, so adding or dropping one refetches nothing else.
 * Keyed on the current revision too: the forward mapping moves only when the
 * PR does. `data` waits for every revision; `failed` names the first that
 * didn't load.
 */
export function useRevisionsLineChanges(key: string, revisions: readonly number[], currentRevision: number) {
  return useQueries({
    queries: revisions.map((revision) => ({
      queryKey: qk.lineChanges(key, revision, currentRevision),
      queryFn: () => api.revisionLineChanges(key, revision),
      enabled: Boolean(key),
      staleTime: Infinity,
      retry: false,
    })),
    // Structurally shared by the observer, so an unchanged set keeps its identity.
    combine: (results) => {
      const at = results.findIndex((r) => r.error);
      const failed = at === -1 ? null : { revision: revisions[at], error: results[at].error as Error };
      const loaded = results.every((r, i) => r.data?.revision === revisions[i]);
      return {
        data: loaded && results.length > 0 ? results.map((r) => r.data as RevisionLineChanges) : null,
        failed,
      };
    },
  });
}

/**
 * Fetched lazily, only when the reader expands a changed hunk's badge: the
 * payload is per-hunk and the server computes it on demand.
 */
export function useDiffOfDiffs(key: string, hunkId: string | null) {
  return useQuery<DiffOfDiffs>({
    queryKey: qk.diffOfDiffs(key, hunkId ?? ""),
    queryFn: () => api.diffOfDiffs(key, hunkId!),
    enabled: Boolean(key && hunkId),
    staleTime: Infinity,
    retry: false,
  });
}

export function usePrs() {
  return useQuery<PrListEntry[]>({
    queryKey: qk.prs,
    queryFn: api.listPrs,
    // The list has no event stream of its own; a slow poll keeps the analysis
    // chips honest, and only while something is actually running.
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (p) => p.analysisJob?.status === "queued" || p.analysisJob?.status === "running",
      )
        ? 3000
        : false,
  });
}

export function useAddPr() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.addPr(url),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.prs }),
  });
}

/**
 * Archiving is local-only and instantaneous in the UI: the row jumps into (or
 * out of) the repo group's disclosure before the request lands, and rolls back
 * if the server refuses.
 */
export function useSetArchived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, archived }: { key: string; archived: boolean }) =>
      api.setArchived(key, archived),
    onMutate: async ({ key, archived }) => {
      await qc.cancelQueries({ queryKey: qk.prs });
      const previous = qc.getQueryData<PrListEntry[]>(qk.prs);
      if (previous) qc.setQueryData(qk.prs, applyArchive(previous, key, archived));
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.prs, ctx.previous);
    },
    onSettled: (_d, _e, { key }) => {
      void qc.invalidateQueries({ queryKey: qk.prs });
      void qc.invalidateQueries({ queryKey: qk.repos });
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
    },
  });
}

/* ------------------------------------------------------------------ repos */

export function useRepos() {
  return useQuery<RepoSummary[]>({ queryKey: qk.repos, queryFn: api.listRepos });
}

/**
 * Archive or unarchive a whole repo — optimistic like a PR's archive: the
 * group moves into (or out of) "archived repos" before the request lands.
 */
export function useSetRepoArchived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rkey, archived }: { rkey: string; archived: boolean }) =>
      api.setRepoArchived(rkey, archived),
    onMutate: async ({ rkey, archived }) => {
      await qc.cancelQueries({ queryKey: qk.prs });
      await qc.cancelQueries({ queryKey: qk.repos });
      const previous = qc.getQueryData<PrListEntry[]>(qk.prs);
      const previousRepos = qc.getQueryData<RepoSummary[]>(qk.repos);
      if (previous) qc.setQueryData(qk.prs, applyRepoArchive(previous, rkey, archived));
      if (previousRepos) {
        qc.setQueryData(
          qk.repos,
          previousRepos.map((r) =>
            `${r.host}/${r.owner}/${r.repo}` === rkey ? { ...r, archived } : r,
          ),
        );
      }
      return { previous, previousRepos };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.prs, ctx.previous);
      if (ctx?.previousRepos) qc.setQueryData(qk.repos, ctx.previousRepos);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.prs });
      void qc.invalidateQueries({ queryKey: qk.repos });
      // Any open PR of the repo: its header chip reads the repo flag.
      void qc.invalidateQueries({ queryKey: ["pr"] });
    },
  });
}

/** What removing a repo would lose. Fetched only while the confirm is open. */
export function useRepoRemoval(rkey: string, enabled: boolean) {
  return useQuery<RepoRemovalSummary>({
    queryKey: qk.repoRemoval(rkey),
    queryFn: () => api.repoRemoval(rkey),
    enabled: Boolean(rkey) && enabled,
    staleTime: 0,
    retry: false,
  });
}

/** Delete all local state for a repo. Not optimistic: it is destructive. */
export function useRemoveRepo(rkey: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: () => api.removeRepo(rkey),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.repoConfig(rkey) });
      qc.removeQueries({ queryKey: qk.repoRemoval(rkey) });
      void qc.invalidateQueries({ queryKey: qk.prs });
      void qc.invalidateQueries({ queryKey: qk.repos });
    },
    // A refusal (busy) may be stale by now: re-read what blocks it.
    onError: () => void qc.invalidateQueries({ queryKey: qk.repoRemoval(rkey) }),
  });
}

export function useRepoConfig(rkey: string) {
  return useQuery<RepoConfig>({
    queryKey: qk.repoConfig(rkey),
    queryFn: () => api.getRepoConfig(rkey),
    enabled: Boolean(rkey),
    retry: false,
  });
}

/**
 * A partial PUT. The server answers with the whole (re-layered) config, so the
 * response seeds the cache directly instead of triggering a refetch.
 */
export function useSaveRepoConfig(rkey: string) {
  const qc = useQueryClient();
  return useMutation<RepoConfig, Error, RepoConfigPatch>({
    mutationFn: (patch) => api.saveRepoConfig(rkey, patch),
    onSuccess: (config) => {
      qc.setQueryData(qk.repoConfig(rkey), config);
      void qc.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

/**
 * Bulk-import review-requested PRs for a repo. Invalidates the PR list (new
 * rows appear) and the repo list (prCount/archivedCount move).
 */
export function useImportReviews(
  rkey: string,
): UseMutationResult<ImportReviewsResult, Error, number> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api.importReviews(rkey, days),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.prs });
      void qc.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

/* ----------------------------------------------------------- global config */

export function useGlobalConfig() {
  return useQuery<GlobalConfig>({ queryKey: qk.config, queryFn: api.getConfig, retry: false });
}

/**
 * Writing the machine-wide defaults moves what every repo inherits, so the
 * per-repo configs are invalidated along with this one.
 */
export function useSaveGlobalConfig() {
  const qc = useQueryClient();
  return useMutation<GlobalConfig, Error, GlobalConfigPatch>({
    mutationFn: (patch) => api.saveConfig(patch),
    onSuccess: (config) => {
      qc.setQueryData(qk.config, config);
      void qc.invalidateQueries({ queryKey: ["repo-config"] });
    },
  });
}

/* ------------------------------------------------------------- LAN access */

/**
 * The QR code and the URL behind it. The endpoint is loopback-only, so this
 * 403s when the app is itself being read over the LAN — which is the point:
 * the token cannot be fetched by anything holding it.
 */
export function useLanAccess() {
  return useQuery<LanAccess>({ queryKey: qk.lan, queryFn: api.getLan, retry: false });
}

/** Answers with the whole payload, so it needs no refetch. */
export function useRegenerateLanToken(): UseMutationResult<LanAccess, Error, void> {
  const qc = useQueryClient();
  return useMutation<LanAccess, Error, void>({
    mutationFn: () => api.regenerateLanToken(),
    onSuccess: (lan) => qc.setQueryData(qk.lan, lan),
  });
}

export function usePr(key: string) {
  return useQuery<PrDetail>({
    queryKey: qk.pr(key),
    queryFn: () => api.getPr(key),
    enabled: Boolean(key),
  });
}

function recomputeRollups(detail: PrDetail): PrDetail {
  const files: NonNullable<PrDetail["state"]["files"]> = {};
  for (const f of detail.files.files) {
    const viewedHunks = f.hunks.filter((h) => detail.state.hunks[h.id]?.viewed).length;
    files[f.path] = {
      viewed: f.hunks.length > 0 && viewedHunks === f.hunks.length,
      viewedHunks,
      totalHunks: f.hunks.length,
      syncedToGitHub: detail.state.files?.[f.path]?.syncedToGitHub,
    };
  }
  return { ...detail, state: { ...detail.state, files } };
}

/** Optimistic viewed toggle: flip locally, roll back on failure, reconcile on settle. */
export function useSetHunkViewed(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ hunkId, viewed }: { hunkId: string; viewed: boolean }) =>
      api.setHunkViewed(key, hunkId, viewed),
    onMutate: async ({ hunkId, viewed }) => {
      await qc.cancelQueries({ queryKey: qk.pr(key) });
      const previous = qc.getQueryData<PrDetail>(qk.pr(key));
      if (previous) {
        const prevState = previous.state.hunks[hunkId] ?? {
          viewed: false,
          changedSinceViewed: false,
        };
        const next: PrDetail = {
          ...previous,
          state: {
            ...previous.state,
            hunks: {
              ...previous.state.hunks,
              [hunkId]: {
                ...prevState,
                viewed,
                viewedAtRevision: viewed ? previous.state.revision : undefined,
                changedSinceViewed: viewed ? prevState.changedSinceViewed : false,
              },
            },
          },
        };
        qc.setQueryData(qk.pr(key), recomputeRollups(next));
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.pr(key), ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.pr(key) }),
  });
}

/** Optimistic batch toggle for the per-file checkbox; same contract as useSetHunkViewed. */
export function useSetHunksViewed(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ hunkIds, viewed }: { hunkIds: string[]; viewed: boolean }) =>
      api.setHunksViewed(key, hunkIds, viewed),
    onMutate: async ({ hunkIds, viewed }) => {
      await qc.cancelQueries({ queryKey: qk.pr(key) });
      const previous = qc.getQueryData<PrDetail>(qk.pr(key));
      if (previous) {
        const hunks = { ...previous.state.hunks };
        for (const id of hunkIds) {
          const prev = hunks[id] ?? { viewed: false, changedSinceViewed: false };
          hunks[id] = {
            ...prev,
            viewed,
            viewedAtRevision: viewed ? previous.state.revision : undefined,
            changedSinceViewed: viewed ? prev.changedSinceViewed : false,
          };
        }
        qc.setQueryData(qk.pr(key), recomputeRollups({ ...previous, state: { ...previous.state, hunks } }));
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.pr(key), ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.pr(key) }),
  });
}

export function useSetUnitViewed(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (unitId: string) => api.setUnitViewed(key, unitId),
    onMutate: async (unitId) => {
      await qc.cancelQueries({ queryKey: qk.pr(key) });
      const previous = qc.getQueryData<PrDetail>(qk.pr(key));
      if (previous) {
        const unit = previous.state.units.find((u) => u.id === unitId);
        if (unit) {
          const hunks = { ...previous.state.hunks };
          for (const id of unit.hunkIds) {
            hunks[id] = {
              ...(hunks[id] ?? { viewed: false, changedSinceViewed: false }),
              viewed: true,
              viewedAtRevision: previous.state.revision,
            };
          }
          qc.setQueryData(
            qk.pr(key),
            recomputeRollups({ ...previous, state: { ...previous.state, hunks } }),
          );
        }
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.pr(key), ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.pr(key) }),
  });
}

export function usePatchUnit(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ unitId, patch }: { unitId: string; patch: Partial<ReviewUnit> }) =>
      api.patchUnit(key, unitId, patch),
    onMutate: async ({ unitId, patch }) => {
      await qc.cancelQueries({ queryKey: qk.pr(key) });
      const previous = qc.getQueryData<PrDetail>(qk.pr(key));
      if (previous) {
        qc.setQueryData<PrDetail>(qk.pr(key), {
          ...previous,
          state: {
            ...previous.state,
            units: previous.state.units.map((u) => (u.id === unitId ? { ...u, ...patch } : u)),
          },
        });
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.pr(key), ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.pr(key) }),
  });
}

export function useRefresh(key: string): UseMutationResult<MigrationReport, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refresh(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
      void qc.invalidateQueries({ queryKey: qk.prs });
      // A refresh that lands a new revision can auto-queue an analysis; pick
      // that job up right away so the banner goes live without a reload.
      void qc.invalidateQueries({ queryKey: qk.analysisJob(key) });
      // We just fetched upstream, so whatever the check last said is spent.
      void qc.invalidateQueries({ queryKey: qk.staleness(key) });
    },
  });
}

/**
 * Drop the latest revision. Everything derived from it goes stale at once: the
 * PR (state falls back a revision), the list row, the review readiness, the
 * last run's record (removed with the revision) and the staleness answer
 * (it compared GitHub against the discarded head).
 */
export function useDiscardRevision(
  key: string,
): UseMutationResult<DiscardRevisionResult, Error, number> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (revision: number) => api.discardRevision(key, revision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
      void qc.invalidateQueries({ queryKey: qk.prs });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
      void qc.invalidateQueries({ queryKey: qk.analysisJob(key) });
      void qc.invalidateQueries({ queryKey: qk.staleness(key) });
    },
  });
}

/**
 * "Did this PR move upstream?" — checked on mount, whenever the tab becomes
 * visible again, and on a slow interval for PRs that can still grow commits.
 *
 * The server caches the answer for a minute and never fails the request, so
 * the cost of the extra checks is bounded and a broken `gh` stays invisible.
 * React Query pauses `refetchInterval` while the document is hidden, which is
 * exactly the "while visible" the interval is meant to be.
 */
export function useStaleness(key: string, prState?: PrGithubState | null) {
  const query = useQuery<Staleness>({
    queryKey: qk.staleness(key),
    queryFn: () => api.staleness(key),
    enabled: Boolean(key),
    // The window-focus refetch is done by hand below so it keys off
    // visibilitychange only, and never fires twice for one return to the tab.
    refetchOnWindowFocus: false,
    // The PR's lifecycle state usually arrives *in* the answer, so the
    // interval is decided per tick off whatever the last one reported.
    refetchInterval: (query) =>
      stalenessPollInterval(
        prState ?? query.state.data?.upstreamState ?? query.state.data?.localState ?? null,
      ),
    retry: false,
  });

  // A state/review-decision change is already written server-side by the
  // check itself; pull it into the PR view and the list rather than asking
  // for a refresh.
  const qc = useQueryClient();
  const metaUpdatedAt = query.data?.metaUpdated ? query.data.checkedAt : null;
  useEffect(() => {
    if (!key || !metaUpdatedAt) return;
    void qc.invalidateQueries({ queryKey: qk.pr(key) });
    void qc.invalidateQueries({ queryKey: qk.prs });
  }, [key, metaUpdatedAt, qc]);

  const refetch = query.refetch;
  useEffect(() => {
    if (!key) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key, refetch]);

  return query;
}

export function useSync(key: string): UseMutationResult<SyncResult, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.sync(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

export function useComments(key: string) {
  return useQuery<DraftComment[]>({
    queryKey: qk.comments(key),
    queryFn: () => api.listComments(key),
    enabled: Boolean(key),
  });
}

export function useAddComment(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddCommentInput) => api.addComment(key, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

/**
 * Optimistic body edit. The new text lands in the drawer and the finish-review
 * list immediately and is rolled back if the server refuses (empty body, a
 * public comment awaiting confirmation, an unknown id…).
 */
export function useEditComment(
  key: string,
): UseMutationResult<EditCommentResult, Error, { id: string; body: string; confirm?: boolean }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: string; confirm?: boolean }) =>
      api.editComment(key, input),
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: qk.comments(key) });
      await qc.cancelQueries({ queryKey: qk.review(key) });
      const previousComments = qc.getQueryData<DraftComment[]>(qk.comments(key));
      const previousReview = qc.getQueryData<ReviewStatus>(qk.review(key));
      if (previousComments) {
        qc.setQueryData<DraftComment[]>(
          qk.comments(key),
          previousComments.map((c) => (c.id === id ? { ...c, body } : c)),
        );
      }
      if (previousReview) {
        qc.setQueryData<ReviewStatus>(qk.review(key), {
          ...previousReview,
          included: previousReview.included.map((c) => (c.id === id ? { ...c, body } : c)),
        });
      }
      return { previousComments, previousReview };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previousComments) qc.setQueryData(qk.comments(key), ctx.previousComments);
      if (ctx?.previousReview) qc.setQueryData(qk.review(key), ctx.previousReview);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

/** Deleted drafts the server still keeps restorable. */
export function useDeletedComments(key: string) {
  return useQuery<DeletedComment[]>({
    queryKey: qk.deletedComments(key),
    queryFn: () => api.listDeletedComments(key),
    enabled: Boolean(key),
  });
}

export function useRestoreComment(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restoreComment(key, id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

export function useUndoCommentEdit(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.undoCommentEdit(key, id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

export function useDeleteComment(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteComment(key, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

/**
 * Delete several comments ("copy & delete"). There is no bulk route, so it is
 * a few parallel single deletes; every one is attempted, and the first error
 * (if any) is thrown after the lists are refreshed, so a partial failure still
 * shows what is left.
 */
export function useDeleteComments(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteComment(key, id)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length > 0) {
        throw new Error(
          `${failed.length} of ${ids.length} not deleted (${(failed[0].reason as Error)?.message ?? "error"})`,
        );
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

/** Apply the accepted "Suggest new anchor" proposal (or a manual reposition). */
export function useMoveComment(
  key: string,
): UseMutationResult<EditCommentResult, Error, { id: string; line?: number; file?: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; line?: number; file?: string }) =>
      api.moveComment(key, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.review(key) });
    },
  });
}

/**
 * "Suggest new anchor" itself — a read-only proposal, never applied. Not
 * cached: each click is a fresh model run.
 */
export function useProposeReanchor(
  key: string,
): UseMutationResult<ReanchorResult, Error, string> {
  return useMutation({
    mutationFn: (id: string) => api.proposeReanchor(key, id),
  });
}

/* -------------------------------------------------------- review lifecycle */

/**
 * The review status includes a live GitHub lookup for the pending review, so
 * it is deliberately not cached for long: it is opened on demand from the
 * finish-review panel and re-read after anything that can change it.
 */
export function useReview(key: string, enabled = true) {
  return useQuery<ReviewStatus>({
    queryKey: qk.review(key),
    queryFn: () => api.getReview(key),
    enabled: Boolean(key) && enabled,
    staleTime: 5_000,
    retry: false,
  });
}

export function useSaveReviewBody(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.saveReviewBody(key, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.review(key) }),
  });
}

export function useSubmitReview(
  key: string,
): UseMutationResult<SubmitReviewResult, Error, { event: ReviewEvent; body?: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { event: ReviewEvent; body?: string }) => api.submitReview(key, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.review(key) });
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
    },
  });
}

/* ------------------------------------------------------------ analysis job */

/**
 * The job for one PR. `/events` is the live source; this query seeds it and
 * acts as the fallback when the event stream is unavailable (hence the modest
 * polling interval while a job is in flight, and none at all when it is not).
 */
export function useAnalysisJob(key: string) {
  return useQuery<AnalysisJob | null>({
    queryKey: qk.analysisJob(key),
    queryFn: () => api.getAnalysisJob(key),
    enabled: Boolean(key),
    retry: false,
    refetchInterval: (query) => {
      const job = query.state.data;
      return job?.status === "queued" || job?.status === "running" ? 4000 : false;
    },
  });
}

/**
 * Subscribe to job transitions. A job reaching `done` means new analysis
 * landed, so the PR itself (and the list's unit counts) are refetched — that
 * is what makes the units appear on their own.
 */
export function useAnalysisEvents(key: string) {
  const qc = useQueryClient();
  const previous = useRef<AnalysisJob["status"] | null>(null);

  useEffect(() => {
    if (!key) return;
    previous.current = qc.getQueryData<AnalysisJob | null>(qk.analysisJob(key))?.status ?? null;
    const unsubscribe = api.subscribeAnalysis(key, (job) => {
      qc.setQueryData(qk.analysisJob(key), job);
      const was = previous.current;
      previous.current = job.status;
      if (job.status === "done" && was !== "done") {
        void qc.invalidateQueries({ queryKey: qk.pr(key) });
        void qc.invalidateQueries({ queryKey: qk.prs });
      }
    });
    return unsubscribe;
  }, [key, qc]);
}

export function useStartAnalysis(key: string): UseMutationResult<AnalysisJob, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startAnalysis(key),
    onSuccess: (job) => {
      qc.setQueryData(qk.analysisJob(key), job);
      void qc.invalidateQueries({ queryKey: qk.prs });
    },
  });
}

/**
 * The archived-and-skipped banner's one action: take the PR off the shelf,
 * then run the analysis the refresh skipped. Sequential on purpose — if the
 * unarchive fails nothing is spent. The server runs it incrementally on its
 * own, since the PR already has units.
 */
export function useUnarchiveAndAnalyze(key: string): UseMutationResult<AnalysisJob, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.setArchived(key, false);
      return api.startAnalysis(key);
    },
    onSuccess: (job) => qc.setQueryData(qk.analysisJob(key), job),
    // Settled, not success: the unarchive may have landed even if the start
    // then failed, and the view must reflect it either way.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
      void qc.invalidateQueries({ queryKey: qk.prs });
      void qc.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

/** Forget the "archived, so this revision wasn't analyzed" note. */
export function useDismissAnalysisPending(key: string): UseMutationResult<void, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.dismissAnalysisPending(key),
    onMutate: () => {
      const prev = qc.getQueryData<PrDetail>(qk.pr(key));
      if (prev) qc.setQueryData(qk.pr(key), { ...prev, analysisPending: null });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.pr(key) }),
  });
}

export function useCancelAnalysis(key: string): UseMutationResult<AnalysisJob, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelAnalysis(key),
    onSuccess: (job) => {
      qc.setQueryData(qk.analysisJob(key), job);
      void qc.invalidateQueries({ queryKey: qk.prs });
    },
  });
}

/** Downloads the current analysis; the caller turns the blob into a save-as. */
export function useExportAnalysis(
  key: string,
): UseMutationResult<{ filename: string; blob: Blob }, Error, void> {
  return useMutation({ mutationFn: () => api.exportAnalysis(key) });
}

/** Replaces the current analysis with an imported envelope's units. */
export function useImportAnalysis(
  key: string,
): UseMutationResult<AnalysisImportReport, Error, unknown> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (envelope: unknown) => api.importAnalysis(key, envelope),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
      void qc.invalidateQueries({ queryKey: qk.prs });
    },
  });
}

/**
 * Posts (or updates) the canonical analysis comment on the PR itself — a
 * public write, so the caller gates this behind an explicit confirm step.
 */
export function useShareAnalysisToPr(
  key: string,
): UseMutationResult<ShareAnalysisResult, Error, void> {
  return useMutation({ mutationFn: () => api.shareAnalysisToPr(key) });
}

/** Replaces the current analysis with the one shared on the PR itself. */
export function useImportAnalysisFromPr(
  key: string,
): UseMutationResult<ImportFromPrResult, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.importAnalysisFromPr(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.pr(key) });
      void qc.invalidateQueries({ queryKey: qk.prs });
    },
  });
}

/**
 * A one-shot probe for a shared analysis, modeled as a mutation (not a
 * query) on purpose: the PR-view banner fires it exactly once, when it first
 * notices there is no local analysis and no live job, and never polls.
 */
export function useSharedAnalysisProbe(
  key: string,
): UseMutationResult<SharedAnalysisProbe, Error, void> {
  return useMutation({ mutationFn: () => api.getSharedAnalysis(key) });
}

export function useDiscardPendingReview(
  key: string,
): UseMutationResult<DiscardPendingResult, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.discardPendingReview(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.review(key) });
      void qc.invalidateQueries({ queryKey: qk.comments(key) });
    },
  });
}
