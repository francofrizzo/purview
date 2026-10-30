import { useEffect, useMemo, useState } from "react";
import { cachedTokens, tokenizeLines, type ShikiTheme, type Tok } from "./highlight";
import { buildRows, hunkRenderKey, languageFor, type DiffRow } from "./diffModel";
import type { Hunk } from "../api/types";

/**
 * Tokenize a hunk's lines with shiki. Returns null until (or unless) the
 * grammar loads — callers render plain text in the meantime.
 */
export function useHunkTokens(
  hunkId: string,
  rows: DiffRow[],
  lang: string | null,
  theme: ShikiTheme,
): Tok[][] | null {
  const [tokens, setTokens] = useState<Tok[][] | null>(() =>
    lang ? (cachedTokens(hunkId, lang, theme.name) ?? null) : null,
  );

  useEffect(() => {
    if (!lang) {
      setTokens(null);
      return;
    }
    const hit = cachedTokens(hunkId, lang, theme.name);
    if (hit) {
      setTokens(hit);
      return;
    }
    let alive = true;
    const code = rows.map((r) => r.content).join("\n");
    void tokenizeLines(hunkId, code, lang, theme).then((t) => {
      if (alive) setTokens(t);
    });
    return () => {
      alive = false;
    };
    // rows are derived from hunkId and are stable (module-cached)
  }, [hunkId, lang, theme, rows]);

  return tokens;
}

export type TokenMap = Record<string, Tok[][] | null>;

/**
 * Tokenize a set of hunks (a unit, or a file) in parallel. Results stream in;
 * lines render as plain text until their grammar resolves.
 */
export function useTokensForHunks(
  hunks: Hunk[],
  diffText: string,
  theme: ShikiTheme,
): TokenMap {
  // Render keys, not ids: a hunk a new revision moved keeps its id, and its
  // tokens are cached under where it sits as well (see hunkRenderKey).
  const signature = hunks.map(hunkRenderKey).join(",");
  const [map, setMap] = useState<TokenMap>({});

  const jobs = useMemo(
    () =>
      hunks.map((h) => ({
        id: h.id,
        cacheKey: hunkRenderKey(h),
        lang: languageFor(h.file),
        rows: buildRows(h, diffText),
      })),
    // signature covers the hunk identity set; diffText is stable per revision
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, diffText],
  );

  useEffect(() => {
    let alive = true;
    const seeded: TokenMap = {};
    for (const j of jobs) {
      if (!j.lang) continue;
      const hit = cachedTokens(j.cacheKey, j.lang, theme.name);
      if (hit) seeded[j.id] = hit;
    }
    setMap(seeded);

    for (const j of jobs) {
      if (!j.lang || seeded[j.id]) continue;
      const code = j.rows.map((r) => r.content).join("\n");
      void tokenizeLines(j.cacheKey, code, j.lang, theme).then((t) => {
        if (!alive || !t) return;
        setMap((prev) => ({ ...prev, [j.id]: t }));
      });
    }
    return () => {
      alive = false;
    };
  }, [jobs, theme]);

  return map;
}
