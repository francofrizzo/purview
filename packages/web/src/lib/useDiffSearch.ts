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
  /** in reading order: the sidebar's units, or its files */
  matches: SearchMatch[];
  /** 0-based index of the current match, or -1 when there is none (no
   *  matches, or the cursor waits where the reader is: see `parked`) */
  index: number;
  /** No current match: the reader is somewhere without one. Next and previous
   *  go to the nearest match from there. */
  parked: boolean;
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

/**
 * `rank` orders hunks the way the reader walks them (the sidebar's units and
 * each unit's hunks as the pane lists them, or the files); matches follow it.
 * `here` is what the pane shows now: a new query starts there, and when the
 * reader moves somewhere else the cursor waits there instead of pulling them
 * back. Nothing here ever moves the reader on its own except next and previous.
 */
export function useDiffSearch(
  detail: PrDetail | undefined,
  units: ReviewUnit[],
  /** hunk ids the pane is currently showing; null disables the visible scope */
  here: Set<string> | null = null,
  /** a hunk's place in reading order; unknown hunks go last, in diff order */
  rank: ReadonlyMap<string, number> | null = null,
): DiffSearch {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  // Every line by default: a reader looking for a name wants to find it, and a
  // miss on changed lines alone reads as "not in this PR" when it may well be.
  const [changedOnly, setChangedOnly] = useState(false);
  const [scope, setScope] = useState<SearchScope>("visible");
  /** The current match by identity (`key`), and where in reading order the
   *  cursor is (`at`): with no current match, where it waits. */
  const [cursor, setCursor] = useState<{ key?: string; at: number } | null>(null);

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

  const allMatches = useMemo(() => {
    if (!searchIndex || !debounced) return [];
    const found = searchDiff(searchIndex, debounced, { caseSensitive, changedOnly });
    if (!rank) return found;
    // Stable: within a hunk, and among unranked hunks, diff order stands.
    const r = (m: SearchMatch) => rank.get(m.hunkId) ?? Number.MAX_SAFE_INTEGER;
    return found.map((m, i) => ({ m, i })).sort((a, b) => r(a.m) - r(b.m) || a.i - b.i).map((x) => x.m);
  }, [searchIndex, debounced, caseSensitive, changedOnly, rank]);

  // The visible scope is a post-filter over the full result set, so widening
  // to "all" is free and the per-file/unit counts always reflect the scope
  // the navigation actually cycles through.
  const matches = useMemo(
    () => (scope === "visible" && here ? allMatches.filter((m) => here.has(m.hunkId)) : allMatches),
    [allMatches, scope, here],
  );

  const rankOf = useCallback((hunkId: string) => rank?.get(hunkId) ?? Number.MAX_SAFE_INTEGER, [rank]);
  /** Where the pane is, in reading order: its first hunk. */
  const hereAt = useMemo(() => {
    let at = Number.MAX_SAFE_INTEGER;
    for (const id of here ?? []) at = Math.min(at, rankOf(id));
    return at;
  }, [here, rankOf]);

  // A new query (or option) lands on the first match where the reader is;
  // none there, it waits there rather than taking them to another unit.
  useEffect(() => {
    const first = matches.find((m) => here?.has(m.hunkId));
    setCursor(first ? { key: matchKey(first), at: rankOf(first.hunkId) } : { at: hereAt });
    // Only on a new result set for a new question, not on every recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, caseSensitive, changedOnly]);

  // The reader went somewhere else (the sidebar, a link): the cursor follows
  // them and waits there, instead of the next step pulling them back.
  const lastHere = useRef(here);
  useEffect(() => {
    if (lastHere.current === here) return;
    lastHere.current = here;
    setCursor((c) => {
      const m = c?.key ? matches.find((x) => matchKey(x) === c.key) : undefined;
      return m && here?.has(m.hunkId) ? c : { at: hereAt };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here]);

  const found = cursor?.key ? matches.findIndex((m) => matchKey(m) === cursor.key) : -1;
  // A current match that dropped out of the set (changed lines only, a
  // narrower scope) leaves the cursor where it was, not on the first match.
  const waitAt = cursor ? cursor.at : hereAt;

  const marksByLine = useMemo(() => matchRangesByLine(matches), [matches]);
  const fileCounts = useMemo(() => countsByFile(matches), [matches]);
  const unitCounts = useMemo(() => countsByUnit(matches, units), [matches, units]);

  const step = useCallback(
    (delta: 1 | -1) => {
      const n = matches.length;
      if (!n) return;
      let i: number;
      if (found >= 0) i = (found + delta + n) % n;
      else if (delta > 0) {
        i = matches.findIndex((m) => rankOf(m.hunkId) >= waitAt);
        if (i < 0) i = 0;
      } else {
        i = -1;
        matches.forEach((m, j) => {
          if (rankOf(m.hunkId) < waitAt) i = j;
        });
        if (i < 0) i = n - 1;
      }
      setCursor({ key: matchKey(matches[i]), at: rankOf(matches[i].hunkId) });
    },
    [matches, found, waitAt, rankOf],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setDebounced("");
  }, []);

  const current = found >= 0 ? matches[found] : null;

  return {
    open,
    query,
    activeQuery: debounced,
    caseSensitive,
    changedOnly,
    scope,
    setScope,
    matches,
    index: found,
    parked: found < 0 && matches.length > 0,
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
