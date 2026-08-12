/**
 * Central preferences store.
 *
 * One typed object under one localStorage key, exposed through context. Parsing
 * is migration-tolerant: unknown keys are dropped, missing/invalid ones fall
 * back to their default, and nothing here ever throws — a corrupt value must
 * never keep the app from rendering. Standalone preferences that predate this
 * store (`reviewer.diffViewMode`, `reviewer.diffWrap`) are folded in on first
 * load so an existing user keeps their choices.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_THEME_ID,
  resolveTheme,
  tokensFor,
  type ChromeTokens,
  type ThemeDef,
} from "./themes";

export type DiffViewMode = "unified" | "split";

export interface Settings {
  /** Theme id, or "system" to follow prefers-color-scheme (the default). */
  themeId: string;
  /** Font family name for code/diff areas. Empty = the built-in mono stack. */
  codeFont: string;
  /** Use the code font for the UI chrome too. */
  useCodeFontForUi: boolean;
  /** Code font size in px (clamped to 11–16). */
  codeFontSize: number;
  /** Tab width in the diff. */
  tabSize: 2 | 4 | 8;
  diffViewMode: DiffViewMode;
  diffWrap: boolean;
}

export const SETTINGS_KEY = "reviewer.settings";
export const LEGACY_VIEW_MODE_KEY = "reviewer.diffViewMode";
export const LEGACY_WRAP_KEY = "reviewer.diffWrap";

export const CODE_FONT_FALLBACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const UI_FONT_FALLBACK =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export const MIN_CODE_FONT_SIZE = 11;
export const MAX_CODE_FONT_SIZE = 16;
export const TAB_SIZES = [2, 4, 8] as const;

export const DEFAULT_SETTINGS: Settings = {
  themeId: DEFAULT_THEME_ID,
  codeFont: "",
  useCodeFontForUi: false,
  codeFontSize: 12,
  tabSize: 8,
  diffViewMode: "unified",
  diffWrap: true,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Coerce arbitrary parsed JSON into a complete Settings object.
 * `legacy` supplies values for keys the stored object doesn't have yet.
 */
export function parseSettings(raw: unknown, legacy: Partial<Settings> = {}): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, ...pickValid(legacy) };
  if (!isRecord(raw)) return base;
  return { ...base, ...pickValid(raw) };
}

/** Keep only keys we know, with values of the right shape. */
function pickValid(raw: Record<string, unknown> | Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const r = raw as Record<string, unknown>;

  if (typeof r.themeId === "string" && r.themeId.trim()) out.themeId = r.themeId.trim();
  if (typeof r.codeFont === "string") out.codeFont = r.codeFont.trim();
  if (typeof r.useCodeFontForUi === "boolean") out.useCodeFontForUi = r.useCodeFontForUi;
  if (typeof r.codeFontSize === "number" && Number.isFinite(r.codeFontSize)) {
    out.codeFontSize = Math.min(
      MAX_CODE_FONT_SIZE,
      Math.max(MIN_CODE_FONT_SIZE, Math.round(r.codeFontSize)),
    );
  }
  if (r.tabSize === 2 || r.tabSize === 4 || r.tabSize === 8) out.tabSize = r.tabSize;
  if (r.diffViewMode === "unified" || r.diffViewMode === "split") out.diffViewMode = r.diffViewMode;
  if (typeof r.diffWrap === "boolean") out.diffWrap = r.diffWrap;
  return out;
}

/** Values carried over from the pre-store standalone keys. */
export function readLegacySettings(storage: Pick<Storage, "getItem"> | null): Partial<Settings> {
  if (!storage) return {};
  const out: Partial<Settings> = {};
  try {
    const mode = storage.getItem(LEGACY_VIEW_MODE_KEY);
    if (mode === "split" || mode === "unified") out.diffViewMode = mode;
    const wrap = storage.getItem(LEGACY_WRAP_KEY);
    if (wrap === "off") out.diffWrap = false;
    else if (wrap === "on") out.diffWrap = true;
  } catch {
    /* storage disabled — defaults are fine */
  }
  return out;
}

