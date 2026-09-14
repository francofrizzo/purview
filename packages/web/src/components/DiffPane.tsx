import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatRef, DraftComment, FileEntry, Hunk, PrDetail } from "../api/types";
import { baseName, lineRangeRef } from "../lib/chatRefs";
import { groupComments, lineAnchor } from "../lib/comments";
import {
  buildMoveIndex,
  buildRows,
  buildSplitRows,
  hunkLabel,
  type CharRange,
  type DiffRow,
} from "../lib/diffModel";
import { lineKey, type SearchMatch } from "../lib/diffSearch";
import { detectMoves, type HunkMoves } from "../lib/moveDetection";
import {
  mergeStickyIntoRange,
  stickyHeadersFor,
  type StickyHeaders,
} from "../lib/stickyHeaders";
import {
  EMPTY_COLLAPSED,
  isCollapsed,
  pruneCollapsed,
  reconcileViewed,
  setCollapsed,
  toggleCollapsed,
  viewedSnapshot,
  type CollapsedMap,
} from "../lib/hunkCollapse";
import { useTokensForHunks } from "../lib/useHunkTokens";
import { useSettings, type DiffViewMode } from "../lib/settings";
import { shikiThemeFor } from "../lib/themes";
import { ChangedBadge } from "./Chips";
import { QuoteButton } from "./ChatPanel";
import {
  COMMENT_COL_WIDTH,
  DiffLine,
  SplitDiffLine,
  type LineMarks,
  type LineSide,
  type OnDefinitionClick,
} from "./DiffLine";
import { DiffOfDiffs } from "./DiffOfDiffs";
import type { CommentTarget } from "./Drafts";
import { CommentBubble, InlineCommentList, type InlineCommentActions } from "./InlineComments";
import { MiddleTruncate } from "./Truncate";
import { IconCheck, IconChevron, IconClose, IconComment, IconQuote, IconSplit, IconUnified, IconWrap } from "./icons";

export interface HunkEntry {
  hunk: Hunk;
  file: FileEntry;
}

/** Below this pane width side-by-side is unreadable, so we render unified. */
export const SPLIT_MIN_WIDTH = 700;

/** px of chrome left of the code column in unified: 2 gutters + comment column + marker + right pad. */
const UNIFIED_CHROME = 52 + 52 + COMMENT_COL_WIDTH + 12 + 16;

/** Visual column count of a line, expanding tabs the way the browser renders them. */
function columns(s: string, tabSize: number): number {
  let c = 0;
  for (const ch of s) c = ch === "\t" ? c + (tabSize - (c % tabSize)) : c + 1;
  return c;
}

type FlatRow =
  | { type: "file"; key: string; path: string; file: FileEntry }
  | { type: "hunk"; key: string; hunkId: string; entry: HunkEntry }
  | { type: "dod"; key: string; hunkId: string }
  | { type: "line"; key: string; hunkId: string; entry: HunkEntry; lineIdx: number }
  | { type: "split"; key: string; hunkId: string; entry: HunkEntry; rowIdx: number }
  /** expanded comments hanging off one line anchor; height is whatever it is */
  | {
      type: "comments";
      key: string;
      hunkId: string;
      anchor: string;
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
    }
  /** expanded comments hanging off a whole file */
  | { type: "filecomments"; key: string; path: string };

export interface DiffPaneProps {
  detail: PrDetail;
  entries: HunkEntry[];
  drafts: DraftComment[];
  focusedHunkId: string | null;
  onFocusHunk: (id: string | null) => void;
  onToggleViewed: (hunkId: string, viewed: boolean) => void;
  onComment: (target: CommentTarget) => void;
  /**
   * Edit / delete / quote / copy for comments read inline. Omitted, the
   * bubbles still expand — they just become read-only.
   */
  commentActions?: InlineCommentActions;
  viewMode?: DiffViewMode;
  onToggleViewMode?: () => void;
  wrap?: boolean;
  onToggleWrap?: () => void;
  /** Reports whether the pane is too narrow for side-by-side, so the host can note it. */
  onNarrowChange?: (narrow: boolean) => void;
  /** Files tab shows a single file and already names it in the pane header. */
  showFileRows?: boolean;
  emptyMessage?: string;
  /** Quote affordances — omitted, the diff has no chat integration at all. */
  onQuote?: (ref: ChatRef) => void;
  /** Search hits for every row of the whole diff, keyed `hunkId:lineIdx`. */
  searchMarks?: Map<string, CharRange[]>;
  /** The match being visited: highlighted strongly, scrolled to, flashed. */
  activeMatch?: SearchMatch | null;
  /**
   * Fires when the reader leaves (or returns to) the top of the diff, so the
   * host can shrink its header out of the way. Hysteretic: true past
   * {@link COLLAPSE_PAST}px, false again only under {@link EXPAND_UNDER}px.
   */
  onScrolledAway?: (scrolled: boolean) => void;
  /** Cmd/ctrl+click "go to definition" on an identifier — see DiffLine.tsx. */
  onDefinitionClick?: OnDefinitionClick;
  /**
   * Scroll/focus request from outside (a "go to definition" candidate that
   * turned out to already be in this diff). A new object — even for the same
   * hunk — triggers another jump; `hunkId` must already be part of `entries`
   * (the host is responsible for switching unit/file first, same as a search
   * visit does).
   */
  jumpToHunk?: { hunkId: string; nonce: number } | null;
}

/** Past this many px from the top, the host header may collapse. */
const COLLAPSE_PAST = 40;
/** Under this many px, it expands again. The gap between the two is the
 *  hysteresis that keeps a header parked on the boundary from flickering. */
const EXPAND_UNDER = 10;
/**
 * Collapsing the host header makes this scroller *taller*, which clamps
 * scrollTop down. On a diff short enough, that clamp lands back under
 * EXPAND_UNDER, the header re-expands, and the pair oscillates forever at the
 * bottom of the page. So the collapse only engages when the scroll slack
 * comfortably exceeds the height the header hand-back can return (~100px):
 * a diff too short to absorb the swap keeps its header whole instead.
 */
const MIN_COLLAPSE_SLACK = 160;

/** A range being selected in one file, on one side of the diff. */
interface LineSelection {
  path: string;
  side: LineSide;
  anchor: number;
  focus: number;
}

const inSelection = (
  selection: LineSelection | null,
  path: string,
  side: LineSide,
  line?: number,
): boolean =>
  Boolean(
    selection &&
      line !== undefined &&
      selection.path === path &&
      selection.side === side &&
      line >= Math.min(selection.anchor, selection.focus) &&
      line <= Math.max(selection.anchor, selection.focus),
  );

