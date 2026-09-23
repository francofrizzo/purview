import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
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
  useDismissAnalysisPending,
  useStartAnalysis,
  useUnarchiveAndAnalyze,
  useComments,
  useDeleteComment,
  useDeletedComments,
  useRestoreComment,
  useUndoCommentEdit,
  useDeleteComments,
  useEditComment,
  useMoveComment,
  useProposeReanchor,
  useRevisionsLineChanges,
  useDiscardPendingReview,
  useDiscardRevision,
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
  useSetHunksViewed,
  useSetUnitViewed,
  useStaleness,
  useSubmitReview,
  useSync,
} from "../api/hooks";
import { errorText } from "../api/errors";
import { AnalysisBanner, ArchivedSkipBanner } from "../components/Analysis";
import { ChatPanel } from "../components/ChatPanel";
import { AttentionChip, ChangedBadge, KindChip, Progress, RiskFlags } from "../components/Chips";
import {
  CopyPathButton,
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
import { UnitChangelog } from "../components/UnitChangelog";
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
import { UNPLACED_TITLE, UnitSidebar } from "../components/UnitSidebar";
import { SidebarRail } from "../components/SidebarRail";
import { DiffSearchBar } from "../components/DiffSearchBar";
import { hunkIndex, sortUnitsForDisplay, unitProgress } from "../lib/diffModel";
import { buildDefinitionIndex } from "../lib/definitions";
import { repoLabel } from "../lib/agentExport";
import { unitForHunk } from "../lib/diffSearch";
import {
  buildHighlight,
  highlightSummaryText,
  revisionsLabel,
  type RevisionHighlight,
} from "../lib/revisionHighlight";
import { UNPLACED_ID, unplacedHunkIds } from "../lib/unplaced";
import { prPageTitle, unitFromSearch, withUnitParam } from "../lib/prUrl";
import { useDiffSearch, type SearchScope } from "../lib/useDiffSearch";
import { MiddleTruncate } from "../components/Truncate";
import { useChatFor } from "../lib/chat";
import { useDiffViewPrefs, useSettings } from "../lib/settings";
import { useSidebarMode } from "../lib/sidebarMode";
import { isStandalone, useFullscreen } from "../lib/useFullscreen";
import { shouldShowStalenessHint, stalenessDismissKey, stalenessTooltip } from "../lib/staleness";
import { InlineMarkdown } from "../components/Markdown";

/** No changelog highlight; one shared array, so nothing downstream sees a new one each render. */
const NO_REVISIONS: number[] = [];

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
  const setHunksViewed = useSetHunksViewed(prKey);
  const setUnitViewed = useSetUnitViewed(prKey);
  const patchUnit = usePatchUnit(prKey);
  const refresh = useRefresh(prKey);
  const sync = useSync(prKey);
  const addComment = useAddComment(prKey);
  const deleteComment = useDeleteComment(prKey);
  const deletedComments = useDeletedComments(prKey);
  const restoreComment = useRestoreComment(prKey);
  const undoCommentEdit = useUndoCommentEdit(prKey);
  const deleteComments = useDeleteComments(prKey);
  const editComment = useEditComment(prKey);
  const moveComment = useMoveComment(prKey);
  const proposeReanchor = useProposeReanchor(prKey);
  const saveReviewBody = useSaveReviewBody(prKey);
  const submitReview = useSubmitReview(prKey);
  const discardPending = useDiscardPendingReview(prKey);
  const discardRevision = useDiscardRevision(prKey);
  const startAnalysis = useStartAnalysis(prKey);
  const cancelAnalysis = useCancelAnalysis(prKey);
  const unarchiveAndAnalyze = useUnarchiveAndAnalyze(prKey);
  const dismissAnalysisPending = useDismissAnalysisPending(prKey);
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
  // Seeded from `?unit=` so a unit link opens on that unit; validated against
  // the real units once they load (see the effect below).
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(() =>
    unitFromSearch(location.search),
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // --- sidebar: collapsible column, or a floating drawer on a narrow/iPad
  // viewport ---------------------------------------------------------------
  const { settings, update: updateSettings } = useSettings();
  const sidebarMode = useSidebarMode();
  // Drawer state is transient by design: the persisted `sidebarCollapsed`
  // only governs column mode, so a drawer always starts (and, on switching
  // back to a drawer-sized viewport, resumes) closed.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (sidebarMode === "column") setDrawerOpen(false);
  }, [sidebarMode]);
  const sidebarCollapsed = settings.sidebarCollapsed;
  const toggleSidebar = useCallback(() => {
    if (sidebarMode === "drawer") setDrawerOpen((v) => !v);
    else updateSettings({ sidebarCollapsed: !sidebarCollapsed });
  }, [sidebarMode, sidebarCollapsed, updateSettings]);
  const openSidebar = useCallback(() => {
    if (sidebarMode === "drawer") setDrawerOpen(true);
    else updateSettings({ sidebarCollapsed: false });
  }, [sidebarMode, updateSettings]);
  // Selecting a unit or file from the drawer is "I found what I wanted" —
  // close it so the reader lands on the code. A column-mode select leaves the
  // sidebar exactly as it was.
  const selectUnitFromSidebar = useCallback(
    (unitId: string) => {
      setSelectedUnitId(unitId);
      if (sidebarMode === "drawer") setDrawerOpen(false);
    },
    [sidebarMode],
  );
  const selectFileFromSidebar = useCallback(
    (path: string) => {
      setSelectedPath(path);
      if (sidebarMode === "drawer") setDrawerOpen(false);
    },
    [sidebarMode],
  );
  // The rail is the collapsed/resting state, not a temporary overlay — picking
  // a unit from it doesn't open the drawer, it just selects (switching to the
  // units tab if the files tab was showing, since the rail is units-only).
  const selectUnitFromRail = useCallback((unitId: string) => {
    setSelectedUnitId(unitId);
    setTab("units");
  }, []);

  const fullscreen = useFullscreen();
  const [standalone] = useState(isStandalone);
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

  // --- go to definition ---------------------------------------------------
  // A new object (even for a repeat target) is what re-triggers DiffPane's
  // scroll effect — see its own jumpToHunk handling.
  const [jumpToHunk, setJumpToHunk] = useState<{ hunkId: string; nonce: number } | null>(null);

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

  // What collapsing would hand the diff pane, for it to judge whether the
  // collapse would stick (see lib/headerCollapse.ts). The open height is read
  // live; the collapsed one can only be seen once it has happened, so it is
  // remembered — the smallest seen, since a mid-animation reading is always
  // taller. Until then the whole header counts, which errs toward keeping it.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const headerRo = useRef<ResizeObserver | null>(null);
  const collapsedHeaderHeight = useRef(0);
  const setHeaderEl = useCallback((el: HTMLDivElement | null) => {
    headerRo.current?.disconnect();
    headerRo.current = null;
    headerRef.current = el;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.dataset.collapsed !== "true") return;
      const h = el.offsetHeight;
      const seen = collapsedHeaderHeight.current;
      if (h > 0 && (seen === 0 || h < seen)) collapsedHeaderHeight.current = h;
    });
    ro.observe(el);
    headerRo.current = ro;
  }, []);
  const collapsedDelta = useCallback(() => {
    const el = headerRef.current;
    if (!el || el.dataset.collapsed === "true") return 0;
    return Math.max(0, el.offsetHeight - collapsedHeaderHeight.current);
  }, []);

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

  // Hunks no live unit claims: the "Not in any unit" pseudo-unit, selected
  // through the reserved UNPLACED_ID in `selectedUnitId`. `unplacedAll` is the
  // raw count (the archived banner quotes it); `unplaced` is what the
  // sidebar/rail/diff pane offer, which is nothing until real units exist —
  // before the first analysis every hunk is "unplaced" and the analysis
  // banner already says so.
  const unplacedAll = useMemo(() => (detail ? unplacedHunkIds(detail) : []), [detail]);
  const unplaced = useMemo(() => (units.length ? unplacedAll : []), [units.length, unplacedAll]);
  const unplacedSet = useMemo(() => new Set(unplaced), [unplaced]);

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
    // A linked unit that no longer exists (re-analyzed away, now a husk)
    // falls back to the first unit instead of an empty pane. The pseudo-unit
    // is left to its own effect below.
    setSelectedUnitId((cur) =>
      cur && (cur === UNPLACED_ID || units.some((u) => u.id === cur)) ? cur : (units[0]?.id ?? null),
    );
    setSelectedPath((cur) => cur ?? detail.files.files[0]?.path ?? null);
  }, [detail, units]);

  useEffect(() => {
    setFileCommentsOpen(false);
  }, [selectedPath]);

  // An analysis just placed the last of them: the pseudo-unit is gone, so
  // land on the first real unit rather than an empty pane.
  const unplacedEmpty = unplaced.length === 0;
  useEffect(() => {
    if (selectedUnitId === UNPLACED_ID && unplacedEmpty) setSelectedUnitId(units[0]?.id ?? null);
  }, [selectedUnitId, unplacedEmpty, units]);

  // "core#8505 · Process successive batch snapshots · Purview" in the tab.
  useEffect(() => {
    if (!detail) return;
    const previous = document.title;
    document.title = prPageTitle(detail.meta);
    return () => {
      document.title = previous;
    };
  }, [detail]);

  // Per-unit URLs: `?unit=<id>` follows the selection (replace, not push, so
  // j/k through units doesn't bury the back button), and a copied URL opens
  // on that unit. Only while this page is the real location — never while a
  // settings modal sits over it, where navigating would close the modal.
  const navigate = useNavigate();
  useEffect(() => {
    if (!detail || tab !== "units") return;
    if (!window.location.pathname.startsWith("/pr/")) return;
    const next = withUnitParam(location.search, selectedUnitId);
    if (next === location.search) return;
    navigate({ pathname: location.pathname, search: next, hash: location.hash }, { replace: true, state: location.state });
  }, [detail, tab, selectedUnitId, location.pathname, location.search, location.hash, location.state, navigate]);

  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;
  const unplacedSelected = selectedUnitId === UNPLACED_ID && !unplacedEmpty;

  // --- changelog highlight -------------------------------------------------
  // Clicking changelog rows highlights, in the diff, the lines those
  // revisions changed: each click toggles one revision in or out, and the
  // union shows in one color. It follows the reader from unit to unit (each
  // unit shows its own share of those changes, or says it has none) until
  // cleared; it shows on the units tab only, and a new revision drops it.
  // Held against the revision it was set at and derived from that, so a new
  // revision drops it in the same render; the effect then forgets it for good.
  const currentRevision = detail?.state.revision ?? 0;
  const [highlightFor, setHighlightFor] = useState<{
    /** ascending, never empty */
    revisions: number[];
    atRevision: number;
  } | null>(null);
  const highlightStale = highlightFor !== null && highlightFor.atRevision !== currentRevision;
  const highlightRevisions =
    highlightFor && !highlightStale && tab === "units" && selectedUnit
      ? highlightFor.revisions
      : NO_REVISIONS;
  useEffect(() => {
    if (highlightStale) setHighlightFor(null);
  }, [highlightStale]);
  const clearHighlight = useCallback(() => setHighlightFor(null), []);
  const toggleHighlight = useCallback(
    (revision: number) =>
      setHighlightFor((prev) => {
        const held = prev && prev.atRevision === currentRevision ? prev.revisions : [];
        const next = held.includes(revision)
          ? held.filter((r) => r !== revision)
          : [...held, revision].sort((a, b) => a - b);
        return next.length ? { revisions: next, atRevision: currentRevision } : null;
      }),
    [currentRevision],
  );
  const highlightActive = highlightRevisions.length > 0;
  const lineChanges = useRevisionsLineChanges(prKey, highlightRevisions, currentRevision);
  const highlight = useMemo(() => {
    if (!highlightActive || !selectedUnit || !lineChanges.data) return null;
    return buildHighlight(lineChanges.data, { hunkIds: selectedUnit.hunkIds, unitId: selectedUnit.id });
  }, [highlightActive, selectedUnit, lineChanges.data]);

  // The composer's auto-attach chip follows whatever unit is in context; the
  // files tab has no such concept, so it sees null and shows nothing.
  const { setUnitContext } = chat;
  useEffect(() => {
    // The pseudo-unit is not a unit the chat can reference.
    setUnitContext(tab === "units" && selectedUnitId !== UNPLACED_ID ? selectedUnitId : null);
  }, [setUnitContext, tab, selectedUnitId]);

  const entries = useMemo<HunkEntry[]>(() => {
    if (!detail) return [];
    if (tab === "units") {
      const ids = unplacedSelected ? unplaced : selectedUnit?.hunkIds;
      if (!ids) return [];
      const index = hunkIndex(detail.files);
      const out: HunkEntry[] = [];
      for (const id of ids) {
        const e = index.get(id);
        if (e) out.push({ hunk: e.hunk, file: e.file });
      }
      return out;
    }
    const file = detail.files.files.find((f) => f.path === selectedPath);
    return file ? file.hunks.map((h) => ({ hunk: h, file })) : [];
  }, [detail, tab, selectedUnit, unplacedSelected, unplaced, selectedPath]);

  // What the pane is currently showing — the default (Cmd+F) search scope.
  const visibleHunkIds = useMemo(() => new Set(entries.map((e) => e.hunk.id)), [entries]);

  const search = useDiffSearch(detail, units, visibleHunkIds);
  // Search hits per unit, plus the pseudo-unit's under its reserved id so the
  // sidebar group and the rail cell can badge it like any unit.
  const unitMatchCounts = useMemo(() => {
    if (!unplacedSet.size || !search.matches.length) return search.unitCounts;
    let n = 0;
    for (const m of search.matches) if (unplacedSet.has(m.hunkId)) n++;
    if (!n) return search.unitCounts;
    const out = new Map(search.unitCounts);
    out.set(UNPLACED_ID, n);
    return out;
  }, [search.unitCounts, search.matches, unplacedSet]);
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

  /**
   * Switch to whatever unit/file shows `hunkId` (mirroring how visiting a
   * search match does it) and ask DiffPane to scroll/focus it. Used both for
   * the "first candidate is already in this diff" auto-jump and for clicking
   * an "in this diff" marker in the popover's candidate list.
   */
  const jumpToDiffHunk = useCallback(
    (hunkId: string, path: string, target?: { line?: number; addedIndex?: number }) => {
      if (tab === "units") {
        const unit = unitForHunk(units, hunkId);
        if (unit) {
          if (unit.id !== selectedUnitId) setSelectedUnitId(unit.id);
        } else if (unplacedSet.has(hunkId)) {
          setSelectedUnitId(UNPLACED_ID);
        } else {
          // No unit claims this hunk — only reachable through the files tab.
          setTab("files");
          setSelectedPath(path);
        }
      } else if (selectedPath !== path) {
        setSelectedPath(path);
      }
      setJumpToHunk({ hunkId, nonce: Date.now(), ...target });
    },
    [tab, units, unplacedSet, selectedUnitId, selectedPath],
  );

  /**
   * Files tab only: each hunk header quietly names the unit it belongs to
   * (units tab already groups by unit, so this would be redundant there).
   * Looked up per hunk rather than precomputed into a map — `units` and its
   * hunk lists are small, and this mirrors `unitForHunk`'s other callers.
   */
  const unitForHunkId = useMemo(() => {
    if (tab !== "files") return undefined;
    return (hunkId: string) => {
      const unit = unitForHunk(units, hunkId);
      return unit ? { id: unit.id, title: unit.title, attention: unit.attention } : null;
    };
  }, [tab, units]);

  /** Clicking that unit label: jump to the units tab, same unit, same hunk —
   *  the same "switch tab, keep the hunk in view" flow as jumpToDiffHunk. */
  const onHunkUnitClick = useCallback((unitId: string, hunkId: string) => {
    setSelectedUnitId(unitId);
    setTab("units");
    setJumpToHunk({ hunkId, nonce: Date.now() });
  }, []);

  // Built once per PR detail: every identifier the diff itself defines, keyed
  // for O(1) lookup — see lib/definitions.ts. Both the hover affordance and
  // the click handler below key off this same index, so cmd+click only ever
  // does something for an identifier the PR itself introduces.
  const definitionIndex = useMemo(
    () => (detail ? buildDefinitionIndex(detail.files) : new Map()),
    [detail],
  );
  const isDefinedInDiff = useCallback(
    (symbol: string) => definitionIndex.has(symbol),
    [definitionIndex],
  );

  /** Cmd+click "go to definition" — see DiffLine.tsx / lib/identifierAt.ts.
   *  Only ever called for a symbol `isDefinedInDiff` already approved, so the
   *  first definition is always there to jump to. */
  const handleDefinitionClick = useCallback(
    (symbol: string) => {
      const local = definitionIndex.get(symbol);
      if (!local || local.length === 0) return;
      jumpToDiffHunk(local[0].hunkId, local[0].path, { addedIndex: local[0].addedIndex });
    },
    [definitionIndex, jumpToDiffHunk],
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
      } else if (e.key === "b") {
        // `b` (as in VS Code's ⌘B), not `[`: on Spanish and other ISO layouts
        // the bracket is an Option chord, and the modifier guard above would
        // swallow it — the shortcut has to be a plain letter to exist at all.
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "Escape" && search.open) {
        e.preventDefault();
        search.close();
      } else if (e.key === "Escape" && sidebarMode === "drawer" && drawerOpen) {
        e.preventDefault();
        setDrawerOpen(false);
      } else if (
        e.key === "Escape" &&
        highlightActive &&
        // Last in line: an open popover, overlay, composer or line selection
        // claims Escape first (they mark it handled, or stop it outright).
        !e.defaultPrevented &&
        !summaryOpen &&
        !commentTarget
      ) {
        e.preventDefault();
        clearHighlight();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    chat,
    openSearch,
    search.open,
    search.close,
    toggleSidebar,
    sidebarMode,
    drawerOpen,
    highlightActive,
    clearHighlight,
    summaryOpen,
    commentTarget,
  ]);

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
    // Identity of the match, not its position: the index shifts whenever an
    // earlier match drops out of a recomputed set, and that is not a visit.
    const key = `${m.hunkId}:${m.lineIdx}:${m.start}`;
    if (key === visited.current) return;
    visited.current = key;
    if (tab === "units") {
      const unit = unitForHunk(units, m.hunkId);
      if (unit) {
        if (unit.id !== selectedUnitId) setSelectedUnitId(unit.id);
        return;
      }
      if (unplacedSet.has(m.hunkId)) {
        if (selectedUnitId !== UNPLACED_ID) setSelectedUnitId(UNPLACED_ID);
        return;
      }
      // Otherwise (no units at all yet) the files tab is the only way to it.
      setTab("files");
      setSelectedPath(m.path);
      return;
    }
    if (m.path !== selectedPath) setSelectedPath(m.path);
  }, [search.current, tab, units, unplacedSet, selectedUnitId, selectedPath]);

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
  // A refresh of this archived PR landed work and auto-analysis skipped it.
  // Hidden while a run is live: the explicit analyze clears the note server-
  // side, and the detail catches up when the run finishes.
  const skipNote = detail.analysisPending;
  const showArchivedSkipBanner =
    !!skipNote && skipNote.reason === "archived" && detail.meta.archived === true && !analysisPending;
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
    onUndoEdit: (id: string) => undoCommentEdit.mutate(id),
    undoing: undoCommentEdit.isPending,
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

  // Shared between the column and the drawer — same header row (tabs +
  // collapse/close chevron), same list, same footer legend, just mounted in
  // a different container depending on `sidebarMode`.
  const sidebarBody = (
    <>
      <div className="flex flex-none border-b" style={{ borderColor: "var(--border)" }}>
        {(["units", "files"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="sidebar-tab-btn flex-1 border-b-2 px-2 py-1.5 text-2xs uppercase tracking-wider transition-colors"
            style={{
              borderColor: tab === t ? "var(--accent)" : "transparent",
              color: tab === t ? "var(--fg)" : "var(--fg-faint)",
            }}
          >
            {t === "units" ? "review units" : "files"}
          </button>
        ))}
        <button
          type="button"
          className="flex-none px-2"
          style={{ color: "var(--fg-faint)" }}
          title={sidebarMode === "drawer" ? "Close sidebar" : "Collapse sidebar"}
          aria-label={sidebarMode === "drawer" ? "Close sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          <IconChevron width={11} height={11} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === "units" ? (
          <UnitSidebar
            detail={detail}
            selectedUnitId={selectedUnitId}
            onSelect={selectUnitFromSidebar}
            onReclassify={(unitId, patch) => patchUnit.mutate({ unitId, patch })}
            onQuote={quote}
            matchCounts={unitMatchCounts}
          />
        ) : (
          <FileTree
            detail={detail}
            selectedPath={selectedPath}
            onSelect={selectFileFromSidebar}
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
          <kbd>j</kbd>/<kbd>k</kbd> hunk · <kbd>v</kbd> viewed · <kbd>z</kbd> folds ·{" "}
          <kbd>space</kbd> next unviewed
        </div>
        <div>
          <kbd>d</kbd> {viewMode === "split" ? "unified" : "split"} · <kbd>w</kbd>{" "}
          {wrap ? "no wrap" : "wrap"} · <kbd>c</kbd> chat · <kbd>s</kbd> summary · <kbd>/</kbd> search ·{" "}
          <kbd>b</kbd> sidebar · <kbd>⌘</kbd>click definition
        </div>
      </div>
    </>
  );

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
        fullscreenVisible={fullscreen.supported && !standalone}
        fullscreenActive={fullscreen.active}
        onToggleFullscreen={fullscreen.toggle}
        onToggleDrafts={() => setDraftsOpen((v) => !v)}
        onToggleChat={chat.toggleChat}
        onAnalyze={() => startAnalysis.mutate()}
        onCancelAnalysis={() => cancelAnalysis.mutate()}
        onExportAnalysis={handleExportAnalysis}
        onImportFilePicked={handleImportFilePicked}
        onShareToPr={handleOpenShareConfirm}
        onImportFromPr={handleOpenImportFromPrConfirm}
        discardingRevision={discardRevision.isPending}
        discardRevisionError={discardRevision.error ? errorText(discardRevision.error) : null}
        onDiscardRevision={(n) =>
          // A migration report still on screen described the revision just dropped.
          discardRevision.mutate(n, { onSuccess: () => setReport(null) })
        }
        onResetDiscardRevision={() => discardRevision.reset()}
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
      {showArchivedSkipBanner && skipNote ? (
        <ArchivedSkipBanner
          revision={skipNote.revision}
          unplaced={unplacedAll.length}
          working={unarchiveAndAnalyze.isPending}
          error={(unarchiveAndAnalyze.error as Error | null)?.message ?? null}
          onUnarchiveAndAnalyze={() => unarchiveAndAnalyze.mutate()}
          onDismiss={() => dismissAnalysisPending.mutate()}
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

      <div className="relative flex min-h-0 flex-1">
        {sidebarMode === "column" ? (
          <nav
            className="flex flex-none flex-col overflow-hidden border-r transition-[width] duration-150 motion-reduce:transition-none motion-reduce:duration-0"
            style={{
              width: sidebarCollapsed ? "var(--sidebar-rail-width)" : "19rem",
              borderColor: "var(--border)",
              background: "var(--bg-raised)",
            }}
          >
            {sidebarCollapsed ? (
              <SidebarRail
                detail={detail}
                units={units}
                selectedUnitId={selectedUnitId}
                matchCounts={unitMatchCounts}
                onSelect={selectUnitFromRail}
                onExpand={openSidebar}
                expandLabel="Expand sidebar"
              />
            ) : (
              <div className="flex h-full w-[19rem] flex-none flex-col">{sidebarBody}</div>
            )}
          </nav>
        ) : null}

        {sidebarMode === "drawer" ? (
          // The rail is the drawer mode's resting state — always present,
          // never unmounted — with the full sidebar floating over it (and
          // over the diff) exactly like it floats when opened below.
          <nav
            className="flex flex-none flex-col border-r"
            style={{
              width: "var(--sidebar-rail-width)",
              borderColor: "var(--border)",
              background: "var(--bg-raised)",
            }}
          >
            <SidebarRail
              detail={detail}
              units={units}
              selectedUnitId={selectedUnitId}
              matchCounts={unitMatchCounts}
              onSelect={selectUnitFromRail}
              onExpand={openSidebar}
              expandLabel="Open sidebar"
            />
          </nav>
        ) : null}

        {sidebarMode === "drawer" && drawerOpen ? (
          <>
            {/* Transparent scrim: tapping anywhere outside the drawer closes it. */}
            <div
              className="absolute inset-0 z-30"
              style={{ background: "rgba(0, 0, 0, 0.4)" }}
              onClick={() => setDrawerOpen(false)}
            />
            <nav
              className="elev-3 absolute inset-y-0 left-0 z-40 flex w-[19rem] flex-none flex-col border-r"
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
            >
              {sidebarBody}
            </nav>
          </>
        ) : null}

        <main ref={mainRef} className="relative flex min-w-0 flex-1 flex-col">
          {tab === "units" && selectedUnit ? (
            <div
              ref={setHeaderEl}
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
                  <InlineMarkdown text={selectedUnit.title} />
                </h2>
                <div className="flex flex-none flex-wrap items-center gap-2">
                  <KindChip kind={selectedUnit.kind} />
                  <AttentionChip attention={selectedUnit.attention} />
                  <RiskFlags flags={selectedUnit.riskFlags} />
                  {progress && progress.changed > 0 ? <ChangedBadge count={progress.changed} /> : null}
                  {/* Collapsed, the findings list is gone — the badge is what
                      keeps a warning from disappearing with it. */}
                  {headerCollapsed ? <FindingsBadge unit={selectedUnit} /> : null}
                  {headerCollapsed && highlightActive ? (
                    <button
                      type="button"
                      className="changed-in-chip chip"
                      data-testid="highlight-chip"
                      title={`Showing the lines ${revisionsLabel(highlightRevisions, " + ")} changed · click or esc to clear`}
                      onClick={clearHighlight}
                    >
                      {revisionsLabel(highlightRevisions, " + ")} changes · clear
                    </button>
                  ) : null}
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
                    <InlineMarkdown text={selectedUnit.summary} />
                  </p>
                  <UnitChangelog
                    changelog={selectedUnit.changelog}
                    currentRevision={detail.state.revision}
                    activeRevisions={highlightRevisions}
                    onSelectRevision={toggleHighlight}
                  />
                  {highlightActive ? (
                    <HighlightSummary
                      revisions={highlightRevisions}
                      highlight={highlight}
                      failed={lineChanges.failed}
                      onClear={clearHighlight}
                    />
                  ) : null}
                  {selectedUnit.attentionWhy ? (
                    <p className="mt-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                      why {selectedUnit.attention}: <InlineMarkdown text={selectedUnit.attentionWhy} />
                    </p>
                  ) : null}
                  <UnitFindings findings={selectedUnit.findings} />
                </div>
              </div>
            </div>
          ) : null}

          {tab === "units" && unplacedSelected ? (
            <UnplacedHeader
              total={unplaced.length}
              viewed={unplaced.filter((id) => detail.state.hunks[id]?.viewed).length}
              canAnalyze={!analysisPending}
              analyzing={startAnalysis.isPending}
              analyzeError={(startAnalysis.error as Error | null)?.message ?? null}
              onAnalyze={() => startAnalysis.mutate()}
              markingViewed={setHunksViewed.isPending}
              onMarkViewed={() => setHunksViewed.mutate({ hunkIds: unplaced, viewed: true })}
              controls={
                <>
                  {showNarrowNote ? <NarrowPaneNote /> : null}
                  <DiffViewToggle mode={viewMode} onChange={setViewMode} />
                  <WrapToggle wrap={wrap} onChange={setWrap} />
                </>
              }
            />
          ) : null}

          {tab === "files" && selectedPath ? (
            <div
              ref={setHeaderEl}
              data-testid="file-header"
              data-collapsed={headerCollapsed ? "true" : "false"}
              className={`flex flex-none items-center gap-2 overflow-hidden border-b px-4 font-mono text-xs transition-[padding] duration-[140ms] motion-reduce:transition-none ${
                headerCollapsed ? "py-1" : "py-2"
              }`}
              style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
            >
              <MiddleTruncate text={selectedPath} tail={20} />
              <CopyPathButton path={selectedPath} />
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
              onSetHunksViewed={(hunkIds, viewed) => setHunksViewed.mutate({ hunkIds, viewed })}
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
              collapsedDelta={collapsedDelta}
              onDefinitionClick={handleDefinitionClick}
              isDefinedInDiff={isDefinedInDiff}
              jumpToHunk={jumpToHunk}
              highlight={tab === "units" ? highlight : null}
              unitForHunkId={unitForHunkId}
              onUnitClick={onHunkUnitClick}
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
            onDeleteMany={(ids) => deleteComments.mutateAsync(ids)}
            onEdit={(input) => editComment.mutateAsync(input)}
            onQuote={quote}
            deleted={deletedComments.data}
            onRestore={(id) => restoreComment.mutate(id)}
            onUndoEdit={(id) => undoCommentEdit.mutate(id)}
            undoing={restoreComment.isPending || undoCommentEdit.isPending}
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
            files={detail?.files}
            onProposeReanchor={async (id) => {
              const result = await proposeReanchor.mutateAsync(id);
              if (!result.ok) throw new Error(result.reason);
              return result.proposal;
            }}
            onApplyReanchor={async (id, target) => {
              await moveComment.mutateAsync({ id, ...target });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Header for the "Not in any unit" pseudo-unit: what these hunks are, and the
 * one thing that fixes it (an analysis — incremental, since units exist).
 * No collapse behaviour: it is two short lines, there is no prose to hide.
 */
function UnplacedHeader({
  total,
  viewed,
  canAnalyze,
  analyzing,
  analyzeError,
  onAnalyze,
  markingViewed,
  onMarkViewed,
  controls,
}: {
  total: number;
  viewed: number;
  canAnalyze: boolean;
  analyzing: boolean;
  analyzeError: string | null;
  onAnalyze: () => void;
  markingViewed: boolean;
  onMarkViewed: () => void;
  controls: ReactNode;
}) {
  return (
    <div
      data-testid="unplaced-header"
      className="flex-none border-b px-4 py-2.5"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 basis-64 text-[13px] font-semibold leading-tight">
          Not in any unit
        </h2>
        <div className="ml-auto flex flex-none flex-wrap items-center gap-2">
          {controls}
          <Progress viewed={viewed} total={total} />
          {canAnalyze ? (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="unplaced-analyze"
              disabled={analyzing}
              onClick={onAnalyze}
            >
              {analyzing ? "starting…" : "Analyze"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={markingViewed || viewed === total}
            onClick={onMarkViewed}
          >
            mark all viewed
          </button>
        </div>
      </div>
      <p className="mt-1 max-w-4xl text-xs leading-5" style={{ color: "var(--fg-muted)" }}>
        {UNPLACED_TITLE}
      </p>
      {analyzeError ? (
        <p className="mt-1 text-2xs" style={{ color: "var(--risk)" }}>
          {analyzeError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The line under the changelog while revisions are highlighted: what is
 * marked, what they touched that is gone, and the way out.
 */
function HighlightSummary({
  revisions,
  highlight,
  failed,
  onClear,
}: {
  revisions: readonly number[];
  highlight: RevisionHighlight | null;
  failed: { revision: number; error: Error } | null;
  onClear: () => void;
}) {
  const error = failed?.error ?? null;
  const body = highlightSummaryText(revisions, highlight, failed);
  return (
    <p
      className="mt-1 flex max-w-4xl flex-wrap items-baseline gap-x-1 text-2xs"
      data-testid="highlight-summary"
      style={{ color: error ? "var(--risk)" : "var(--fg-muted)" }}
    >
      <span
        aria-hidden
        className="mr-1 inline-block h-2.5 w-[3px] flex-none self-center rounded-full"
        style={{ background: "var(--changed-in-bar)" }}
      />
      <span>{body}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        data-testid="highlight-clear"
        className="underline-offset-2 hover:underline"
        style={{ color: "var(--accent)" }}
        title="Clear the highlight (esc)"
        onClick={onClear}
      >
        clear
      </button>
    </p>
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