export function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  const legacy = readLegacySettings(localStorage);
  let raw: unknown = null;
  try {
    const text = localStorage.getItem(SETTINGS_KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    /* unreadable or malformed — fall through to defaults */
  }
  return parseSettings(raw, legacy);
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    // Keep the legacy keys aligned so an older tab (or a rollback) still sees
    // the current choice rather than silently reverting to defaults.
    localStorage.setItem(LEGACY_VIEW_MODE_KEY, settings.diffViewMode);
    localStorage.setItem(LEGACY_WRAP_KEY, settings.diffWrap ? "on" : "off");
  } catch {
    /* private mode / storage disabled — keep the in-memory preference */
  }
}

/** CSS generic families must stay unquoted to keep their meaning. */
const GENERIC_FAMILIES = new Set([
  "monospace",
  "sans-serif",
  "serif",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
  "ui-rounded",
]);

/** Quote a family name (unless generic), then append the fallback chain. */
export function fontStack(family: string, fallback: string): string {
  // Quotes/backslashes/semicolons would let a family name escape the declaration.
  const name = family.replace(/["\\;]/g, "").trim();
  if (!name) return fallback;
  if (GENERIC_FAMILIES.has(name.toLowerCase())) return `${name}, ${fallback}`;
  return `"${name}", ${fallback}`;
}

export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.66);
}

export interface ResolvedAppearance {
  theme: ThemeDef;
  tokens: ChromeTokens;
  codeFont: string;
  uiFont: string;
  codeFontSize: number;
  codeLineHeight: number;
  tabSize: number;
}

export function resolveAppearance(settings: Settings, prefersLight: boolean): ResolvedAppearance {
  const theme = resolveTheme(settings.themeId, prefersLight);
  const codeFont = fontStack(settings.codeFont, CODE_FONT_FALLBACK);
  return {
    theme,
    tokens: tokensFor(theme),
    codeFont,
    uiFont: settings.useCodeFontForUi ? codeFont : UI_FONT_FALLBACK,
    codeFontSize: settings.codeFontSize,
    codeLineHeight: lineHeightFor(settings.codeFontSize),
    tabSize: settings.tabSize,
  };
}

/** Push the resolved appearance onto the document as inline custom properties. */
export function applyAppearance(a: ResolvedAppearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(a.tokens)) root.setProperty(`--${name}`, value);
  root.setProperty("--font-code", a.codeFont);
  root.setProperty("--font-ui", a.uiFont);
  root.setProperty("--code-font-size", `${a.codeFontSize}px`);
  root.setProperty("--code-line-height", `${a.codeLineHeight}px`);
  root.setProperty("--tab-size", String(a.tabSize));
  root.setProperty("color-scheme", a.theme.mode);
  document.documentElement.dataset.theme = a.theme.id;
}

const prefersLightQuery = "(prefers-color-scheme: light)";

function readPrefersLight(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(prefersLightQuery).matches
    : false;
}

/** Apply the stored appearance before React mounts, avoiding a flash. */
export function bootstrapAppearance() {
  applyAppearance(resolveAppearance(loadSettings(), readPrefersLight()));
}

interface SettingsContextValue {
  settings: Settings;
  appearance: ResolvedAppearance;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [prefersLight, setPrefersLight] = useState(readPrefersLight);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(prefersLightQuery);
    const onChange = () => setPrefersLight(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Cross-tab sync: another tab's write becomes this tab's state.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key !== SETTINGS_KEY) return;
      setSettings(loadSettings());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((cur) => {
      const next = parseSettings({ ...cur, ...patch });
      saveSettings(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    const next = { ...DEFAULT_SETTINGS };
    saveSettings(next);
    setSettings(next);
  }, []);

  const appearance = useMemo(
    () => resolveAppearance(settings, prefersLight),
    [settings, prefersLight],
  );

  useLayoutEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  const value = useMemo(
    () => ({ settings, appearance, update, reset }),
    [settings, appearance, update, reset],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}

/** Convenience for the diff surface, which only cares about these two. */
export function useDiffViewPrefs() {
  const { settings, update } = useSettings();
  return {
    viewMode: settings.diffViewMode,
    wrap: settings.diffWrap,
    setViewMode: (mode: DiffViewMode) => update({ diffViewMode: mode }),
    setWrap: (wrap: boolean) => update({ diffWrap: wrap }),
    toggleViewMode: () =>
      update({ diffViewMode: settings.diffViewMode === "unified" ? "split" : "unified" }),
    toggleWrap: () => update({ diffWrap: !settings.diffWrap }),
  };
}
