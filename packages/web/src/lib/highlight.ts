/**
 * Lazy shiki wrapper. Nothing is loaded until a hunk is actually rendered;
 * unknown or unsupported languages silently fall back to plain text.
 */

export interface Tok {
  content: string;
  color?: string;
}

type Highlighter = {
  codeToTokensBase: (code: string, options: { lang: string; theme: string }) => Tok[][];
  getLoadedLanguages: () => string[];
  loadLanguage: (lang: string) => Promise<void>;
  loadTheme: (theme: string) => Promise<void>;
  getLoadedThemes: () => string[];
};

export const THEMES = { dark: "github-dark", light: "github-light" } as const;
export type ThemeName = keyof typeof THEMES;

let highlighterPromise: Promise<Highlighter | null> | null = null;
const loading = new Map<string, Promise<boolean>>();
const failedLangs = new Set<string>();

async function getHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const mod: any = await import("shiki");
        const create = mod.createHighlighter ?? mod.getHighlighter ?? mod.getSingletonHighlighter;
        if (!create) return null;
        return (await create({
          themes: [THEMES.dark, THEMES.light],
          langs: [],
        })) as Highlighter;
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
  const existing = loading.get(lang);
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
  loading.set(lang, p);
  return p;
}

const tokenCache = new Map<string, Tok[][]>();

/**
 * Tokenize a whole hunk body at once (cheap, and keeps multi-line constructs
 * coherent). Returns null when highlighting is unavailable.
 */
export async function tokenizeLines(
  cacheKey: string,
  code: string,
  lang: string,
  theme: ThemeName,
): Promise<Tok[][] | null> {
  const key = `${cacheKey}:${lang}:${theme}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const ok = await ensureLanguage(lang);
  if (!ok) return null;
  const hl = await getHighlighter();
  if (!hl) return null;
  try {
    const tokens = hl.codeToTokensBase(code, { lang, theme: THEMES[theme] });
    tokenCache.set(key, tokens);
    return tokens;
  } catch {
    failedLangs.add(lang);
    return null;
  }
}

export function cachedTokens(
  cacheKey: string,
  lang: string,
  theme: ThemeName,
): Tok[][] | undefined {
  return tokenCache.get(`${cacheKey}:${lang}:${theme}`);
}
