import { useEffect, useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { api } from "./client";
import { applyArchive } from "../lib/prList";
import type {
  AnalysisJob,
  DiffOfDiffs,
  DiscardPendingResult,
  DraftComment,
  EditCommentResult,
  GlobalConfig,
  GlobalConfigPatch,
  MigrationReport,
  PrDetail,
  PrListEntry,
  RepoConfig,
  RepoConfigPatch,
  RepoSummary,
  ReviewEvent,
  ReviewStatus,
  ReviewUnit,
  SubmitReviewResult,
  SyncResult,
} from "./types";

export const qk = {
  prs: ["prs"] as const,
  repos: ["repos"] as const,
  repoConfig: (rkey: string) => ["repo-config", rkey] as const,
  config: ["config"] as const,
  pr: (key: string) => ["pr", key] as const,
  comments: (key: string) => ["comments", key] as const,
  review: (key: string) => ["review", key] as const,
  analysisJob: (key: string) => ["analysis-job", key] as const,
  diffOfDiffs: (key: string, hunkId: string) => ["dod", key, hunkId] as const,
};

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
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.prs });
      void qc.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

/* ------------------------------------------------------------------ repos */

export function useRepos() {
  return useQuery<RepoSummary[]>({ queryKey: qk.repos, queryFn: api.listRepos });
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
    },
  });
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
    mutationFn: (input: { file: string; line: number; side: "LEFT" | "RIGHT"; body: string }) =>
      api.addComment(key, input),
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
