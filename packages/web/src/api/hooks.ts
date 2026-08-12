import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { api } from "./client";
import type {
  DraftComment,
  MigrationReport,
  PrDetail,
  PrListEntry,
  ReviewUnit,
  SyncResult,
} from "./types";

export const qk = {
  prs: ["prs"] as const,
  pr: (key: string) => ["pr", key] as const,
  comments: (key: string) => ["comments", key] as const,
};

export function usePrs() {
  return useQuery<PrListEntry[]>({ queryKey: qk.prs, queryFn: api.listPrs });
}

export function useAddPr() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.addPr(url),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.prs }),
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.comments(key) }),
  });
}
