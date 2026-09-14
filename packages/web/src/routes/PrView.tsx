import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AnalysisImportReport,
  ChatRef,
  MigrationReport,
  PrDetail,
  ReviewEvent,
  ShareAnalysisResult,
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
  useExportAnalysis,
  useImportAnalysis,
  useImportAnalysisFromPr,
  useShareAnalysisToPr,
  useSharedAnalysisProbe,
  usePatchUnit,
  usePr,
  useRefresh,
  useReview,
  useSaveReviewBody,
  useSetHunkViewed,
  useSetUnitViewed,
  useStaleness,
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
import {
  CommentComposer,
  DraftsDrawer,
  targetToInput,
  type CommentTarget,
} from "../components/Drafts";
import { CommentBubble, InlineCommentList } from "../components/InlineComments";
import { groupComments } from "../lib/comments";
import { FindingsBadge, UnitFindings } from "../components/Findings";
import { FinishReviewPanel } from "../components/FinishReview";
import { FileTree } from "../components/FileTree";
import { IconChevron } from "../components/icons";
import {
  AnalysisImportConfirmPanel,
  AnalysisImportResultPanel,
  AutoImportedAnalysisPanel,
  ImportFromPrConfirmPanel,
  MigrationReportPanel,
  ShareAnalysisConfirmPanel,
  ShareAnalysisResultPanel,
  SharedAnalysisBanner,
  StalenessHint,
  SyncResultPanel,
} from "../components/Panels";
import { SummaryStrip } from "../components/SummaryStrip";
import { TopBar } from "../components/TopBar";
import { UnitSidebar } from "../components/UnitSidebar";
import { DiffSearchBar } from "../components/DiffSearchBar";
import { hunkIndex, sortUnitsForDisplay, unitProgress } from "../lib/diffModel";
import { repoLabel } from "../lib/agentExport";
import { unitForHunk } from "../lib/diffSearch";
import { useDiffSearch, type SearchScope } from "../lib/useDiffSearch";
import { MiddleTruncate } from "../components/Truncate";
import { useChatFor } from "../lib/chat";
import { useDiffViewPrefs } from "../lib/settings";
import { shouldShowStalenessHint, stalenessDismissKey, stalenessTooltip } from "../lib/staleness";