export function DiffPane({
  detail,
  entries,
  drafts,
  focusedHunkId,
  onFocusHunk,
  onToggleViewed,
  onComment,
  commentActions,
  viewMode = "unified",
  onToggleViewMode,
  wrap = true,
  onToggleWrap,
  onNarrowChange,
  showFileRows = true,
  emptyMessage = "Nothing to show.",
  onQuote,
  searchMarks,
  activeMatch,
  onScrolledAway,
  onDefinitionClick,
  jumpToHunk,
}: DiffPaneProps) {
  const { appearance, settings } = useSettings();
  const theme = shikiThemeFor(appearance.theme);
  const { codeFontSize, codeLineHeight, tabSize, codeFont } = appearance;
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const pastTopRef = useRef<HTMLDivElement>(null);
  const nearTopRef = useRef<HTMLDivElement>(null);
  const [expandedDod, setExpandedDod] = useState<Set<string>>(new Set());
  const [wide, setWide] = useState(true);
  const [charWidth, setCharWidth] = useState(7.2);

  // Narrow viewports fall back to unified rather than squeezing two panes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setWide(el.clientWidth >= SPLIT_MIN_WIDTH);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entries.length === 0]);

  useEffect(() => {
    onNarrowChange?.(!wide);
  }, [wide, onNarrowChange]);

  // Cmd/ctrl+click "go to definition" affordance: toggle a class on the
  // scroller while the modifier is held, rather than tracking hover per row —
  // one listener pair for the whole pane, virtualized rows untouched.
  useEffect(() => {
    if (!onDefinitionClick) return;
    const el = scrollRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) el.classList.add("cmd-held");
    };
    const clear = () => el.classList.remove("cmd-held");
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", clear);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [onDefinitionClick]);

  // Two zero-cost sentinels pinned to the top of the scrolled content, watched
  // against the scroller itself: the tall one stops intersecting once we are
  // past COLLAPSE_PAST, the short one starts intersecting again under
  // EXPAND_UNDER, and the band between them is dead air where neither fires —
  // which *is* the hysteresis. No scroll handler, no scrollTop read per frame.
  const empty = entries.length === 0;
  useEffect(() => {
    if (!onScrolledAway) return;
    const root = scrollRef.current;
    const past = pastTopRef.current;
    const near = nearTopRef.current;
    if (!root || !past || !near || typeof IntersectionObserver === "undefined") {
      // Nothing to scroll (or no observer): the header stays whole.
      onScrolledAway(false);
      return;
    }
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (r.target === past && !r.isIntersecting) {
            if (root.scrollHeight - root.clientHeight >= MIN_COLLAPSE_SLACK) onScrolledAway(true);
          } else if (r.target === near && r.isIntersecting) onScrolledAway(false);
        }
      },
      { root },
    );
    io.observe(past);
    io.observe(near);
    return () => {
      io.disconnect();
      onScrolledAway(false);
    };
  }, [onScrolledAway, empty]);

  const mode: DiffViewMode = viewMode === "split" && wide ? "split" : "unified";

  // Monospace, so one measurement gives every line's width. Re-measured when
  // the code font or its size changes.
  useLayoutEffect(() => {
    const w = measureRef.current?.getBoundingClientRect().width;
    if (w && w > 0) setCharWidth(w / 100);
  }, [codeFont, codeFontSize]);

  /** Widest line in the shown set, in columns — only needed when wrap is off. */
  const maxColumns = useMemo(() => {
    if (wrap) return 0;
    let max = 0;
    for (const e of entries) {
      for (const r of buildRows(e.hunk, detail.diff)) {
        const c = columns(r.content, tabSize);
        if (c > max) max = c;
      }
    }
    return max;
  }, [wrap, entries, detail.diff, tabSize]);

  // Unified scrolls as a single pane: give the row container the full content
  // width so row backgrounds (and the hunk headers) span the whole scroll
  // range instead of stopping at the viewport edge.
  const contentWidth =
    !wrap && mode === "unified" && maxColumns
      ? Math.ceil(UNIFIED_CHROME + maxColumns * charWidth)
      : 0;

  const hunks = useMemo(() => entries.map((e) => e.hunk), [entries]);
  const tokens = useTokensForHunks(hunks, detail.diff, theme);

  // Moves are detected over every file of the revision (a move can cross
  // file boundaries), not just the entries currently shown in this pane.
  const moves = useMemo(() => detectMoves(detail.files.files), [detail.files]);

  /** Whether one unified row (identified by its index into `buildRows`) is
   *  part of a moved run, per lib/moveDetection.ts's per-line granularity. */
  const movedAt = useCallback(
    (hunkId: string, hunk: Hunk, unifiedIdx: number, type: DiffRow["type"]): boolean => {
      const hunkMoves: HunkMoves | undefined = moves.get(hunkId);
      if (!hunkMoves) return false;
      const moveIndex = buildMoveIndex(hunk, detail.diff);
      if (type === "del") {
        const idx = moveIndex.removedIdx[unifiedIdx];
        return idx !== undefined && hunkMoves.movedOut.has(idx);
      }
      if (type === "add") {
        const idx = moveIndex.addedIdx[unifiedIdx];
        return idx !== undefined && hunkMoves.movedIn.has(idx);
      }
      return false;
    },
    [moves, detail.diff],
  );

  const grouped = useMemo(() => groupComments(drafts), [drafts]);

  /**
   * Which comment blocks are open, keyed by anchor rather than by row index:
   * the anchor survives a unified/split switch, a wrap toggle and a font
   * change, so a block the reader opened stays open through all of them.
   */
  const [expandedAnchors, setExpandedAnchors] = useState<Set<string>>(() => new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());

  const toggleAnchor = useCallback((anchor: string) => {
    captureAnchorPosition();
    setExpandedAnchors((prev) => {
      const next = new Set(prev);
      if (next.has(anchor)) next.delete(anchor);
      else next.add(anchor);
      return next;
    });
  }, []);

  const toggleFileComments = useCallback((path: string) => {
    captureAnchorPosition();
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /* ------------------------------------------------------- hunk collapsing */

  const { autoCollapseViewedHunks } = settings;
  const [collapsed, setCollapsedState] = useState<CollapsedMap>(EMPTY_COLLAPSED);

  const toggleHunkCollapsed = useCallback((hunkId: string) => {
    captureAnchorPosition();
    setCollapsedState((prev) => toggleCollapsed(prev, hunkId));
  }, []);

  // Auto-collapse follows *changes* to the viewed flags, wherever they come
  // from — the checkbox, `v`, or "mark unit viewed" ticking a dozen at once.
  // Comparing against the previous snapshot (rather than reacting to the flag
  // itself) is what lets a manual unfold survive until the state next moves.
  const viewedNow = useMemo(() => viewedSnapshot(detail.state.hunks), [detail.state.hunks]);
  const prevViewed = useRef(viewedNow);
  useEffect(() => {
    const previous = prevViewed.current;
    prevViewed.current = viewedNow;
    if (previous === viewedNow) return;
    setCollapsedState((prev) => reconcileViewed(prev, previous, viewedNow, autoCollapseViewedHunks));
  }, [viewedNow, autoCollapseViewedHunks]);

  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    let lastFile: string | null = null;
    // Row heights depend on the wrap mode as much as on unified/split, so the
    // wrap flag is part of the key: it drops the virtualizer's stale
    // measurement cache the same way the s:/l: prefixes do.
    // Font size changes row heights too, so it joins the key for the same reason.
    const w = `${wrap ? "w" : "n"}${codeFontSize}`;
    for (const entry of entries) {
      const { hunk, file } = entry;
      if (file.path !== lastFile) {
        if (showFileRows) {
          out.push({ type: "file", key: `f:${file.path}:${hunk.id}`, path: file.path, file });
          if (expandedFiles.has(file.path) && grouped.byFile.has(file.path)) {
            out.push({ type: "filecomments", key: `xf:${file.path}`, path: file.path });
          }
        }
        lastFile = file.path;
      }
      out.push({ type: "hunk", key: `h:${hunk.id}`, hunkId: hunk.id, entry });
      if (expandedDod.has(hunk.id)) {
        out.push({ type: "dod", key: `d:${hunk.id}`, hunkId: hunk.id });
      }
      // A folded hunk contributes its header and nothing else. Dropping the
      // rows (rather than hiding them) is what makes folding actually cheap:
      // the virtualizer never mounts or measures them at all.
      if (isCollapsed(collapsed, hunk.id)) continue;

      /** Push the comment block for one anchor, when it is open. */
      const pushComments = (path: string, line: number, side: "LEFT" | "RIGHT") => {
        const anchor = lineAnchor(path, line, side);
        if (!expandedAnchors.has(anchor)) return;
        if (!grouped.byLine.has(anchor)) return;
        out.push({
          type: "comments",
          key: `x:${anchor}`,
          hunkId: hunk.id,
          anchor,
          path,
          line,
          side,
        });
      };

      if (mode === "split") {
        const pairs = buildSplitRows(hunk, detail.diff);
        for (let i = 0; i < pairs.length; i++) {
          out.push({
            type: "split",
            key: `${w}s:${hunk.id}:${i}`,
            hunkId: hunk.id,
            entry,
            rowIdx: i,
          });
          const pair = pairs[i];
          const leftNo =
            pair.left && pair.left.row.type === "del" ? pair.left.row.oldNumber : undefined;
          const rightNo = pair.right ? pair.right.row.newNumber : undefined;
          if (leftNo !== undefined) pushComments(file.path, leftNo, "LEFT");
          if (rightNo !== undefined) pushComments(file.path, rightNo, "RIGHT");
        }
      } else {
        const lines = buildRows(hunk, detail.diff);
        for (let i = 0; i < lines.length; i++) {
          out.push({
            type: "line",
            key: `${w}l:${hunk.id}:${i}`,
            hunkId: hunk.id,
            entry,
            lineIdx: i,
          });
          const line = lines[i];
          const side = line.type === "del" ? "LEFT" : "RIGHT";
          const no = line.type === "del" ? line.oldNumber : line.newNumber;
          if (no !== undefined) pushComments(file.path, no, side);
        }
      }
    }
    return out;
  }, [
    entries,
    detail.diff,
    expandedDod,
    expandedAnchors,
    expandedFiles,
    grouped,
    collapsed,
    mode,
    wrap,
    showFileRows,
    codeFontSize,
  ]);

  const hunkRowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.type === "hunk" && !m.has(r.hunkId)) m.set(r.hunkId, i);
    });
    return m;
  }, [rows]);

  // Sticky headers: the current file/hunk header rows stay mounted (range
  // extractor) and pinned (render swaps them to position: sticky). See
  // lib/stickyHeaders.ts for the row-picking logic.
  const headerIdxs = useMemo(() => {
    const file: number[] = [];
    const hunk: number[] = [];
    rows.forEach((r, i) => {
      if (r.type === "file") file.push(i);
      else if (r.type === "hunk") hunk.push(i);
    });
    return { file, hunk };
  }, [rows]);
  const stickyRef = useRef<StickyHeaders>({});
  const rangeExtractor = useCallback(
    (range: Range) => {
      const sticky = stickyHeadersFor(headerIdxs.file, headerIdxs.hunk, range.startIndex);
      stickyRef.current = sticky;
      return mergeStickyIntoRange(sticky, defaultRangeExtractor(range));
    },
    [headerIdxs],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.type === "line") return codeLineHeight;
      // split cells wrap, so rows are often taller than one line; measurement
      // corrects this, the estimate only needs to be in the right ballpark.
      if (r.type === "split") return codeLineHeight;
      if (r.type === "dod") return 170;
      // Comment blocks are the one genuinely variable row. The estimate only
      // has to be in the right order of magnitude — measureElement's
      // ResizeObserver corrects it on mount and again on every edit, expand or
      // markdown reflow inside it.
      if (r.type === "comments") {
        return 56 + 78 * (grouped.byLine.get(r.anchor)?.length ?? 1);
      }
      if (r.type === "filecomments") {
        return 56 + 78 * (grouped.byFile.get(r.path)?.length ?? 1);
      }
      return 34;
    },
    overscan: 30,
    getItemKey: (i) => rows[i].key,
    rangeExtractor,
    // scrollToIndex targets land under the pinned header stack otherwise;
    // one header height of padding keeps the row it navigated to visible.
    scrollPaddingStart: 40,
  });

  /* ------------------------------------------- keeping the reader in place */
  // Folding a hunk, or closing a comment block, deletes rows that may be
  // *above* the viewport — after which the pixel scroll offset points
  // somewhere else entirely. So: note where the focused hunk's header sits
  // relative to the scroller before the change, and put it back afterwards.
  // Nothing is scrolled when the header was off-screen, or when it did not
  // move: this only ever undoes displacement, it never navigates.
  const anchorPos = useRef<{ id: string; top: number } | null>(null);

  function captureAnchorPosition() {
    const scroller = scrollRef.current;
    const id = focusedRef.current;
    if (!scroller || !id) return;
    const idx = hunkRowIndexRef.current.get(id);
    if (idx === undefined) return;
    const el = scroller.querySelector<HTMLElement>(`[data-index="${idx}"]`);
    if (!el) return;
    anchorPos.current = {
      id,
      top: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    };
  }

  const hunkRowIndexRef = useRef(hunkRowIndex);
  hunkRowIndexRef.current = hunkRowIndex;

  const layoutSignature = `${Object.keys(collapsed)
    .filter((k) => collapsed[k])
    .join(",")}|${[...expandedAnchors].join(",")}|${[...expandedFiles].join(",")}`;

  useEffect(() => {
    const target = anchorPos.current;
    anchorPos.current = null;
    if (!target) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    // A frame late: the virtualizer has to mount and measure the new rows
    // before their offsets mean anything.
    const raf = requestAnimationFrame(() => {
      const idx = hunkRowIndexRef.current.get(target.id);
      if (idx === undefined) return;
      const el = scroller.querySelector<HTMLElement>(`[data-index="${idx}"]`);
      if (!el) return;
      const now = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const drift = now - target.top;
      if (Math.abs(drift) > 1) scroller.scrollTop += drift;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature]);

  const scrollToHunk = useCallback(
    (id: string) => {
      const idx = hunkRowIndex.get(id);
      if (idx !== undefined) virtualizer.scrollToIndex(idx, { align: "start" });
    },
    [hunkRowIndex, virtualizer],
  );

  // Reset scroll when the shown set changes wholesale — unless the set changed
  // *because* a search match in it is being visited, in which case jumping to
  // the top would only be undone (noisily) a frame later.
  const setSignature = entries.map((e) => e.hunk.id).join(",");
  const activeMatchRef = useRef(activeMatch);
  activeMatchRef.current = activeMatch;
  useEffect(() => {
    const target = activeMatchRef.current;
    if (!(target && entries.some((e) => e.hunk.id === target.hunkId))) {
      scrollRef.current?.scrollTo({ top: 0 });
    }
    setExpandedDod(new Set());
    // Collapse is per hunk and per sitting; hunks that left the pane have no
    // state worth keeping. Comment expansion is keyed by file anchor, not by
    // hunk, so it deliberately survives — the reader comes back to it open.
    setCollapsedState((prev) => pruneCollapsed(prev, entries.map((e) => e.hunk.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSignature]);

  // Row heights change wholesale on a mode switch, so pixel scroll position is
  // meaningless afterwards: re-anchor on the focused hunk instead.
  const focusedRef = useRef(focusedHunkId);
  focusedRef.current = focusedHunkId;
  const lastMode = useRef<string | null>(null);
  useEffect(() => {
    const signature = `${mode}:${wrap}`;
    const prev = lastMode.current;
    lastMode.current = signature;
    if (prev === null || prev === signature) return; // first render / unrelated rerender
    // Horizontal offset is meaningless once wrapping is back on.
    if (wrap && scrollRef.current) scrollRef.current.scrollLeft = 0;
    splitScrollLeft.current = 0;
    const id = focusedRef.current;
    if (!id) return;
    const raf = requestAnimationFrame(() => scrollToHunk(id));
    return () => cancelAnimationFrame(raf);
  }, [mode, wrap, scrollToHunk]);

  // --- split + wrap off: the two halves scroll in lockstep ---
  // Independent scrolling would put line N's left side at column 0 and its
  // right side at column 80, which defeats the point of side-by-side; keeping
  // them synced means a horizontal move always compares like with like.
  const splitScrollLeft = useRef(0);
  const syncingHalves = useRef(false);

  /** Push `left` onto every half. Halves holding a short line clamp to their own
   *  maximum and echo that back as a scroll event; the flag keeps that echo from
   *  becoming the new shared offset and dragging every other half back left. */
  const syncHalves = useCallback((root: HTMLElement, left: number, except?: EventTarget | null) => {
    syncingHalves.current = true;
    for (const half of root.querySelectorAll<HTMLElement>(".diff-half")) {
      if (half !== except && half.scrollLeft !== left) half.scrollLeft = left;
    }
    // Scroll events fire earlier in the frame than rAF callbacks, so by here
    // every echo has been swallowed.
    requestAnimationFrame(() => {
      syncingHalves.current = false;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || wrap || mode !== "split") return;
    const onScroll = (e: Event) => {
      if (syncingHalves.current) return;
      const target = e.target as HTMLElement | null;
      if (!target?.classList?.contains("diff-half")) return;
      const left = target.scrollLeft;
      if (left === splitScrollLeft.current) return;
      splitScrollLeft.current = left;
      syncHalves(el, left, target);
    };
    el.addEventListener("scroll", onScroll, true);
    return () => el.removeEventListener("scroll", onScroll, true);
  }, [wrap, mode, syncHalves]);

  // Halves scrolled into view by the virtualizer mount at scrollLeft 0.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const left = splitScrollLeft.current;
    if (!el || wrap || mode !== "split" || !left) return;
    const stale = [...el.querySelectorAll<HTMLElement>(".diff-half")].some(
      (h) => h.scrollLeft !== left && h.scrollWidth - h.clientWidth >= left,
    );
    if (stale) syncHalves(el, left);
  });

  /* ------------------------------------------------- line-range selection */

  const [selection, setSelection] = useState<LineSelection | null>(null);
  const dragging = useRef(false);

  const startSelect = useCallback(
    (path: string, side: LineSide, line: number, shiftKey: boolean) => {
      dragging.current = true;
      setSelection((cur) =>
        // Shift extends the existing range, but only within the same file and
        // side — anything else starts fresh where the click landed.
        shiftKey && cur && cur.path === path && cur.side === side
          ? { ...cur, focus: line }
          : { path, side, anchor: line, focus: line },
      );
    },
    [],
  );

  const extendSelect = useCallback((path: string, side: LineSide, line: number) => {
    if (!dragging.current) return;
    setSelection((cur) =>
      cur && cur.path === path && cur.side === side ? { ...cur, focus: line } : cur,
    );
  }, []);

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // A selection describes lines that are on screen; anything that replaces the
  // shown set (or Escape) drops it.
  useEffect(() => {
    setSelection(null);
  }, [setSignature]);

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  const quoteSelection = () => {
    if (!selection || !onQuote) return;
    onQuote(lineRangeRef(selection.path, selection.side, selection.anchor, selection.focus));
    setSelection(null);
  };

  /** Keyboard navigation moves focus AND the viewport; clicks only focus. */
  const focusAndScroll = useCallback(
    (id: string) => {
      onFocusHunk(id);
      scrollToHunk(id);
    },
    [onFocusHunk, scrollToHunk],
  );

  /* ------------------------------------------------------ search navigation */

  const [flashKey, setFlashKey] = useState<string | null>(null);

  /** Virtual-row index of a hunk's unified line, in whichever mode is showing. */
  const findRowIndex = useCallback(
    (hunkId: string, lineIdx: number) => {
      if (mode === "split") {
        const entry = entries.find((e) => e.hunk.id === hunkId);
        if (!entry) return -1;
        const pairs = buildSplitRows(entry.hunk, detail.diff);
        const pairIdx = pairs.findIndex(
          (p) => p.left?.index === lineIdx || p.right?.index === lineIdx,
        );
        if (pairIdx === -1) return -1;
        return rows.findIndex(
          (r) => r.type === "split" && r.hunkId === hunkId && r.rowIdx === pairIdx,
        );
      }
      return rows.findIndex(
        (r) => r.type === "line" && r.hunkId === hunkId && r.lineIdx === lineIdx,
      );
    },
    [entries, detail.diff, mode, rows],
  );

  // Visiting a match: the host has already switched to the unit or file that
  // contains it, so by the time `rows` holds that hunk this runs again and
  // scrolls. A match outside the shown set simply finds nothing and waits.
  const matchKey = activeMatch
    ? `${activeMatch.hunkId}:${activeMatch.lineIdx}:${activeMatch.start}`
    : null;
  useEffect(() => {
    if (!activeMatch) {
      setFlashKey(null);
      return;
    }
    // A match inside a folded hunk is unreachable; unfold before looking.
    if (isCollapsed(collapsed, activeMatch.hunkId)) {
      setCollapsedState((prev) => setCollapsed(prev, activeMatch.hunkId, false));
      return;
    }
    const idx = findRowIndex(activeMatch.hunkId, activeMatch.lineIdx);
    if (idx === -1) return;
    onFocusHunk(activeMatch.hunkId);
    setFlashKey(rows[idx].key);
    // A frame late: the shown set may have just been replaced, and the
    // virtualizer has yet to measure the rows it mounted for it.
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(idx, { align: "center" }),
    );
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, findRowIndex, rows, virtualizer, onFocusHunk, collapsed]);

  useEffect(() => {
    if (!flashKey) return;
    const t = setTimeout(() => setFlashKey(null), 1100);
    return () => clearTimeout(t);
  }, [flashKey]);

  // "Go to definition" landed on a hunk already in this diff: scroll/focus it
  // instead of opening a popover. Mirrors the search-visit effect above, but
  // is its own mechanism — it must not entangle with an active search. Keyed
  // by `nonce` so re-requesting the same hunk (e.g. clicking the "in this
  // diff" marker for a candidate the reader already jumped to) still jumps.
  const jumpedNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!jumpToHunk || jumpedNonce.current === jumpToHunk.nonce) return;
    const idx = hunkRowIndex.get(jumpToHunk.hunkId);
    if (idx === undefined) return; // entries haven't caught up yet; effect reruns when they do
    jumpedNonce.current = jumpToHunk.nonce;
    onFocusHunk(jumpToHunk.hunkId);
    setFlashKey(rows[idx].key);
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(idx, { align: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [jumpToHunk, hunkRowIndex, rows, virtualizer, onFocusHunk]);

  /** Search hits on one rendered row, plus the active one if it lives here. */
  const marksFor = useCallback(
    (hunkId: string, lineIdx: number): LineMarks | undefined => {
      const ranges = searchMarks?.get(lineKey(hunkId, lineIdx));
      if (!ranges) return undefined;
      const active =
        activeMatch && activeMatch.hunkId === hunkId && activeMatch.lineIdx === lineIdx
          ? { start: activeMatch.start, end: activeMatch.end }
          : undefined;
      return { ranges, active };
    },
    [searchMarks, activeMatch],
  );

  // --- keyboard: j/k next/prev hunk, v toggle viewed, space next unviewed ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ids = entries.map((en) => en.hunk.id);
      if (!ids.length) return;
      const cur = focusedHunkId ? ids.indexOf(focusedHunkId) : -1;

      if (e.key === "j") {
        e.preventDefault();
        focusAndScroll(ids[Math.min(cur + 1, ids.length - 1)] ?? ids[0]);
      } else if (e.key === "k") {
        e.preventDefault();
        focusAndScroll(ids[Math.max(cur - 1, 0)] ?? ids[0]);
      } else if (e.key === "v") {
        if (!focusedHunkId) return;
        e.preventDefault();
        onToggleViewed(focusedHunkId, !detail.state.hunks[focusedHunkId]?.viewed);
      } else if (e.key === "d") {
        if (!onToggleViewMode) return;
        e.preventDefault();
        onToggleViewMode();
      } else if (e.key === "w") {
        if (!onToggleWrap) return;
        e.preventDefault();
        onToggleWrap();
      } else if (e.key === " ") {
        e.preventDefault();
        const start = cur + 1;
        const order = [...ids.slice(start), ...ids.slice(0, Math.max(start, 0))];
        const next = order.find((id) => !detail.state.hunks[id]?.viewed);
        if (next) focusAndScroll(next);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    entries,
    focusedHunkId,
    focusAndScroll,
    onToggleViewed,
    onToggleViewMode,
    onToggleWrap,
    detail.state.hunks,
  ]);

  if (!entries.length) {
    return (
      <div
        className="flex h-full items-center justify-center px-8 text-center text-sm"
        style={{ color: "var(--fg-faint)" }}
      >
        {emptyMessage}
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();

  const selectionCount = selection ? Math.abs(selection.focus - selection.anchor) + 1 : 0;

  return (
    <div className="relative flex h-full flex-col">
      {selection && onQuote ? (
        <div
          className="surface absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full px-2.5 py-1 elev-2"
          data-testid="quote-selection"
        >
          <span className="font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
            {selection.path.split("/").pop()}:{Math.min(selection.anchor, selection.focus)}
            {selectionCount > 1 ? `-${Math.max(selection.anchor, selection.focus)}` : ""}
            {selection.side === "old" ? " (old)" : ""}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="quote-selection-button"
            onClick={quoteSelection}
          >
            <IconQuote width={10} height={10} />
            quote in chat
          </button>
          <button
            type="button"
            className="text-2xs"
            style={{ color: "var(--fg-faint)" }}
            onClick={() => setSelection(null)}
            title="Clear the selection (esc)"
          >
            <IconClose width={10} height={10} />
          </button>
        </div>
      ) : null}
      <span
        ref={measureRef}
        aria-hidden
        className="pointer-events-none absolute font-mono opacity-0"
        style={{
          fontSize: "var(--code-font-size)",
          tabSize: "var(--tab-size)" as unknown as number,
          whiteSpace: "pre",
          top: -9999,
          left: -9999,
        }}
      >
        {"0".repeat(100)}
      </span>
      <div
        ref={scrollRef}
        data-diff-scroller=""
        className={`min-h-0 flex-1 overflow-auto${wrap ? "" : " diff-nowrap"}`}
        style={{ background: "var(--bg)" }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            minWidth: contentWidth || undefined,
          }}
        >
          {/* Full width so a horizontally scrolled (nowrap) pane never reads as
              "scrolled away" just because the sentinel slid off to the left. */}
          <div
            ref={pastTopRef}
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 w-full"
            style={{ height: COLLAPSE_PAST + 1 }}
          />
          <div
            ref={nearTopRef}
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 w-full"
            style={{ height: EXPAND_UNDER }}
          />
        {(() => {
          // The current headers render in-flow + sticky instead of absolute.
          // They are the lowest indexes in the range, so they are the first
          // children and their in-flow position is the container top — the
          // sticky offsets (0 for the file row, its height for the hunk row
          // below it) then pin them to the scrollport from there.
          //
          // "Engaged" gating: a header only switches to sticky once its own
          // slot has scrolled under the pin line. Without it, a header still
          // sitting visibly in place (say, below an expanded file-comments
          // block) would be yanked up to the pin position. The cascade is
          // consistent by construction: the hunk's pin line is the file
          // header's height only when the file header itself is engaged, and
          // an engaged hunk implies an engaged file above it.
          const sticky = stickyRef.current;
          const scrollTop = virtualizer.scrollOffset ?? 0;
          const fileVi =
            sticky.file !== undefined ? items.find((i) => i.index === sticky.file) : undefined;
          const fileEngaged = fileVi !== undefined && fileVi.start < scrollTop;
          const hunkPin = fileEngaged ? (fileVi?.size ?? 0) : 0;
          return items.map((vi) => {
          const row = rows[vi.index];
          const stickyTop =
            vi.index === sticky.file && fileEngaged
              ? 0
              : vi.index === sticky.hunk && vi.start - scrollTop < hunkPin
                ? hunkPin
                : null;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              data-flash={vi.key === flashKey ? "true" : undefined}
              data-sticky={stickyTop !== null ? "true" : undefined}
              ref={virtualizer.measureElement}
              style={
                stickyTop !== null
                  ? {
                      position: "sticky",
                      top: stickyTop,
                      zIndex: 3,
                      width: "100%",
                    }
                  : {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                    }
              }
            >
              {renderRow(row)}
            </div>
          );
          });
        })()}
        </div>
      </div>
    </div>
  );

  /** Every comment anchored to a line this hunk contains, in row order. */
  function commentsInHunk(entry: HunkEntry): DraftComment[] {
    const out: DraftComment[] = [];
    for (const r of buildRows(entry.hunk, detail.diff)) {
      const side = r.type === "del" ? "LEFT" : "RIGHT";
      const no = r.type === "del" ? r.oldNumber : r.newNumber;
      if (no === undefined) continue;
      const list = grouped.byLine.get(lineAnchor(entry.file.path, no, side));
      if (list) out.push(...list);
    }
    return out;
  }

  function renderRow(row: FlatRow) {
    if (row.type === "file") {
      const rollup = detail.state.files?.[row.path];
      const fileComments = grouped.byFile.get(row.path);
      return (
        <div
          className="flex items-center gap-2 border-y px-3 py-1.5 font-mono text-xs"
          style={{
            background: "var(--bg-raised)",
            borderColor: "var(--border)",
            color: "var(--fg)",
          }}
        >
          <span className="row-head-fixed flex min-w-0 items-center gap-2">
            <MiddleTruncate text={row.path} tail={18} />
            {row.file.status && row.file.status !== "modified" ? (
              <span
                className="chip"
                style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
              >
                {row.file.status}
              </span>
            ) : null}
            {rollup ? (
              <span
                className="flex-none text-2xs"
                style={{ color: rollup.viewed ? "var(--ok)" : "var(--fg-faint)" }}
              >
                {rollup.viewedHunks}/{rollup.totalHunks} viewed
              </span>
            ) : null}
          </span>
          <span className="ml-auto flex flex-none items-center gap-2">
            {fileComments ? (
              <CommentBubble
                comments={fileComments}
                expanded={expandedFiles.has(row.path)}
                onToggle={() => toggleFileComments(row.path)}
              />
            ) : null}
            <button
              type="button"
              data-testid={`add-file-comment-${row.path}`}
              className="btn"
              title={`Comment on ${row.path} as a whole`}
              onClick={(e) => {
                e.stopPropagation();
                onComment({ subjectType: "file", file: row.path });
              }}
            >
              + file
            </button>
            {onQuote ? (
              <QuoteButton
                title={`Ask Claude about ${row.path}`}
                onClick={() => onQuote({ kind: "file", path: row.path })}
              />
            ) : null}
            <span className="text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
              {row.file.additions !== undefined ? `+${row.file.additions}` : ""}{" "}
              {row.file.deletions !== undefined ? `−${row.file.deletions}` : ""}
            </span>
          </span>
        </div>
      );
    }

    if (row.type === "comments") {
      const list = grouped.byLine.get(row.anchor);
      if (!list?.length) return null;
      return (
        <InlineCommentList
          comments={list}
          label={`${row.path}:${row.line}${row.side === "LEFT" ? " (old)" : ""}`}
          onCollapse={() => toggleAnchor(row.anchor)}
          onAdd={() =>
            onComment({
              subjectType: "line",
              file: row.path,
              line: row.line,
              side: row.side,
            })
          }
          actions={commentActions ?? {}}
        />
      );
    }

    if (row.type === "filecomments") {
      const list = grouped.byFile.get(row.path);
      if (!list?.length) return null;
      return (
        <InlineCommentList
          comments={list}
          label={`${row.path} (whole file)`}
          onCollapse={() => toggleFileComments(row.path)}
          onAdd={() => onComment({ subjectType: "file", file: row.path })}
          actions={commentActions ?? {}}
        />
      );
    }

    if (row.type === "dod") {
      const st = detail.state.hunks[row.hunkId];
      return st ? <DiffOfDiffs prKey={detail.key} hunkId={row.hunkId} state={st} /> : null;
    }

    if (row.type === "hunk") {
      const st = detail.state.hunks[row.hunkId] ?? { viewed: false, changedSinceViewed: false };
      const focused = focusedHunkId === row.hunkId;
      const folded = isCollapsed(collapsed, row.hunkId);
      const lineCount = row.entry.hunk.lines?.length ?? buildRows(row.entry.hunk, detail.diff).length;
      // Folded, the hunk's own comments would vanish with its lines. Rolling
      // them up onto the header keeps them reachable — and clicking the bubble
      // unfolds, which is the only sensible place to read them.
      const inside = folded ? commentsInHunk(row.entry) : null;
      return (
        <div
          data-testid={`hunk-header-${row.hunkId}`}
          data-collapsed={folded ? "true" : "false"}
          className="flex cursor-pointer items-center gap-2 px-3 py-1"
          style={{
            // accent-soft is translucent; composite it over the inset ground
            // so a pinned focused header stays opaque with code beneath it.
            background: focused
              ? "linear-gradient(var(--accent-soft), var(--accent-soft)), var(--bg-inset)"
              : "var(--bg-inset)",
            borderLeft: `2px solid ${focused ? "var(--accent)" : "transparent"}`,
            color: "var(--fg-muted)",
          }}
          title="Focus this hunk (j/k)"
          onClick={() => onFocusHunk(row.hunkId)}
        >
          <span className="row-head-fixed flex min-w-0 items-center gap-2">
          <button
            type="button"
            data-testid={`hunk-toggle-${row.hunkId}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleHunkCollapsed(row.hunkId);
            }}
            title={folded ? "expand hunk" : "collapse hunk"}
            aria-label={folded ? "expand hunk" : "collapse hunk"}
            className="flex h-5 w-5 flex-none items-center justify-center rounded-sm transition-colors hover:opacity-80"
          >
            <IconChevron
              open={!folded}
              width={11}
              height={11}
              style={{ color: "var(--fg-faint)", flex: "none" }}
            />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleViewed(row.hunkId, !st.viewed);
            }}
            title={st.viewed ? "Mark as not viewed (v)" : "Mark as viewed (v)"}
            className="flex h-4 w-4 flex-none items-center justify-center rounded-sm border transition-colors"
            style={{
              borderColor: st.viewed ? "var(--ok)" : "var(--border-strong)",
              background: st.viewed ? "var(--ok)" : "transparent",
              color: "var(--bg)",
            }}
          >
            {st.viewed ? <IconCheck width={11} height={11} /> : null}
          </button>
          {onQuote ? (
            <QuoteButton
              title="Ask Claude about this hunk"
              onClick={() => onQuote({ kind: "hunk", id: row.hunkId, path: row.entry.file.path })}
            />
          ) : null}
          <span className="truncate font-mono text-2xs">{hunkLabel(row.entry.hunk)}</span>
          {folded ? (
            <span
              className="flex-none whitespace-nowrap text-2xs"
              data-testid="collapsed-hint"
              style={{ color: "var(--fg-faint)" }}
            >
              {lineCount} {lineCount === 1 ? "line" : "lines"} folded
            </span>
          ) : null}
          {inside?.length ? (
            <CommentBubble
              comments={inside}
              expanded={false}
              onToggle={() => toggleHunkCollapsed(row.hunkId)}
            />
          ) : null}
          {st.changedSinceViewed ? (
            <ChangedBadge
              onClick={() =>
                setExpandedDod((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.hunkId)) next.delete(row.hunkId);
                  else next.add(row.hunkId);
                  return next;
                })
              }
            />
          ) : null}
          {st.migration === "new" ? (
            <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              new
            </span>
          ) : null}
          {(() => {
            const hunkMoves = moves.get(row.hunkId);
            if (!hunkMoves || hunkMoves.counterparts.length === 0) return null;
            const hasOut = hunkMoves.counterparts.some((c) => c.direction === "out");
            const hasIn = hunkMoves.counterparts.some((c) => c.direction === "in");
            const arrow = hasOut && hasIn ? "↔" : hasOut ? "→" : "←";
            // First-occurrence counterpart names the badge; the title lists all of them.
            const label = baseName(hunkMoves.counterparts[0].path);
            const reachable = hunkMoves.counterparts.find((c) =>
              entries.some((en) => en.hunk.id === c.hunkId),
            );
            const title = hunkMoves.counterparts
              .map((c) => `${c.direction === "out" ? "moved to" : "moved from"} ${c.path}`)
              .join("; ");
            return (
              <button
                type="button"
                data-testid={`moved-badge-${row.hunkId}`}
                className="chip"
                style={{
                  background: "var(--moved-bg)",
                  color: "var(--moved-fg)",
                  cursor: reachable ? "pointer" : "default",
                }}
                title={title}
                onClick={(e) => {
                  e.stopPropagation();
                  if (reachable) onFocusHunk(reachable.hunkId);
                }}
              >
                moved {arrow} {label}
              </button>
            );
          })()}
          </span>
          <span className="ml-auto font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
            {row.hunkId.slice(0, 8)}
          </span>
        </div>
      );
    }

    if (row.type === "split") {
      const pair = buildSplitRows(row.entry.hunk, detail.diff)[row.rowIdx];
      if (!pair) return null;
      const path = row.entry.file.path;
      const hunkTokens = tokens[row.hunkId];
      const left = pair.left;
      const right = pair.right;
      // Left gutter is the old file, right is the new one. Context lines exist
      // on both sides but stay commentable on the new side only, matching
      // unified — GitHub anchors context comments to RIGHT too.
      const leftNo = left && left.row.type === "del" ? left.row.oldNumber : undefined;
      const rightNo = right ? right.row.newNumber : undefined;
      return (
        <SplitDiffLine
          left={left?.row ?? null}
          right={right?.row ?? null}
          leftTokens={left ? hunkTokens?.[left.index] : undefined}
          rightTokens={right ? hunkTokens?.[right.index] : undefined}
          marksLeft={left ? marksFor(row.hunkId, left.index) : undefined}
          marksRight={right ? marksFor(row.hunkId, right.index) : undefined}
          commentsLeft={
            leftNo === undefined ? undefined : grouped.byLine.get(lineAnchor(path, leftNo, "LEFT"))
          }
          commentsRight={
            rightNo === undefined
              ? undefined
              : grouped.byLine.get(lineAnchor(path, rightNo, "RIGHT"))
          }
          expandedLeft={
            leftNo !== undefined && expandedAnchors.has(lineAnchor(path, leftNo, "LEFT"))
          }
          expandedRight={
            rightNo !== undefined && expandedAnchors.has(lineAnchor(path, rightNo, "RIGHT"))
          }
          onToggleCommentsLeft={
            leftNo === undefined ? undefined : () => toggleAnchor(lineAnchor(path, leftNo, "LEFT"))
          }
          onToggleCommentsRight={
            rightNo === undefined
              ? undefined
              : () => toggleAnchor(lineAnchor(path, rightNo, "RIGHT"))
          }
          onCommentLeft={
            leftNo === undefined
              ? undefined
              : () => onComment({ subjectType: "line", file: path, line: leftNo, side: "LEFT" })
          }
          onCommentRight={
            rightNo === undefined
              ? undefined
              : () => onComment({ subjectType: "line", file: path, line: rightNo, side: "RIGHT" })
          }
          selectedLeft={inSelection(selection, path, "old", left?.row.oldNumber)}
          selectedRight={inSelection(selection, path, "new", right?.row.newNumber)}
          onSelectDown={
            onQuote ? (side, line, shift) => startSelect(path, side, line, shift) : undefined
          }
          onSelectEnter={onQuote ? (side, line) => extendSelect(path, side, line) : undefined}
          movedLeft={left ? movedAt(row.hunkId, row.entry.hunk, left.index, left.row.type) : false}
          movedRight={
            right ? movedAt(row.hunkId, row.entry.hunk, right.index, right.row.type) : false
          }
          onDefinitionClick={onDefinitionClick}
        />
      );
    }

    const lineRows = buildRows(row.entry.hunk, detail.diff);
    const line = lineRows[row.lineIdx];
    if (!line) return null;
    const side: "LEFT" | "RIGHT" = line.type === "del" ? "LEFT" : "RIGHT";
    const lineNo = line.type === "del" ? line.oldNumber : line.newNumber;
    const anchor = lineNo === undefined ? null : lineAnchor(row.entry.file.path, lineNo, side);
    return (
      <DiffLine
        row={line}
        tokens={tokens[row.hunkId]?.[row.lineIdx]}
        marks={marksFor(row.hunkId, row.lineIdx)}
        moved={movedAt(row.hunkId, row.entry.hunk, row.lineIdx, line.type)}
        comments={anchor ? grouped.byLine.get(anchor) : undefined}
        expanded={anchor ? expandedAnchors.has(anchor) : false}
        onToggleComments={anchor ? () => toggleAnchor(anchor) : undefined}
        onComment={
          lineNo === undefined
            ? undefined
            : () =>
                onComment({ subjectType: "line", file: row.entry.file.path, line: lineNo, side })
        }
        selectedOld={inSelection(selection, row.entry.file.path, "old", line.oldNumber)}
        selectedNew={inSelection(selection, row.entry.file.path, "new", line.newNumber)}
        onSelectDown={
          onQuote
            ? (s, l, shift) => startSelect(row.entry.file.path, s, l, shift)
            : undefined
        }
        onSelectEnter={onQuote ? (s, l) => extendSelect(row.entry.file.path, s, l) : undefined}
        onDefinitionClick={onDefinitionClick}
      />
    );
  }
}

/** Segmented unified / split control. Lives in the diff pane's own header. */
export function DiffViewToggle({
  mode,
  onChange,
}: {
  mode: DiffViewMode;
  onChange: (mode: DiffViewMode) => void;
}) {
  const options: { value: DiffViewMode; label: string; Icon: typeof IconUnified }[] = [
    { value: "unified", label: "unified", Icon: IconUnified },
    { value: "split", label: "split", Icon: IconSplit },
  ];
  return (
    <div
      role="group"
      aria-label="Diff view mode"
      className="inline-flex flex-none items-center rounded p-px"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
    >
      {options.map(({ value, label, Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            data-testid={`view-${value}`}
            aria-pressed={active}
            aria-label={`${label} view`}
            title={`${label} view · d`}
            onClick={() => onChange(value)}
            className="inline-flex flex-none items-center justify-center rounded-sm px-1.5 py-0.5 transition-colors"
            style={{
              background: active ? "var(--bg-raised)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-faint)",
              boxShadow: active ? "0 0 0 1px var(--border-strong)" : undefined,
            }}
          >
            <Icon width={13} height={13} />
          </button>
        );
      })}
    </div>
  );
}

/** Wrap on/off, styled to match the unified/split control it sits next to. */
export function WrapToggle({
  wrap,
  onChange,
}: {
  wrap: boolean;
  onChange: (wrap: boolean) => void;
}) {
  return (
    <div
      className="inline-flex flex-none items-center rounded p-px"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
    >
      <button
        type="button"
        data-testid="toggle-wrap"
        aria-pressed={wrap}
        aria-label="wrap long lines"
        title="wrap long lines · w"
        onClick={() => onChange(!wrap)}
        className="inline-flex flex-none items-center justify-center rounded-sm px-1.5 py-0.5 transition-colors"
        style={{
          background: wrap ? "var(--bg-raised)" : "transparent",
          color: wrap ? "var(--fg)" : "var(--fg-faint)",
          boxShadow: wrap ? "0 0 0 1px var(--border-strong)" : undefined,
        }}
      >
        <IconWrap width={13} height={13} />
      </button>
    </div>
  );
}

/** Quiet in-header note that side-by-side was downgraded for lack of room. */
export function NarrowPaneNote() {
  return (
    <span
      className="flex-none text-2xs"
      style={{ color: "var(--fg-faint)" }}
      title="The pane is too narrow for side-by-side, so this diff is shown unified. Close a panel or widen the window."
    >
      too narrow — unified
    </span>
  );
}

export function CommentIndicatorLegend() {
  return (
    <span className="inline-flex items-center gap-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
      <IconComment width={11} height={11} /> hover a line to draft
    </span>
  );
}
