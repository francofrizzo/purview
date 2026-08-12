/**
 * Lazy shiki wrapper. Nothing is loaded until a hunk is actually rendered;
 * unknown or unsupported languages silently fall back to plain text, and so
 * does a theme shiki refuses to load.
 */

import type { RawTheme } from "./themes";

export interface Tok {
  content: string;
  color?: string;
}

/** A theme shiki can tokenize with: a bundled id, or a hand-authored object. */
export interface ShikiTheme {
  name: string;
  raw?: RawTheme;
}

type Highlighter = {
  codeToTokensBase: (code: string, options: { lang: string; theme: string }) => Tok[][];
  getLoadedLanguages: () => string[];
  loadLanguage: (lang: string) => Promise<void>;
  loadTheme: (theme: string | RawTheme) => Promise<void>;
  getLoadedThemes: () => string[];
};

let highlighterPromise: Promise<Highlighter | null> | null = null;
const loadingLangs = new Map<string, Promise<boolean>>();
const loadingThemes = new Map<string, Promise<boolean>>();
const failedLangs = new Set<string>();
const failedThemes = new Set<string>();

async function getHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const mod: any = await import("shiki");
        const create = mod.createHighlighter ?? mod.getHighlighter ?? mod.getSingletonHighlighter;
        if (!create) return null;
        // Themes and grammars are both loaded on demand.
        return (await create({ themes: [], langs: [] })) as Highlighter;
      } catch {
        return null;
      }
    })();
  }
  return highlighterPromise;
}

/** Ensure a language grammar is loaded. Resolves false when unsupported. */
export async function ensureLanguage(lang: string): Promise<boolean> {
  if (failedLangs.has(lang)) return false;
  const existing = loadingLangs.get(lang);
  if (existing) return existing;
  const p = (async () => {
    const hl = await getHighlighter();
    if (!hl) return false;
    if (hl.getLoadedLanguages().includes(lang)) return true;
    try {
      await hl.loadLanguage(lang as string);
      return true;
    } catch {
      failedLangs.add(lang);
      return false;
    }
  })();
  loadingLangs.set(lang, p);
  return p;
}

/** Ensure a theme is registered. Custom themes are loaded from their object. */
export async function ensureTheme(theme: ShikiTheme): Promise<boolean> {
  if (failedThemes.has(theme.name)) return false;
  const existing = loadingThemes.get(theme.name);
  if (existing) return existing;
  const p = (async () => {
    const hl = await getHighlighter();
    if (!hl) return false;
    if (hl.getLoadedThemes().includes(theme.name)) return true;
    try {
      await hl.loadTheme(theme.raw ?? theme.name);
      return true;
    } catch {
      failedThemes.add(theme.name);
      return false;
    }
  })();
  loadingThemes.set(theme.name, p);
  return p;
}

/**
 * Token cache, keyed by hunk + language + theme. Switching themes therefore
 * repopulates rather than reusing stale colors; the bound keeps a long session
 * of theme-hopping from growing without limit (oldest entries are evicted).
 */
const MAX_CACHE_ENTRIES = 600;
const tokenCache = new Map<string, Tok[][]>();

function cacheKeyFor(cacheKey: string, lang: string, theme: string) {
  return `${cacheKey}:${lang}:${theme}`;
}

function cacheSet(key: string, value: Tok[][]) {
  tokenCache.set(key, value);
  while (tokenCache.size > MAX_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next();
    if (oldest.done) break;
    tokenCache.delete(oldest.value);
  }
}

/** Test/debug hook. */
export function tokenCacheSize(): number {
  return tokenCache.size;
}

/**
 * Tokenize a whole hunk body at once (cheap, and keeps multi-line constructs
 * coherent). Returns null when highlighting is unavailable.
 */
export async function tokenizeLines(
  cacheKey: string,
  code: string,
  lang: string,
  theme: ShikiTheme,
): Promise<Tok[][] | null> {
  const key = cacheKeyFor(cacheKey, lang, theme.name);
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const [langOk, themeOk] = await Promise.all([ensureLanguage(lang), ensureTheme(theme)]);
  if (!langOk || !themeOk) return null;
  const hl = await getHighlighter();
  if (!hl) return null;
  try {
    const tokens = hl.codeToTokensBase(code, { lang, theme: theme.name });
    cacheSet(key, tokens);
    return tokens;
  } catch {
    failedLangs.add(lang);
    return null;
  }
}

export function cachedTokens(
  cacheKey: string,
  lang: string,
  theme: string,
): Tok[][] | undefined {
  return tokenCache.get(cacheKeyFor(cacheKey, lang, theme));
}
