/**
 * Search state for the diff pane. Ephemeral by design: nothing here is
 * persisted, and closing the bar throws the query away.
 *
 * The index is built lazily — the first time the bar opens for a revision —
 * and memoized on the parsed files, so re-opening or retyping never rebuilds
 * it. The query itself is debounced, so a fast typist runs one pass, not ten.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PrDetail, ReviewUnit } from "../api/types";
import type { CharRange } from "./diffModel";
import {
  buildSearchIndex,
  countsByFile,
  countsByUnit,
  matchRangesByLine,
  searchDiff,
  type SearchMatch,
} from "./diffSearch";

export const SEARCH_DEBOUNCE_MS = 150;

/** Where a search looks: what the pane currently shows, or the whole diff. */
export type SearchScope = "visible" | "all";

export interface DiffSearch {
  open: boolean;
  query: string;
  /** the query the results actually reflect (post-debounce) */
  activeQuery: string;
  caseSensitive: boolean;
  changedOnly: boolean;
  scope: SearchScope;
  setScope: (s: SearchScope) => void;
  matches: SearchMatch[];
  /** 0-based index of the current match, or -1 when there are none */
  index: number;
  current: SearchMatch | null;
  marksByLine: Map<string, CharRange[]>;
  fileCounts: Map<string, number>;
  unitCounts: Map<string, number>;
  setQuery: (q: string) => void;
  setCaseSensitive: (v: boolean) => void;
  setChangedOnly: (v: boolean) => void;
  openSearch: (scope?: SearchScope) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
}

/** A match's identity across recomputes of the result set. */
function matchKey(m: SearchMatch): string {
  return `${m.hunkId}:${m.lineIdx}:${m.side}:${m.start}`;
}

export function useDiffSearch(
  detail: PrDetail | undefined,
  units: ReviewUnit[],
  /** hunk ids the pane is currently showing; null disables the visible scope */
  visibleHunkIds: Set<string> | null = null,
): DiffSearch {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [changedOnly, setChangedOnly] = useState(true);
  const [scope, setScope] = useState<SearchScope>("visible");
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (query === debounced) return;
    // Clearing is instant: there is nothing to compute, and the marks should go.
    if (!query) {
      setDebounced("");
      return;
    }
    const t = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, debounced]);

  const searchIndex = useMemo(
    () => (open && detail ? buildSearchIndex(detail.files, detail.diff) : null),
    [open, detail],
  );

  const allMatches = useMemo(
    () =>
      searchIndex && debounced
        ? searchDiff(searchIndex, debounced, { caseSensitive, changedOnly })
        : [],
    [searchIndex, debounced, caseSensitive, changedOnly],
  );

  // The visible scope is a post-filter over the full result set, so widening
  // to "all" is free and the per-file/unit counts always reflect the scope
  // the navigation actually cycles through.
  const matches = useMemo(
    () =>
      scope === "visible" && visibleHunkIds
        ? allMatches.filter((m) => visibleHunkIds.has(m.hunkId))
        : allMatches,
    [allMatches, scope, visibleHunkIds],
  );

  // The result set is recomputed not only when the query changes but whenever
  // the visible rows do — a comment composer closing, a hunk toggling viewed —
  // and resetting to the first match on every recompute yanked the reader
  // across the diff for no reason. Stay on the match they were on whenever it
  // survives; only a set that no longer contains it starts over.
  const currentKey = useRef<string | null>(null);
  useEffect(() => {
    const prev = currentKey.current;
    const at = prev === null ? -1 : matches.findIndex((m) => matchKey(m) === prev);
    setIndex(at >= 0 ? at : 0);
  }, [matches]);

  const marksByLine = useMemo(() => matchRangesByLine(matches), [matches]);
  const fileCounts = useMemo(() => countsByFile(matches), [matches]);
  const unitCounts = useMemo(() => countsByUnit(matches, units), [matches, units]);

  const step = useCallback(
    (delta: number) =>
      setIndex((i) => {
        const n = matches.length;
        if (!n) return 0;
        return (((i + delta) % n) + n) % n;
      }),
    [matches.length],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setDebounced("");
  }, []);

  const current = matches.length ? (matches[Math.min(index, matches.length - 1)] ?? null) : null;
  // Recorded after the reset effect above has read it, so a recompute sees
  // the match that was current before it, not the interim one.
  useEffect(() => {
    currentKey.current = current ? matchKey(current) : null;
  }, [current]);

  return {
    open,
    query,
    activeQuery: debounced,
    caseSensitive,
    changedOnly,
    scope,
    setScope,
    matches,
    index: matches.length ? Math.min(index, matches.length - 1) : -1,
    current,
    marksByLine,
    fileCounts,
    unitCounts,
    setQuery,
    setCaseSensitive,
    setChangedOnly,
    openSearch: useCallback((s?: SearchScope) => {
      if (s) setScope(s);
      setOpen(true);
    }, []),
    close,
    next: useCallback(() => step(1), [step]),
    prev: useCallback(() => step(-1), [step]),
  };
}
