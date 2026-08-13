/**
 * Search state for the diff pane. Ephemeral by design: nothing here is
 * persisted, and closing the bar throws the query away.
 *
 * The index is built lazily — the first time the bar opens for a revision —
 * and memoized on the parsed files, so re-opening or retyping never rebuilds
 * it. The query itself is debounced, so a fast typist runs one pass, not ten.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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

export interface DiffSearch {
  open: boolean;
  query: string;
  /** the query the results actually reflect (post-debounce) */
  activeQuery: string;
  caseSensitive: boolean;
  changedOnly: boolean;
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
  openSearch: () => void;
  close: () => void;
  next: () => void;
  prev: () => void;
}

export function useDiffSearch(detail: PrDetail | undefined, units: ReviewUnit[]): DiffSearch {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [changedOnly, setChangedOnly] = useState(true);
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

  const matches = useMemo(
    () =>
      searchIndex && debounced
        ? searchDiff(searchIndex, debounced, { caseSensitive, changedOnly })
        : [],
    [searchIndex, debounced, caseSensitive, changedOnly],
  );

  // Any change to the result set starts the cycle over at the first match.
  useEffect(() => {
    setIndex(0);
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

  return {
    open,
    query,
    activeQuery: debounced,
    caseSensitive,
    changedOnly,
    matches,
    index: matches.length ? Math.min(index, matches.length - 1) : -1,
    current,
    marksByLine,
    fileCounts,
    unitCounts,
    setQuery,
    setCaseSensitive,
    setChangedOnly,
    openSearch: useCallback(() => setOpen(true), []),
    close,
    next: useCallback(() => step(1), [step]),
    prev: useCallback(() => step(-1), [step]),
  };
}
