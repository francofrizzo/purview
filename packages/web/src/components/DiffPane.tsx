import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DraftComment, FileEntry, Hunk, PrDetail } from "../api/types";
import { buildRows } from "../lib/diffModel";
import { useTokensForHunks } from "../lib/useHunkTokens";
import { useTheme } from "../lib/useTheme";
import { ChangedBadge } from "./Chips";
import { DiffLine } from "./DiffLine";
import { DiffOfDiffs } from "./DiffOfDiffs";
import { IconCheck, IconComment } from "./icons";

export interface HunkEntry {
  hunk: Hunk;
  file: FileEntry;
}

type FlatRow =
  | { type: "file"; key: string; path: string; file: FileEntry }
  | { type: "hunk"; key: string; hunkId: string; entry: HunkEntry }
  | { type: "dod"; key: string; hunkId: string }
  | { type: "line"; key: string; hunkId: string; entry: HunkEntry; lineIdx: number };

export interface DiffPaneProps {
  detail: PrDetail;
  entries: HunkEntry[];
  drafts: DraftComment[];
  focusedHunkId: string | null;
  onFocusHunk: (id: string | null) => void;
  onToggleViewed: (hunkId: string, viewed: boolean) => void;
  onComment: (input: { file: string; line: number; side: "LEFT" | "RIGHT" }) => void;
  emptyMessage?: string;
}

export function DiffPane({
  detail,
  entries,
  drafts,
  focusedHunkId,
  onFocusHunk,
  onToggleViewed,
  onComment,
  emptyMessage = "Nothing to show.",
}: DiffPaneProps) {
  const theme = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedDod, setExpandedDod] = useState<Set<string>>(new Set());

  const hunks = useMemo(() => entries.map((e) => e.hunk), [entries]);
  const tokens = useTokensForHunks(hunks, detail.diff, theme);

  const draftsByLine = useMemo(() => {
    const s = new Set<string>();
    for (const d of drafts) s.add(`${d.file}:${d.line}:${d.side}`);
    return s;
  }, [drafts]);

  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    let lastFile: string | null = null;
    for (const entry of entries) {
      const { hunk, file } = entry;
      if (file.path !== lastFile) {
        out.push({ type: "file", key: `f:${file.path}:${hunk.id}`, path: file.path, file });
        lastFile = file.path;
      }
      out.push({ type: "hunk", key: `h:${hunk.id}`, hunkId: hunk.id, entry });
      if (expandedDod.has(hunk.id)) {
        out.push({ type: "dod", key: `d:${hunk.id}`, hunkId: hunk.id });
      }
      const lines = buildRows(hunk, detail.diff);
      for (let i = 0; i < lines.length; i++) {
        out.push({ type: "line", key: `l:${hunk.id}:${i}`, hunkId: hunk.id, entry, lineIdx: i });
      }
    }
    return out;
  }, [entries, detail.diff, expandedDod]);

  const hunkRowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.type === "hunk" && !m.has(r.hunkId)) m.set(r.hunkId, i);
    });
    return m;
  }, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.type === "line") return 20;
      if (r.type === "dod") return 170;
      return 34;
    },
    overscan: 30,
    getItemKey: (i) => rows[i].key,
  });

  const scrollToHunk = useCallback(
    (id: string) => {
      const idx = hunkRowIndex.get(id);
      if (idx !== undefined) virtualizer.scrollToIndex(idx, { align: "start" });
    },
    [hunkRowIndex, virtualizer],
  );

  // Reset scroll when the shown set changes wholesale.
  const setSignature = entries.map((e) => e.hunk.id).join(",");
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setExpandedDod(new Set());
  }, [setSignature]);

  /** Keyboard navigation moves focus AND the viewport; clicks only focus. */
  const focusAndScroll = useCallback(
    (id: string) => {
      onFocusHunk(id);
      scrollToHunk(id);
    },
    [onFocusHunk, scrollToHunk],
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
  }, [entries, focusedHunkId, focusAndScroll, onToggleViewed, detail.state.hunks]);

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

  return (
    <div ref={scrollRef} className="h-full overflow-auto" style={{ background: "var(--bg)" }}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((vi) => {
          const row = rows[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    </div>
  );

  function renderRow(row: FlatRow) {
    if (row.type === "file") {
      const rollup = detail.state.files?.[row.path];
      return (
        <div
          className="flex items-center gap-2 border-y px-3 py-1.5 font-mono text-xs"
          style={{
            background: "var(--bg-raised)",
            borderColor: "var(--border)",
            color: "var(--fg)",
          }}
        >
          <span className="truncate">{row.path}</span>
          {row.file.status && row.file.status !== "modified" ? (
            <span className="chip" style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}>
              {row.file.status}
            </span>
          ) : null}
          {rollup ? (
            <span className="text-2xs" style={{ color: rollup.viewed ? "var(--ok)" : "var(--fg-faint)" }}>
              {rollup.viewedHunks}/{rollup.totalHunks} viewed
            </span>
          ) : null}
          <span className="ml-auto text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
            {row.file.additions !== undefined ? `+${row.file.additions}` : ""}{" "}
            {row.file.deletions !== undefined ? `−${row.file.deletions}` : ""}
          </span>
        </div>
      );
    }

    if (row.type === "dod") {
      const st = detail.state.hunks[row.hunkId];
      return st ? <DiffOfDiffs state={st} /> : null;
    }

    if (row.type === "hunk") {
      const st = detail.state.hunks[row.hunkId] ?? { viewed: false, changedSinceViewed: false };
      const focused = focusedHunkId === row.hunkId;
      return (
        <div
          className="flex items-center gap-2 px-3 py-1"
          style={{
            background: focused ? "var(--accent-soft)" : "var(--bg-inset)",
            borderLeft: `2px solid ${focused ? "var(--accent)" : "transparent"}`,
            color: "var(--fg-muted)",
          }}
          onClick={() => onFocusHunk(row.hunkId)}
        >
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
          <span className="truncate font-mono text-2xs">{row.entry.hunk.header}</span>
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
          <span className="ml-auto font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
            {row.hunkId.slice(0, 8)}
          </span>
        </div>
      );
    }

    const lineRows = buildRows(row.entry.hunk, detail.diff);
    const line = lineRows[row.lineIdx];
    if (!line) return null;
    const side = line.type === "del" ? "LEFT" : "RIGHT";
    const lineNo = line.type === "del" ? line.oldNumber : line.newNumber;
    const hasComment =
      lineNo !== undefined && draftsByLine.has(`${row.entry.file.path}:${lineNo}:${side}`);
    return (
      <DiffLine
        row={line}
        tokens={tokens[row.hunkId]?.[row.lineIdx]}
        hasComment={hasComment}
        onComment={
          lineNo === undefined
            ? undefined
            : () => onComment({ file: row.entry.file.path, line: lineNo, side })
        }
      />
    );
  }
}

export function CommentIndicatorLegend() {
  return (
    <span className="inline-flex items-center gap-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
      <IconComment width={11} height={11} /> hover a line to draft
    </span>
  );
}
