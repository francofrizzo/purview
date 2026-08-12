import { useEffect, useMemo, useState } from "react";
import { cachedTokens, tokenizeLines, type ThemeName, type Tok } from "./highlight";
import { buildRows, languageFor, type DiffRow } from "./diffModel";
import type { Hunk } from "../api/types";

/**
 * Tokenize a hunk's lines with shiki. Returns null until (or unless) the
 * grammar loads — callers render plain text in the meantime.
 */
export function useHunkTokens(
  hunkId: string,
  rows: DiffRow[],
  lang: string | null,
  theme: ThemeName,
): Tok[][] | null {
  const [tokens, setTokens] = useState<Tok[][] | null>(() =>
    lang ? (cachedTokens(hunkId, lang, theme) ?? null) : null,
  );

  useEffect(() => {
    if (!lang) {
      setTokens(null);
      return;
    }
    const hit = cachedTokens(hunkId, lang, theme);
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
  theme: ThemeName,
): TokenMap {
  const signature = hunks.map((h) => h.id).join(",");
  const [map, setMap] = useState<TokenMap>({});

  const jobs = useMemo(
    () =>
      hunks.map((h) => ({
        id: h.id,
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
      const hit = cachedTokens(j.id, j.lang, theme);
      if (hit) seeded[j.id] = hit;
    }
    setMap(seeded);

    for (const j of jobs) {
      if (!j.lang || seeded[j.id]) continue;
      const code = j.rows.map((r) => r.content).join("\n");
      void tokenizeLines(j.id, code, j.lang, theme).then((t) => {
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
