import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ChatRef,
  MigrationReport,
  PrDetail,
  ReviewEvent,
  SubmitReviewResult,
  SyncResult,
} from "../api/types";
import { isJobLive } from "../api/types";
import {
  qk,
  useAddComment,
  useAnalysisEvents,
  useAnalysisJob,
  useCancelAnalysis,
  useStartAnalysis,
  useComments,
  useDeleteComment,
  useEditComment,
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
import { AnalysisBanner } from "../components/Analysis";
import { ChatPanel } from "../components/ChatPanel";
import { AttentionChip, ChangedBadge, KindChip, Progress, RiskFlags } from "../components/Chips";
import {
  DiffPane,
  DiffViewToggle,
  NarrowPaneNote,
  WrapToggle,
  type HunkEntry,
} from "../components/DiffPane";
import { CommentComposer, DraftsDrawer, type CommentTarget } from "../components/Drafts";
import { UnitFindings } from "../components/Findings";
import { FinishReviewPanel } from "../components/FinishReview";
import { FileTree } from "../components/FileTree";
import { MigrationReportPanel, SyncResultPanel } from "../components/Panels";
import { SummaryStrip } from "../components/SummaryStrip";
import { TopBar } from "../components/TopBar";
import { UnitSidebar } from "../components/UnitSidebar";
import { DiffSearchBar } from "../components/DiffSearchBar";
import { hunkIndex, sortUnitsForDisplay, unitProgress } from "../lib/diffModel";
import { repoLabel } from "../lib/agentExport";
import { unitForHunk } from "../lib/diffSearch";
import { useDiffSearch } from "../lib/useDiffSearch";
import { MiddleTruncate } from "../components/Truncate";
import { useChatFor } from "../lib/chat";
import { useDiffViewPrefs } from "../lib/settings";

export function PrView() {
  const params = useParams();
  const prKey = decodeURIComponent(params["*"] ?? "");

  const { data: detail, isLoading, error } = usePr(prKey);
  const { data: drafts = [] } = useComments(prKey);
  const qc = useQueryClient();

  const setHunkViewed = useSetHunkViewed(prKey);
  const setUnitViewed = useSetUnitViewed(prKey);
  const patchUnit = usePatchUnit(prKey);
  const refresh = useRefresh(prKey);
  const sync = useSync(prKey);
  const addComment = useAddComment(prKey);
  const deleteComment = useDeleteComment(prKey);
  const editComment = useEditComment(prKey);
  const saveReviewBody = useSaveReviewBody(prKey);
  const submitReview = useSubmitReview(prKey);
  const discardPending = useDiscardPendingReview(prKey);
  const startAnalysis = useStartAnalysis(prKey);
  const cancelAnalysis = useCancelAnalysis(prKey);

  // The event stream is what makes the banner live; the query is its seed and
  // its fallback.
  useAnalysisEvents(prKey);
  const analysisJob = useAnalysisJob(prKey);
  const chat = useChatFor(prKey);

  const [tab, setTab] = useState<"units" | "files">("units");
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusedHunkId, setFocusedHunkId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitReviewResult | null>(null);
  const { viewMode, setViewMode, toggleViewMode, wrap, setWrap, toggleWrap } = useDiffViewPrefs();
  const [narrow, setNarrow] = useState(false);
  const showNarrowNote = narrow && viewMode === "split";

  // Only queried while the panel is open: it makes a live GitHub call.
  const review = useReview(prKey, reviewOpen);

  // Both live in the same right-hand slot, and the chat is the one the reader
  // just asked for, so it wins.
  useEffect(() => {
    if (chat.open) setReviewOpen(false);
  }, [chat.open]);

  const units = useMemo(
    () => (detail ? [...detail.state.units].sort((a, b) => a.order - b.order) : []),
    [detail],
  );

  // Whether every unit in the PR is fully viewed — drives the quiet "all units
  // viewed" indicator next to the units-tab "mark unit viewed" button.
  const allUnitsViewed = useMemo(() => {
    if (!detail || units.length === 0) return false;
    return units.every((u) => {
      const p = unitProgress(detail, u);
      return p.total === 0 || p.viewed === p.total;
    });
  }, [detail, units]);

  // After marking a unit viewed (units tab only), advance to the next unit
  // that still has unviewed hunks, in the sidebar's reading order
  // (must-read → skim → skip, each by `order`), wrapping around the top.
  // Reads the query cache directly rather than the render's `detail` closure
  // so it sees the optimistic update the mutation just applied.
  const advanceAfterUnitViewed = useCallback(
    (viewedUnitId: string) => {
      const latest = qc.getQueryData<PrDetail>(qk.pr(prKey));
      if (!latest) return;
      const ordered = sortUnitsForDisplay(latest.state.units);
      const idx = ordered.findIndex((u) => u.id === viewedUnitId);
      if (idx === -1 || ordered.length === 0) return;
      for (let i = 1; i <= ordered.length; i++) {
        const candidate = ordered[(idx + i) % ordered.length];
        const p = unitProgress(latest, candidate);
        if (p.total > 0 && p.viewed < p.total) {
          setSelectedUnitId(candidate.id);
          return;
        }
      }
      // No unviewed unit remains anywhere — stay put; `allUnitsViewed` picks
      // this up reactively and shows the quiet indicator.
    },
    [qc, prKey],
  );

  // Whole-PR reading progress, shown quietly on the summary strip.
  const overall = useMemo(() => {
    let viewed = 0;
    let total = 0;
    for (const file of detail?.files.files ?? []) {
      for (const hunk of file.hunks) {
        total++;
        if (detail?.state.hunks[hunk.id]?.viewed) viewed++;
      }
    }
    return { viewed, total };
  }, [detail]);

  const search = useDiffSearch(detail, units);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const openSearch = useCallback(() => {
    search.openSearch();
    // Opening while already open means "start over": select what is there.
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [search]);

  // `c` toggles the chat, `s` the summary overlay, `/` opens the find bar — all
  // single-letter, all suppressed while typing. Cmd/Ctrl+F is taken over from the browser on
  // purpose: rows are virtualized, so native find can only see what is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = Boolean(
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable),
      );
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") {
        e.preventDefault();
        chat.toggleChat();
      } else if (e.key === "s") {
        e.preventDefault();
        setSummaryOpen((v) => !v);
      } else if (e.key === "/") {
        e.preventDefault();
        openSearch();
      } else if (e.key === "Escape" && search.open) {
        e.preventDefault();
        search.close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat, openSearch, search.open, search.close]);

  useEffect(() => {
    if (!detail) return;
    setSelectedUnitId((cur) => cur ?? units[0]?.id ?? null);
    setSelectedPath((cur) => cur ?? detail.files.files[0]?.path ?? null);
  }, [detail, units]);

  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;

  // The composer's auto-attach chip follows whatever unit is in context; the
  // files tab has no such concept, so it sees null and shows nothing.
  const { setUnitContext } = chat;
  useEffect(() => {
    setUnitContext(tab === "units" ? selectedUnitId : null);
  }, [setUnitContext, tab, selectedUnitId]);

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

  // Visiting a search match may mean leaving the unit or file on screen. Only
  // a *change* of match moves the reader, so browsing the sidebar afterwards is
  // not undone by this effect re-running.
  const visited = useRef<string | null>(null);
  useEffect(() => {
    const m = search.current;
    if (!m) {
      visited.current = null;
      return;
    }
    const key = `${search.index}:${m.hunkId}:${m.lineIdx}:${m.start}`;
    if (key === visited.current) return;
    visited.current = key;
    if (tab === "units") {
      const unit = unitForHunk(units, m.hunkId);
      if (unit) {
        if (unit.id !== selectedUnitId) setSelectedUnitId(unit.id);
        return;
      }
      // A hunk no unit claims is only reachable through the files tab.
      setTab("files");
      setSelectedPath(m.path);
      return;
    }
    if (m.path !== selectedPath) setSelectedPath(m.path);
  }, [search.current, search.index, tab, units, selectedUnitId, selectedPath]);

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

  const summary = detail.state.summary?.trim() ?? "";
  const progress = selectedUnit ? unitProgress(detail, selectedUnit) : null;
  const unsubmittedDrafts = drafts.filter((d) => d.status !== "submitted");

  const job = analysisJob.data ?? detail.analysisJob ?? null;
  const analysisPending = isJobLive(job);
  // The banner is for the "nothing to read yet" case: once units exist, the
  // job's state lives in the top bar chip and the overflow menu instead.
  const showAnalysisBanner = units.length === 0 || analysisPending;
  const quote = (ref: ChatRef) => chat.attachRef(ref);

  // Everything the agent-facing markdown needs: the diff to slice snippets
  // out of, and the PR identity for the bundle heading.
  const exportCtx = { files: detail.files, diff: detail.diff };
  const bundle = {
    ctx: exportCtx,
    repoLabel: repoLabel(detail.meta),
    revision: detail.state.revision,
  };

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
        chatOpen={chat.open}
        analysisJob={job}
        analysisStarting={startAnalysis.isPending}
        analysisCancelling={cancelAnalysis.isPending}
        onToggleDrafts={() => setDraftsOpen((v) => !v)}
        onToggleChat={chat.toggleChat}
        onAnalyze={() => startAnalysis.mutate()}
        onCancelAnalysis={() => cancelAnalysis.mutate()}
        onFinishReview={() => {
          setSubmitResult(null);
          submitReview.reset();
          const next = !reviewOpen;
          setReviewOpen(next);
          // Both live in the same right-hand slot: whichever was requested
          // last wins, so opening finish-review closes the chat.
          if (next) chat.closeChat();
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
      {showAnalysisBanner ? (
        <AnalysisBanner
          job={job}
          starting={startAnalysis.isPending}
          cancelling={cancelAnalysis.isPending}
          error={
            (startAnalysis.error as Error | null)?.message ??
            (cancelAnalysis.error as Error | null)?.message ??
            null
          }
          onAnalyze={() => startAnalysis.mutate()}
          onCancel={() => cancelAnalysis.mutate()}
        />
      ) : null}
      {summary ? (
        <SummaryStrip
          summary={summary}
          revision={detail.state.revision}
          viewed={overall.viewed}
          total={overall.total}
          open={summaryOpen}
          onToggle={() => setSummaryOpen((v) => !v)}
          onClose={() => setSummaryOpen(false)}
        />
      ) : null}

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
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {tab === "units" ? (
              <UnitSidebar
                detail={detail}
                selectedUnitId={selectedUnitId}
                onSelect={setSelectedUnitId}
                onReclassify={(unitId, patch) => patchUnit.mutate({ unitId, patch })}
                onQuote={quote}
                matchCounts={search.unitCounts}
              />
            ) : (
              <FileTree
                detail={detail}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                onQuote={quote}
                matchCounts={search.fileCounts}
              />
            )}
          </div>
          <div
            className="flex-none border-t px-2.5 py-1.5 text-2xs leading-4"
            style={{ borderColor: "var(--border)", color: "var(--fg-faint)" }}
          >
            <div>
              <kbd>j</kbd>/<kbd>k</kbd> hunk · <kbd>v</kbd> viewed · <kbd>space</kbd> next unviewed
            </div>
            <div>
              <kbd>d</kbd> {viewMode === "split" ? "unified" : "split"} · <kbd>w</kbd>{" "}
              {wrap ? "no wrap" : "wrap"} · <kbd>c</kbd> chat · <kbd>s</kbd> summary · <kbd>/</kbd> search
            </div>
          </div>
        </nav>

        <main className="relative flex min-w-0 flex-1 flex-col">
          {tab === "units" && selectedUnit ? (
            <div
              className="flex-none border-b px-4 py-2.5"
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  className="line-clamp-2 min-w-0 flex-1 basis-64 text-[13px] font-semibold leading-tight"
                  title={selectedUnit.title}
                >
                  {selectedUnit.title}
                </h2>
                <div className="flex flex-none flex-wrap items-center gap-2">
                  <KindChip kind={selectedUnit.kind} />
                  <AttentionChip attention={selectedUnit.attention} />
                  <RiskFlags flags={selectedUnit.riskFlags} />
                  {progress && progress.changed > 0 ? <ChangedBadge count={progress.changed} /> : null}
                </div>
                <div className="ml-auto flex flex-none flex-wrap items-center gap-2">
                  {showNarrowNote ? <NarrowPaneNote /> : null}
                  <DiffViewToggle mode={viewMode} onChange={setViewMode} />
                  <WrapToggle wrap={wrap} onChange={setWrap} />
                  {progress ? <Progress viewed={progress.viewed} total={progress.total} /> : null}
                  <button
                    type="button"
                    className="btn"
                    disabled={setUnitViewed.isPending || (progress?.viewed ?? 0) === (progress?.total ?? 0)}
                    onClick={() =>
                      setUnitViewed.mutate(selectedUnit.id, {
                        onSuccess: () => advanceAfterUnitViewed(selectedUnit.id),
                      })
                    }
                  >
                    mark unit viewed
                  </button>
                  {allUnitsViewed ? (
                    <span
                      className="text-2xs"
                      data-testid="all-units-viewed"
                      style={{ color: "var(--fg-faint)" }}
                    >
                      all units viewed
                    </span>
                  ) : null}
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
              <UnitFindings findings={selectedUnit.findings} />
            </div>
          ) : null}

          {tab === "files" && selectedPath ? (
            <div
              className="flex flex-none items-center gap-2 border-b px-4 py-2 font-mono text-xs"
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
            >
              <MiddleTruncate text={selectedPath} tail={20} />
              {detail.state.files?.[selectedPath] ? (
                <span className="flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {detail.state.files[selectedPath].viewedHunks}/
                  {detail.state.files[selectedPath].totalHunks} hunks viewed
                  {detail.state.files[selectedPath].viewed ? " · synced when you press sync" : ""}
                </span>
              ) : null}
              <div className="ml-auto flex flex-none items-center gap-2">
                {showNarrowNote ? <NarrowPaneNote /> : null}
                <DiffViewToggle mode={viewMode} onChange={setViewMode} />
                <WrapToggle wrap={wrap} onChange={setWrap} />
              </div>
            </div>
          ) : null}

          {search.open ? <DiffSearchBar search={search} inputRef={searchInputRef} /> : null}

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
              wrap={wrap}
              onToggleWrap={toggleWrap}
              onNarrowChange={setNarrow}
              onQuote={quote}
              searchMarks={search.marksByLine}
              activeMatch={search.current}
              showFileRows={tab === "units"}
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
              exportCtx={exportCtx}
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
            bundle={bundle}
            onClose={() => setDraftsOpen(false)}
            onJump={(d) => jumpToFile(d.file)}
            onDelete={(d) => deleteComment.mutate(d.id)}
            onEdit={(input) => editComment.mutateAsync(input)}
            onQuote={quote}
          />
        ) : null}

        {chat.open ? <ChatPanel prKey={prKey} detail={detail} comments={drafts} /> : null}

        {reviewOpen && !chat.open ? (
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
            onEditComment={(input) => editComment.mutateAsync(input)}
            bundle={bundle}
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
