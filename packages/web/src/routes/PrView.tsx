import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import type { MigrationReport, ReviewEvent, SubmitReviewResult, SyncResult } from "../api/types";
import {
  useAddComment,
  useComments,
  useDeleteComment,
  useDiscardPendingReview,
  usePatchUnit,
  usePr,
  useRefresh,
  useReview,
  useSaveReviewBody,
  useSetHunkViewed,
  useSetUnitViewed,
  useSubmitReview,
  useSync,
} from "../api/hooks";
import { AttentionChip, ChangedBadge, KindChip, Progress, RiskFlags } from "../components/Chips";
import { DiffPane, DiffViewToggle, type HunkEntry } from "../components/DiffPane";
import { CommentComposer, DraftsDrawer, type CommentTarget } from "../components/Drafts";
import { FinishReviewPanel } from "../components/FinishReview";
import { FileTree } from "../components/FileTree";
import { MigrationReportPanel, SummaryPanel, SyncResultPanel } from "../components/Panels";
import { TopBar } from "../components/TopBar";
import { UnitSidebar } from "../components/UnitSidebar";
import { hunkIndex, unitProgress } from "../lib/diffModel";
import { useDiffViewMode } from "../lib/useViewMode";

export function PrView() {
  const params = useParams();
  const prKey = decodeURIComponent(params["*"] ?? "");

  const { data: detail, isLoading, error } = usePr(prKey);
  const { data: drafts = [] } = useComments(prKey);

  const setHunkViewed = useSetHunkViewed(prKey);
  const setUnitViewed = useSetUnitViewed(prKey);
  const patchUnit = usePatchUnit(prKey);
  const refresh = useRefresh(prKey);
  const sync = useSync(prKey);
  const addComment = useAddComment(prKey);
  const deleteComment = useDeleteComment(prKey);
  const saveReviewBody = useSaveReviewBody(prKey);
  const submitReview = useSubmitReview(prKey);
  const discardPending = useDiscardPendingReview(prKey);

  const [tab, setTab] = useState<"units" | "files">("units");
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusedHunkId, setFocusedHunkId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitReviewResult | null>(null);
  const [viewMode, setViewMode, toggleViewMode] = useDiffViewMode();

  // Only queried while the panel is open: it makes a live GitHub call.
  const review = useReview(prKey, reviewOpen);

  const units = useMemo(
    () => (detail ? [...detail.state.units].sort((a, b) => a.order - b.order) : []),
    [detail],
  );

  useEffect(() => {
    if (!detail) return;
    setSelectedUnitId((cur) => cur ?? units[0]?.id ?? null);
    setSelectedPath((cur) => cur ?? detail.files.files[0]?.path ?? null);
  }, [detail, units]);

  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;

  const entries = useMemo<HunkEntry[]>(() => {
    if (!detail) return [];
    if (tab === "units") {
      if (!selectedUnit) return [];
      const index = hunkIndex(detail.files);
      const out: HunkEntry[] = [];
      for (const id of selectedUnit.hunkIds) {
        const e = index.get(id);
        if (e) out.push({ hunk: e.hunk, file: e.file });
      }
      return out;
    }
    const file = detail.files.files.find((f) => f.path === selectedPath);
    return file ? file.hunks.map((h) => ({ hunk: h, file })) : [];
  }, [detail, tab, selectedUnit, selectedPath]);

  // Keep the focused hunk inside the currently shown set.
  useEffect(() => {
    setFocusedHunkId((cur) =>
      cur && entries.some((e) => e.hunk.id === cur) ? cur : (entries[0]?.hunk.id ?? null),
    );
  }, [entries]);

  if (isLoading) {
    return <Centered>Loading {prKey}…</Centered>;
  }
  if (error || !detail) {
    return (
      <Centered>
        <div style={{ color: "var(--risk)" }}>{(error as Error)?.message ?? "PR not found"}</div>
      </Centered>
    );
  }

  const progress = selectedUnit ? unitProgress(detail, selectedUnit) : null;
  const unsubmittedDrafts = drafts.filter((d) => d.status !== "submitted");

  const jumpToFile = (file: string) => {
    setTab("files");
    setSelectedPath(file);
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar
        detail={detail}
        draftCount={unsubmittedDrafts.length}
        pendingReview={review.data?.pending.exists}
        refreshing={refresh.isPending}
        syncing={sync.isPending}
        summaryOpen={summaryOpen}
        onToggleSummary={() => setSummaryOpen((v) => !v)}
        onToggleDrafts={() => setDraftsOpen((v) => !v)}
        onFinishReview={() => {
          setSubmitResult(null);
          submitReview.reset();
          setReviewOpen((v) => !v);
        }}
        onRefresh={() => refresh.mutate(undefined, { onSuccess: setReport })}
        onSync={() => sync.mutate(undefined, { onSuccess: setSyncResult })}
      />

      {refresh.error ? (
        <ErrorBar message={`refresh failed: ${(refresh.error as Error).message}`} />
      ) : null}
      {sync.error ? <ErrorBar message={`sync failed: ${(sync.error as Error).message}`} /> : null}
      {report ? <MigrationReportPanel report={report} onDismiss={() => setReport(null)} /> : null}
      {syncResult ? (
        <SyncResultPanel result={syncResult} onDismiss={() => setSyncResult(null)} />
      ) : null}
      {summaryOpen ? <SummaryPanel summary={detail.state.summary} /> : null}

      <div className="flex min-h-0 flex-1">
        <nav
          className="flex w-[19rem] flex-none flex-col border-r"
          style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
        >
          <div className="flex flex-none border-b" style={{ borderColor: "var(--border)" }}>
            {(["units", "files"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="flex-1 border-b-2 px-2 py-1.5 text-2xs uppercase tracking-wider transition-colors"
                style={{
                  borderColor: tab === t ? "var(--accent)" : "transparent",
                  color: tab === t ? "var(--fg)" : "var(--fg-faint)",
                }}
              >
                {t === "units" ? "review units" : "files"}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "units" ? (
              <UnitSidebar
                detail={detail}
                selectedUnitId={selectedUnitId}
                onSelect={setSelectedUnitId}
                onReclassify={(unitId, patch) => patchUnit.mutate({ unitId, patch })}
              />
            ) : (
              <FileTree detail={detail} selectedPath={selectedPath} onSelect={setSelectedPath} />
            )}
          </div>
          <div
            className="flex-none border-t px-2.5 py-1.5 text-2xs leading-4"
            style={{ borderColor: "var(--border)", color: "var(--fg-faint)" }}
          >
            <kbd>j</kbd>/<kbd>k</kbd> hunk · <kbd>v</kbd> viewed · <kbd>space</kbd> next unviewed ·{" "}
            <kbd>d</kbd> {viewMode === "split" ? "unified" : "split"}
          </div>
        </nav>

        <main className="relative flex min-w-0 flex-1 flex-col">
          {tab === "units" && selectedUnit ? (
            <div
              className="flex-none border-b px-4 py-2.5"
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
            >
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[13px] font-semibold">{selectedUnit.title}</h2>
                <KindChip kind={selectedUnit.kind} />
                <AttentionChip attention={selectedUnit.attention} />
                <RiskFlags flags={selectedUnit.riskFlags} />
                {progress && progress.changed > 0 ? <ChangedBadge count={progress.changed} /> : null}
                <div className="ml-auto flex flex-none items-center gap-2">
                  <DiffViewToggle mode={viewMode} onChange={setViewMode} />
                  {progress ? <Progress viewed={progress.viewed} total={progress.total} /> : null}
                  <button
                    type="button"
                    className="btn"
                    disabled={setUnitViewed.isPending || (progress?.viewed ?? 0) === (progress?.total ?? 0)}
                    onClick={() => setUnitViewed.mutate(selectedUnit.id)}
                  >
                    mark unit viewed
                  </button>
                </div>
              </div>
              <p className="mt-1 max-w-4xl text-xs leading-5" style={{ color: "var(--fg-muted)" }}>
                {selectedUnit.summary}
              </p>
              {selectedUnit.attentionWhy ? (
                <p className="mt-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                  why {selectedUnit.attention}: {selectedUnit.attentionWhy}
                </p>
              ) : null}
            </div>
          ) : null}

          {tab === "files" && selectedPath ? (
            <div
              className="flex flex-none items-center gap-2 border-b px-4 py-2 font-mono text-xs"
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
            >
              <span className="truncate">{selectedPath}</span>
              {detail.state.files?.[selectedPath] ? (
                <span className="flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {detail.state.files[selectedPath].viewedHunks}/
                  {detail.state.files[selectedPath].totalHunks} hunks viewed
                  {detail.state.files[selectedPath].viewed ? " · synced when you press sync" : ""}
                </span>
              ) : null}
              <div className="ml-auto">
                <DiffViewToggle mode={viewMode} onChange={setViewMode} />
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            <DiffPane
              detail={detail}
              entries={entries}
              drafts={drafts}
              focusedHunkId={focusedHunkId}
              onFocusHunk={setFocusedHunkId}
              onToggleViewed={(hunkId, viewed) => setHunkViewed.mutate({ hunkId, viewed })}
              onComment={(t) => setCommentTarget(t)}
              viewMode={viewMode}
              onToggleViewMode={toggleViewMode}
              emptyMessage={
                tab === "units"
                  ? "Select a review unit to read its hunks."
                  : "Select a file to read its diff."
              }
            />
          </div>

          {commentTarget ? (
            <CommentComposer
              target={commentTarget}
              pending={addComment.isPending}
              onCancel={() => setCommentTarget(null)}
              onSubmit={(body) =>
                addComment.mutate(
                  { ...commentTarget, body },
                  { onSuccess: () => setCommentTarget(null) },
                )
              }
            />
          ) : null}
        </main>

        {draftsOpen ? (
          <DraftsDrawer
            drafts={drafts}
            deleting={deleteComment.isPending}
            onClose={() => setDraftsOpen(false)}
            onJump={(d) => jumpToFile(d.file)}
            onDelete={(d) => deleteComment.mutate(d.id)}
          />
        ) : null}

        {reviewOpen ? (
          <FinishReviewPanel
            review={review.data}
            loading={review.isLoading}
            error={review.error as Error | null}
            submitting={submitReview.isPending}
            discarding={discardPending.isPending}
            result={submitResult}
            submitError={submitReview.error as Error | null}
            onClose={() => setReviewOpen(false)}
            onSaveBody={(body) => saveReviewBody.mutate(body)}
            onSubmit={(event: ReviewEvent, body: string) =>
              submitReview.mutate({ event, body }, { onSuccess: setSubmitResult })
            }
            onDiscardPending={() => discardPending.mutate()}
            onJumpToComment={(file) => jumpToFile(file)}
          />
        ) : null}
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm" style={{ color: "var(--fg-muted)" }}>
      {children}
    </div>
  );
}

function ErrorBar({ message }: { message: string }) {
  return (
    <div
      className="flex-none border-b px-3 py-1.5 text-xs"
      style={{ background: "var(--risk-soft)", color: "var(--risk)", borderColor: "var(--border)" }}
    >
      {message}
    </div>
  );
}