export function PrView() {
  const params = useParams();
  const prKey = decodeURIComponent(params["*"] ?? "");
  // Handed over by the add flow (PrList) when adding imported a teammate's
  // shared analysis instead of running one — captured once so the notice
  // survives re-renders but not a page reload.
  const location = useLocation();
  const [autoImported, setAutoImported] = useState<{ author?: string; postedAt: string } | null>(
    () => (location.state as { sharedAnalysis?: { author?: string; postedAt: string } } | null)
      ?.sharedAnalysis ?? null,
  );

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
  const exportAnalysis = useExportAnalysis(prKey);
  const importAnalysis = useImportAnalysis(prKey);
  const shareToPr = useShareAnalysisToPr(prKey);
  const importFromPr = useImportAnalysisFromPr(prKey);
  const sharedProbe = useSharedAnalysisProbe(prKey);

  // The event stream is what makes the banner live; the query is its seed and
  // its fallback.
  useAnalysisEvents(prKey);
  const analysisJob = useAnalysisJob(prKey);
  const chat = useChatFor(prKey);

  // Dismissing the hint bar is remembered against the upstream head sha it was
  // raised for, so the bar comes back the next time the PR really moves.
  const [dismissedStaleKey, setDismissedStaleKey] = useState<string | null>(null);
  // The PR's own lifecycle state only reaches us through the check itself, and
  // that is enough: it decides whether the 5-minute interval is worth running
  // (a merged or closed PR grows no commits, so it is mount + focus only).
  const staleness = useStaleness(prKey);
  const stale = staleness.data?.stale === true;
  const showStalenessHint =
    stale && shouldShowStalenessHint(staleness.data, dismissedStaleKey);

  const [tab, setTab] = useState<"units" | "files">("units");
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusedHunkId, setFocusedHunkId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  // The files tab names the file in its own header rather than in the pane, so
  // that header is where its file-level comments live too.
  const [fileCommentsOpen, setFileCommentsOpen] = useState(false);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitReviewResult | null>(null);
  // "import analysis…" is two steps: a file is picked and parsed (armed, not
  // yet sent), then explicitly confirmed — it replaces the current analysis.
  const [pendingImport, setPendingImport] = useState<{ filename: string; envelope: unknown } | null>(
    null,
  );
  const [importParseError, setImportParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<AnalysisImportReport | null>(null);
  // "share analysis to PR" / "import analysis from PR" follow the same
  // confirm-then-act idiom as the file export/import above, just sourced from
  // the PR's own conversation tab.
  const [shareConfirmOpen, setShareConfirmOpen] = useState(false);
  const [shareResult, setShareResult] = useState<ShareAnalysisResult | null>(null);
  const [importFromPrConfirmOpen, setImportFromPrConfirmOpen] = useState(false);
  const [importFromPrResult, setImportFromPrResult] = useState<{
    report: AnalysisImportReport;
    author?: string;
    postedAt: string;
  } | null>(null);
  // Session-local: dismissing the shared-analysis banner is never persisted,
  // so it comes back on the next visit if it is still applicable.
  const [sharedBannerDismissed, setSharedBannerDismissed] = useState(false);
  // The probe fires once per PR, only once it is actually relevant (no local
  // analysis, no live job) — this guards against re-firing on every render.
  const probedForRef = useRef<string | null>(null);
  const { viewMode, setViewMode, toggleViewMode, wrap, setWrap, toggleWrap } = useDiffViewPrefs();
  const [narrow, setNarrow] = useState(false);
  const showNarrowNote = narrow && viewMode === "split";

  // --- header collapse ---------------------------------------------------
  // Once the reader is into the diff, the prose above it has done its job and
  // is only costing rows. `diffScrolled` is the pane's hysteretic report of
  // where it is; `peek` is a manual, temporary override for a reader who wants
  // the prose back without scrolling up. Neither is persisted: this is a
  // property of where you are, not a preference.
  const [diffScrolled, setDiffScrolled] = useState(false);
  const [peek, setPeek] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const onScrolledAway = useCallback((scrolled: boolean) => {
    setDiffScrolled(scrolled);
    setPeek(false);
  }, []);
  const headerCollapsed = diffScrolled && !peek;

  // A peek is a glance, not a mode: the next real scroll ends it. The listener
  // only exists while peeking, and the 8px floor ignores the scroll the
  // re-expansion itself can provoke when the pane is near its bottom.
  useEffect(() => {
    if (!peek) return;
    const el = mainRef.current?.querySelector<HTMLElement>("[data-diff-scroller]");
    if (!el) return;
    const from = el.scrollTop;
    const onScroll = () => {
      if (Math.abs(el.scrollTop - from) > 8) setPeek(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [peek]);

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


  useEffect(() => {
    if (!detail) return;
    setSelectedUnitId((cur) => cur ?? units[0]?.id ?? null);
    setSelectedPath((cur) => cur ?? detail.files.files[0]?.path ?? null);
  }, [detail, units]);

  useEffect(() => {
    setFileCommentsOpen(false);
  }, [selectedPath]);

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

  // What the pane is currently showing — the default (Cmd+F) search scope.
  const visibleHunkIds = useMemo(() => new Set(entries.map((e) => e.hunk.id)), [entries]);

  const search = useDiffSearch(detail, units, visibleHunkIds);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const openSearch = useCallback(
    (scope?: SearchScope) => {
      search.openSearch(scope);
      // Opening while already open means "start over": select what is there.
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    [search],
  );

  // `c` toggles the chat, `s` the summary overlay, `/` opens the find bar — all
  // single-letter, all suppressed while typing. Cmd/Ctrl+F is taken over from the browser on
  // purpose: rows are virtualized, so native find can only see what is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = Boolean(
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable),
      );
      // Cmd+F searches what the pane shows; Cmd+Shift+F widens to the whole diff.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch(e.shiftKey ? "all" : "visible");
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

  // Cost-avoidance probe: when there is nothing local to read yet and nothing
  // is actively being analyzed, check once (no polling) whether a teammate
  // already shared an analysis on the PR itself. Lives ABOVE the early
  // returns below — hooks must run on every render, including the loading
  // ones, so the nullable `detail` is guarded inside rather than by position.
  const probeJob = analysisJob.data ?? detail?.analysisJob ?? null;
  useEffect(() => {
    if (!detail) return;
    if (units.length === 0 && !isJobLive(probeJob) && probedForRef.current !== prKey) {
      probedForRef.current = prKey;
      sharedProbe.mutate();
    }
  }, [detail, units.length, probeJob, prKey, sharedProbe]);

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
  const fileComments = selectedPath ? groupComments(drafts).byFile.get(selectedPath) : undefined;
  const progress = selectedUnit ? unitProgress(detail, selectedUnit) : null;
  const unsubmittedDrafts = drafts.filter((d) => d.status !== "submitted");

  const job = analysisJob.data ?? detail.analysisJob ?? null;
  const analysisPending = isJobLive(job);
  // The banner is for the "nothing to read yet" case: once units exist, the
  // job's state lives in the top bar chip and the overflow menu instead.
  const showAnalysisBanner = units.length === 0 || analysisPending;
  const quote = (ref: ChatRef) => chat.attachRef(ref);

  const noLocalAnalysis = units.length === 0;
  const showSharedAnalysisBanner =
    noLocalAnalysis && !analysisPending && !sharedBannerDismissed && sharedProbe.data?.found === true;

  // Everything the agent-facing markdown needs: the diff to slice snippets
  // out of, and the PR identity for the bundle heading.
  const exportCtx = { files: detail.files, diff: detail.diff };
  const bundle = {
    ctx: exportCtx,
    repoLabel: repoLabel(detail.meta),
    revision: detail.state.revision,
  };

  // Everything an inline comment can do, assembled once: the same handlers the
  // drawer and the finish-review panel already use.
  const commentActions = {
    onEdit: (input: { id: string; body: string; confirm?: boolean }) =>
      editComment.mutateAsync(input),
    onDelete: (c: { id: string }) => deleteComment.mutate(c.id),
    deleting: deleteComment.isPending,
    onQuote: quote,
    exportCtx,
  };

  const jumpToFile = (file: string) => {
    setTab("files");
    setSelectedPath(file);
  };

  const handleExportAnalysis = () => {
    exportAnalysis.mutate(undefined, {
      onSuccess: ({ filename, blob }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      },
    });
  };

  const handleImportFilePicked = async (file: File) => {
    importAnalysis.reset();
    setImportParseError(null);
    try {
      const envelope = JSON.parse(await file.text());
      setPendingImport({ filename: file.name, envelope });
    } catch {
      setPendingImport(null);
      setImportParseError(`"${file.name}" is not valid JSON.`);
    }
  };

  const confirmImportAnalysis = () => {
    if (!pendingImport) return;
    importAnalysis.mutate(pendingImport.envelope, {
      onSuccess: (report) => {
        setPendingImport(null);
        setImportResult(report);
      },
    });
  };

  const handleOpenShareConfirm = () => {
    shareToPr.reset();
    setShareResult(null);
    setShareConfirmOpen(true);
  };

  const confirmShareToPr = () => {
    shareToPr.mutate(undefined, {
      onSuccess: (result) => {
        setShareConfirmOpen(false);
        setShareResult(result);
      },
    });
  };

  const handleOpenImportFromPrConfirm = () => {
    importFromPr.reset();
    setImportFromPrResult(null);
    setImportFromPrConfirmOpen(true);
  };

  const confirmImportFromPr = () => {
    importFromPr.mutate(undefined, {
      onSuccess: ({ report, author, postedAt }) => {
        setImportFromPrConfirmOpen(false);
        setImportFromPrResult({ report, author, postedAt });
        setSharedBannerDismissed(true);
      },
    });
  };

  // The banner only shows when there is no local analysis to lose, so its own
  // "import" button acts directly — no separate confirm step, unlike the
  // overflow menu's "import analysis from PR" (which can replace real work).
  const handleBannerImport = () => {
    importFromPr.mutate(undefined, {
      onSuccess: ({ report, author, postedAt }) => {
        setImportFromPrResult({ report, author, postedAt });
        setSharedBannerDismissed(true);
      },
    });
  };

  const handleBannerAnalyzeFresh = () => {
    setSharedBannerDismissed(true);
    startAnalysis.mutate();
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar
        detail={detail}
        draftCount={unsubmittedDrafts.length}
        pendingReview={review.data?.pending.exists}
        refreshing={refresh.isPending}
        stale={stale}
        staleTooltip={stalenessTooltip(staleness.data)}
        syncing={sync.isPending}
        chatOpen={chat.open}
        analysisJob={job}
        analysisStarting={startAnalysis.isPending}
        analysisCancelling={cancelAnalysis.isPending}
        hasAnalysis={detail.state.units.length > 0}
        exporting={exportAnalysis.isPending}
        sharing={shareToPr.isPending}
        importingFromPr={importFromPr.isPending}
        onToggleDrafts={() => setDraftsOpen((v) => !v)}
        onToggleChat={chat.toggleChat}
        onAnalyze={() => startAnalysis.mutate()}
        onCancelAnalysis={() => cancelAnalysis.mutate()}
        onExportAnalysis={handleExportAnalysis}
        onImportFilePicked={handleImportFilePicked}
        onShareToPr={handleOpenShareConfirm}
        onImportFromPr={handleOpenImportFromPrConfirm}
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

      {showStalenessHint && staleness.data ? (
        <StalenessHint
          result={staleness.data}
          refreshing={refresh.isPending}
          onRefresh={() => refresh.mutate(undefined, { onSuccess: setReport })}
          onDismiss={() => setDismissedStaleKey(stalenessDismissKey(staleness.data))}
        />
      ) : null}
      {refresh.error ? (
        <ErrorBar message={`refresh failed: ${(refresh.error as Error).message}`} />
      ) : null}
      {sync.error ? <ErrorBar message={`sync failed: ${(sync.error as Error).message}`} /> : null}
      {report ? <MigrationReportPanel report={report} onDismiss={() => setReport(null)} /> : null}
      {syncResult ? (
        <SyncResultPanel result={syncResult} onDismiss={() => setSyncResult(null)} />
      ) : null}
      {exportAnalysis.error ? (
        <ErrorBar message={`export failed: ${(exportAnalysis.error as Error).message}`} />
      ) : null}
      {importParseError ? <ErrorBar message={importParseError} /> : null}
      {importAnalysis.error ? (
        <ErrorBar message={`import failed: ${(importAnalysis.error as Error).message}`} />
      ) : null}
      {pendingImport ? (
        <AnalysisImportConfirmPanel
          filename={pendingImport.filename}
          importing={importAnalysis.isPending}
          onConfirm={confirmImportAnalysis}
          onCancel={() => {
            setPendingImport(null);
            importAnalysis.reset();
          }}
        />
      ) : null}
      {importResult ? (
        <AnalysisImportResultPanel report={importResult} onDismiss={() => setImportResult(null)} />
      ) : null}
      {shareToPr.error ? (
        <ErrorBar message={`share failed: ${(shareToPr.error as Error).message}`} />
      ) : null}
      {shareConfirmOpen ? (
        <ShareAnalysisConfirmPanel
          sharing={shareToPr.isPending}
          onConfirm={confirmShareToPr}
          onCancel={() => {
            setShareConfirmOpen(false);
            shareToPr.reset();
          }}
        />
      ) : null}
      {shareResult ? (
        <ShareAnalysisResultPanel result={shareResult} onDismiss={() => setShareResult(null)} />
      ) : null}
      {importFromPr.error ? (
        <ErrorBar message={`import from PR failed: ${(importFromPr.error as Error).message}`} />
      ) : null}
      {importFromPrConfirmOpen ? (
        <ImportFromPrConfirmPanel
          importing={importFromPr.isPending}
          onConfirm={confirmImportFromPr}
          onCancel={() => {
            setImportFromPrConfirmOpen(false);
            importFromPr.reset();
          }}
        />
      ) : null}
      {importFromPrResult ? (
        <AnalysisImportResultPanel
          report={importFromPrResult.report}
          source={{ author: importFromPrResult.author, postedAt: importFromPrResult.postedAt }}
          onDismiss={() => setImportFromPrResult(null)}
        />
      ) : null}
      {autoImported ? (
        <AutoImportedAnalysisPanel
          author={autoImported.author}
          postedAt={autoImported.postedAt}
          onDismiss={() => setAutoImported(null)}
        />
      ) : null}
      {showSharedAnalysisBanner && sharedProbe.data ? (
        <SharedAnalysisBanner
          author={sharedProbe.data.author}
          sameCommit={sharedProbe.data.sameCommit === true}
          importing={importFromPr.isPending}
          onImport={handleBannerImport}
          onAnalyzeFresh={handleBannerAnalyzeFresh}
          onDismiss={() => setSharedBannerDismissed(true)}
        />
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

        <main ref={mainRef} className="relative flex min-w-0 flex-1 flex-col">
          {tab === "units" && selectedUnit ? (
            <div
              data-testid="unit-header"
              data-collapsed={headerCollapsed ? "true" : "false"}
              className={`flex-none border-b px-4 transition-[padding] duration-[140ms] motion-reduce:transition-none ${
                headerCollapsed ? "cursor-pointer py-1" : "py-2.5"
              }`}
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
              // The whole condensed row is the target that brings the prose
              // back — except where a control already owns the click.
              onClick={(e) => {
                if (!headerCollapsed) return;
                if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
                setPeek(true);
              }}
            >
              <div
                className={`flex items-center gap-2 ${
                  headerCollapsed ? "flex-nowrap overflow-hidden" : "flex-wrap"
                }`}
              >
                {diffScrolled ? (
                  <button
                    type="button"
                    data-testid="unit-header-toggle"
                    className="flex-none"
                    style={{ color: "var(--fg-faint)" }}
                    aria-expanded={!headerCollapsed}
                    title={headerCollapsed ? "Show unit details" : "Hide unit details"}
                    onClick={() => setPeek((v) => !v)}
                  >
                    <IconChevron open={!headerCollapsed} width={11} height={11} />
                  </button>
                ) : null}
                <h2
                  className={`min-w-0 flex-1 basis-64 text-[13px] font-semibold leading-tight ${
                    headerCollapsed ? "truncate" : "line-clamp-2"
                  }`}
                  title={selectedUnit.title}
                >
                  {selectedUnit.title}
                </h2>
                <div className="flex flex-none flex-wrap items-center gap-2">
                  <KindChip kind={selectedUnit.kind} />
                  <AttentionChip attention={selectedUnit.attention} />
                  <RiskFlags flags={selectedUnit.riskFlags} />
                  {progress && progress.changed > 0 ? <ChangedBadge count={progress.changed} /> : null}
                  {/* Collapsed, the findings list is gone — the badge is what
                      keeps a warning from disappearing with it. */}
                  {headerCollapsed ? <FindingsBadge unit={selectedUnit} /> : null}
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
              {/* 0fr -> 1fr animates to the content's real height without
                  anyone having to measure it. */}
              <div
                className="grid transition-[grid-template-rows,opacity,visibility] duration-[140ms] ease-out motion-reduce:transition-none"
                style={{
                  gridTemplateRows: headerCollapsed ? "0fr" : "1fr",
                  opacity: headerCollapsed ? 0 : 1,
                  // Clipped is not hidden: without this the summary's "show all"
                  // button stays in the tab order behind a 0px row. `visibility`
                  // flips at the *end* of the transition on the way out and at
                  // the start on the way in, so it costs nothing visually.
                  visibility: headerCollapsed ? "hidden" : "visible",
                }}
                aria-hidden={headerCollapsed}
              >
                <div className="min-h-0 overflow-hidden">
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
              </div>
            </div>
          ) : null}

          {tab === "files" && selectedPath ? (
            <div
              data-testid="file-header"
              data-collapsed={headerCollapsed ? "true" : "false"}
              className={`flex flex-none items-center gap-2 overflow-hidden border-b px-4 font-mono text-xs transition-[padding] duration-[140ms] motion-reduce:transition-none ${
                headerCollapsed ? "py-1" : "py-2"
              }`}
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
            >
              <MiddleTruncate text={selectedPath} tail={20} />
              {detail.state.files?.[selectedPath] ? (
                <span className="flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {detail.state.files[selectedPath].viewedHunks}/
                  {detail.state.files[selectedPath].totalHunks} hunks viewed
                  {detail.state.files[selectedPath].viewed && !headerCollapsed
                    ? " · synced when you press sync"
                    : ""}
                </span>
              ) : null}
              <div className="ml-auto flex flex-none items-center gap-2">
                {fileComments?.length ? (
                  <CommentBubble
                    comments={fileComments}
                    expanded={fileCommentsOpen}
                    onToggle={() => setFileCommentsOpen((v) => !v)}
                  />
                ) : null}
                <button
                  type="button"
                  data-testid="add-file-comment-header"
                  className="btn"
                  title={`Comment on ${selectedPath} as a whole`}
                  onClick={() =>
                    setCommentTarget({ subjectType: "file", file: selectedPath })
                  }
                >
                  + file
                </button>
                {showNarrowNote ? <NarrowPaneNote /> : null}
                <DiffViewToggle mode={viewMode} onChange={setViewMode} />
                <WrapToggle wrap={wrap} onChange={setWrap} />
              </div>
            </div>
          ) : null}

          {/* The pane below is virtualized and shows no file row in this tab,
              so the file's own comments hang off the header instead. */}
          {tab === "files" && selectedPath && fileCommentsOpen && fileComments?.length ? (
            <div className="max-h-[38vh] flex-none overflow-y-auto">
              <InlineCommentList
                comments={fileComments}
                label={`${selectedPath} (whole file)`}
                onCollapse={() => setFileCommentsOpen(false)}
                onAdd={() => setCommentTarget({ subjectType: "file", file: selectedPath })}
                actions={commentActions}
              />
            </div>
          ) : null}

          {search.open ? (
            <DiffSearchBar
              search={search}
              inputRef={searchInputRef}
              scopeLabel={tab === "units" ? "this unit" : "this file"}
            />
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
              commentActions={commentActions}
              viewMode={viewMode}
              onToggleViewMode={toggleViewMode}
              wrap={wrap}
              onToggleWrap={toggleWrap}
              onNarrowChange={setNarrow}
              onQuote={quote}
              searchMarks={search.marksByLine}
              activeMatch={search.current}
              onScrolledAway={onScrolledAway}
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
                addComment.mutate(targetToInput(commentTarget, body), {
                  onSuccess: () => setCommentTarget(null),
                })
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
