/**
 * Theme registry.
 *
 * A theme is one palette object plus the name of a shiki theme (bundled, or a
 * hand-authored TextMate theme built from that same palette). Every app-chrome
 * CSS custom property is *derived* from the palette, so adding a theme means
 * adding a palette — not hand-tuning thirty variables. Themes that need to
 * match an existing look exactly can pin individual tokens via `overrides`.
 */

import { contrast, mix, readable, rgba } from "./color";

export type ThemeMode = "dark" | "light";

/** The colors every theme must supply. Ramp names follow the usual editor ones. */
export interface Palette {
  bg: string;
  fg: string;
  red: string;
  orange: string;
  yellow: string;
  green: string;
  blue: string;
  purple: string;
  comment: string;
  /** Optional teal/cyan; falls back to a blue/green blend. */
  cyan?: string;
}

/** CSS custom property names (without the leading `--`) the app reads. */
export const TOKEN_NAMES = [
  "bg",
  "bg-raised",
  "bg-inset",
  "bg-hover",
  "border",
  "border-strong",
  "fg",
  "fg-muted",
  "fg-faint",
  "accent",
  "accent-soft",
  "add-bg",
  "add-bg-strong",
  "add-gutter",
  "del-bg",
  "del-bg-strong",
  "del-gutter",
  "search-match",
  "search-active",
  "risk",
  "risk-soft",
  "warn",
  "warn-soft",
  "ok",
  "kind-core",
  "kind-core-soft",
  "kind-glue",
  "kind-glue-soft",
  "kind-wiring",
  "kind-wiring-soft",
  "kind-ripple",
  "kind-ripple-soft",
  "kind-tests",
  "kind-tests-soft",
  "kind-docs",
  "kind-docs-soft",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type ChromeTokens = Record<TokenName, string>;

/** A raw TextMate theme object, as shiki accepts it. */
export interface RawTheme {
  name: string;
  type: ThemeMode;
  colors: Record<string, string>;
  tokenColors: { scope?: string | string[]; settings: Record<string, string> }[];
}

export interface ThemeDef {
  id: string;
  label: string;
  group: string;
  /** Shown under the picker for themes that need a caveat. */
  note?: string;
  mode: ThemeMode;
  palette: Palette;
  /** Name passed to shiki (a bundled id, or the name of `raw`). */
  shiki: string;
  /** Present for hand-authored themes; shiki loads the object instead of a bundle. */
  raw?: RawTheme;
  overrides?: Partial<ChromeTokens>;
}

// ---------------------------------------------------------------------------
// palette -> app chrome tokens
// ---------------------------------------------------------------------------

/**
 * Derive the whole chrome token set from a palette. Backgrounds step away from
 * `bg`, foregrounds fade toward it, and every colored *text* token is nudged
 * until it clears a contrast floor against the background — so an accent that
 * is legible on a dark theme stays legible when the same code path renders it
 * on Solarized Light.
 */
export function deriveTokens(palette: Palette, mode: ThemeMode): ChromeTokens {
  const { bg, fg } = palette;
  const dark = mode === "dark";
  const cyan = palette.cyan ?? mix(palette.blue, palette.green, 0.35);

  // Dark themes layer surfaces *up* from the editor background; light themes
  // layer *down* from it — the page is a shade below the panels, which keeps
  // working when the palette background is already pure white.
  const base = dark ? bg : mix(bg, fg, 0.03);
  const raised = dark ? mix(bg, fg, 0.05) : bg;
  const inset = dark ? mix(bg, "#000000", 0.35) : mix(bg, fg, 0.075);

  /** Fade the foreground toward the background, but not past legibility. */
  const fade = (t: number, min: number) => {
    let out = mix(fg, base, t);
    while (t > 0.04 && contrast(out, base) < min) {
      t -= 0.04;
      out = mix(fg, base, t);
    }
    return out;
  };

  // Text colors: floor a little lower for large/solid chips than for body text.
  const text = (c: string, min = 4.0) => readable(c, base, min);
  // Tint alphas: light backgrounds need slightly less to read as a tint.
  const tint = dark ? 0.11 : 0.1;
  const tintStrong = dark ? 0.26 : 0.22;
  const tintGutter = dark ? 0.17 : 0.14;
  const softAlpha = dark ? 0.14 : 0.12;

  const accent = text(palette.blue, 3.6);
  const ok = text(palette.green, 3.4);
  const risk = text(palette.red, 3.6);
  const warn = text(
    // yellow on a light background is hopeless; prefer orange there
    !dark && contrast(palette.yellow, base) < 2.4 ? palette.orange : palette.yellow,
    3.4,
  );

  // Search marks are tints laid over rows that may already carry an add/del
  // tint, so they borrow the one hue the diff never uses. A yellow that barely
  // parts from a light background would read as nothing; orange stands in.
  const searchTint = !dark && contrast(palette.yellow, base) < 2.0 ? palette.orange : palette.yellow;

  const kind = (c: string) => text(c, 3.2);
  const neutral = fade(0.42, 2.8);

  return {
    bg: base,
    "bg-raised": raised,
    "bg-inset": inset,
    "bg-hover": mix(base, fg, dark ? 0.1 : 0.09),
    border: mix(base, fg, 0.13),
    "border-strong": mix(base, fg, dark ? 0.24 : 0.26),

    fg,
    "fg-muted": fade(0.32, 3.2),
    "fg-faint": fade(0.52, 2.4),

    accent,
    "accent-soft": rgba(accent, dark ? 0.14 : 0.1),

    "add-bg": rgba(palette.green, tint),
    "add-bg-strong": rgba(palette.green, tintStrong),
    "add-gutter": rgba(palette.green, tintGutter),
    "del-bg": rgba(palette.red, tint),
    "del-bg-strong": rgba(palette.red, tintStrong),
    "del-gutter": rgba(palette.red, tintGutter),

    "search-match": rgba(searchTint, dark ? 0.24 : 0.28),
    "search-active": rgba(palette.orange, dark ? 0.55 : 0.48),

    risk,
    "risk-soft": rgba(risk, softAlpha),
    warn,
    "warn-soft": rgba(warn, softAlpha),
    ok,

    "kind-core": kind(palette.purple),
    "kind-core-soft": rgba(palette.purple, softAlpha),
    "kind-glue": kind(cyan),
    "kind-glue-soft": rgba(cyan, softAlpha),
    "kind-wiring": neutral,
    "kind-wiring-soft": rgba(neutral, dark ? 0.13 : 0.1),
    "kind-ripple": kind(palette.orange),
    "kind-ripple-soft": rgba(palette.orange, softAlpha),
    "kind-tests": kind(palette.green),
    "kind-tests-soft": rgba(palette.green, softAlpha),
    "kind-docs": fade(0.3, 3.0),
    "kind-docs-soft": rgba(fade(0.3, 3.0), dark ? 0.12 : 0.1),
  };
}

export function tokensFor(theme: ThemeDef): ChromeTokens {
  return { ...deriveTokens(theme.palette, theme.mode), ...theme.overrides };
}

// ---------------------------------------------------------------------------
// hand-authored TextMate themes
// ---------------------------------------------------------------------------

/**
 * Build a TextMate theme from a palette using the conventional Monokai scope
 * mapping (keywords red, strings yellow, functions green, types cyan, numbers
 * and constants purple, parameters orange). Used for the Monokai Pro *palette
 * approximations* — the official theme files are a commercial product and are
 * deliberately not vendored here.
 */
export function buildTextMateTheme(name: string, p: Palette, mode: ThemeMode = "dark"): RawTheme {
  const cyan = p.cyan ?? mix(p.blue, p.green, 0.35);
  return {
    name,
    type: mode,
    colors: { "editor.background": p.bg, "editor.foreground": p.fg },
    tokenColors: [
      { settings: { background: p.bg, foreground: p.fg } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: p.comment, fontStyle: "italic" } },
      {
        scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"],
        settings: { foreground: p.yellow },
      },
      { scope: ["constant.character.escape"], settings: { foreground: cyan } },
      {
        scope: ["constant.numeric", "constant.language", "constant.character", "keyword.other.unit"],
        settings: { foreground: p.purple },
      },
      { scope: ["constant.other", "support.constant"], settings: { foreground: p.purple } },
      {
        scope: ["keyword", "keyword.control", "keyword.operator.new", "storage", "storage.type", "storage.modifier"],
        settings: { foreground: p.red },
      },
      { scope: ["keyword.operator"], settings: { foreground: p.red } },
      { scope: ["punctuation", "meta.brace", "punctuation.separator"], settings: { foreground: mix(p.fg, p.bg, 0.3) } },
      {
        scope: ["entity.name.function", "support.function", "meta.function-call.generic"],
        settings: { foreground: p.green },
      },
      {
        scope: ["entity.name.type", "entity.name.class", "support.class", "support.type", "entity.other.inherited-class"],
        settings: { foreground: cyan, fontStyle: "italic" },
      },
      { scope: ["variable.parameter", "meta.function.parameters"], settings: { foreground: p.orange, fontStyle: "italic" } },
      { scope: ["variable", "variable.other", "meta.definition.variable"], settings: { foreground: p.fg } },
      { scope: ["variable.language", "variable.other.constant"], settings: { foreground: p.orange, fontStyle: "italic" } },
      { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: p.red } },
      { scope: ["entity.other.attribute-name"], settings: { foreground: p.green } },
      { scope: ["support.type.property-name", "meta.object-literal.key"], settings: { foreground: p.fg } },
      { scope: ["markup.heading", "entity.name.section"], settings: { foreground: p.green } },
      { scope: ["markup.bold"], settings: { foreground: p.orange, fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { foreground: p.orange, fontStyle: "italic" } },
      { scope: ["markup.inserted"], settings: { foreground: p.green } },
      { scope: ["markup.deleted"], settings: { foreground: p.red } },
      { scope: ["markup.underline.link", "string.other.link"], settings: { foreground: cyan } },
      { scope: ["invalid", "invalid.illegal"], settings: { foreground: p.red } },
    ],
  };
}

// Palettes as widely published for each Monokai Pro filter. These are
// approximations authored from the public palette values, NOT the official
// theme files (which are paid and not redistributable).
const MONOKAI_PRO_VARIANTS: { id: string; label: string; palette: Palette }[] = [
  {
    id: "monokai-pro-classic",
    label: "Monokai Pro (Classic)",
    palette: {
      bg: "#2d2a2e",
      fg: "#fcfcfa",
      red: "#ff6188",
      orange: "#fc9867",
      yellow: "#ffd866",
      green: "#a9dc76",
      blue: "#78dce8",
      cyan: "#78dce8",
      purple: "#ab9df2",
      comment: "#727072",
    },
  },
  {
    id: "monokai-pro-octagon",
    label: "Monokai Pro (Octagon)",
    palette: {
      bg: "#282a3a",
      fg: "#eaf2f1",
      red: "#ff657a",
      orange: "#ff9b5e",
      yellow: "#ffd76d",
      green: "#bad761",
      blue: "#9cd1bb",
      cyan: "#9cd1bb",
      purple: "#c39ac9",
      comment: "#696d77",
    },
  },
  {
    id: "monokai-pro-machine",
    label: "Monokai Pro (Machine)",
    palette: {
      bg: "#273136",
      fg: "#f2fffc",
      red: "#ff6d7e",
      orange: "#ffb270",
      yellow: "#ffed72",
      green: "#a2e57b",
      blue: "#7cd5f1",
      cyan: "#7cd5f1",
      purple: "#baa0f8",
      comment: "#6b7678",
    },
  },
  {
    id: "monokai-pro-ristretto",
    label: "Monokai Pro (Ristretto)",
    palette: {
      bg: "#2c2525",
      fg: "#fff1f3",
      red: "#fd6883",
      orange: "#f38d70",
      yellow: "#f9cc6c",
      green: "#adda78",
      blue: "#85dacc",
      cyan: "#85dacc",
      purple: "#a8a9eb",
      comment: "#72696a",
    },
  },
  {
    id: "monokai-pro-spectrum",
    label: "Monokai Pro (Spectrum)",
    palette: {
      bg: "#222222",
      fg: "#f7f1ff",
      red: "#fc618d",
      orange: "#fd9353",
      yellow: "#fce566",
      green: "#7bd88f",
      blue: "#5ad4e6",
      cyan: "#5ad4e6",
      purple: "#948ae3",
      comment: "#69676c",
    },
  },
];

export const MONOKAI_PRO_NOTE =
  "Monokai Pro entries are community palette approximations, hand-authored from the published " +
  "palette values — not the official (commercial) theme files.";

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

/** The app's own look, pinned token-for-token so the default never drifts. */
const REVIEWER_DARK: ThemeDef = {
  id: "reviewer-dark",
  label: "Reviewer Dark",
  group: "Reviewer",
  mode: "dark",
  shiki: "github-dark",
  palette: {
    bg: "#0c0d10",
    fg: "#dfe3ea",
    red: "#f0787a",
    orange: "#d8b98a",
    yellow: "#e3b341",
    green: "#4ec27f",
    blue: "#7aa2f7",
    cyan: "#7ec9d8",
    purple: "#c4a7ff",
    comment: "#6b7280",
  },
  overrides: {
    "bg-raised": "#131519",
    "bg-inset": "#0a0b0e",
    "bg-hover": "#1a1d23",
    border: "#23262e",
    "border-strong": "#333844",
    "fg-muted": "#99a0ad",
    "fg-faint": "#6b7280",
    accent: "#7aa2f7",
    "accent-soft": "rgba(122, 162, 247, 0.14)",
    "add-bg": "rgba(63, 185, 80, 0.1)",
    "add-bg-strong": "rgba(63, 185, 80, 0.26)",
    "add-gutter": "rgba(63, 185, 80, 0.16)",
    "del-bg": "rgba(248, 81, 73, 0.1)",
    "del-bg-strong": "rgba(248, 81, 73, 0.26)",
    "del-gutter": "rgba(248, 81, 73, 0.16)",
    "search-match": "rgba(227, 179, 65, 0.22)",
    "search-active": "rgba(255, 166, 87, 0.55)",
    risk: "#f0787a",
    "risk-soft": "rgba(240, 120, 122, 0.13)",
    warn: "#e3b341",
    "warn-soft": "rgba(227, 179, 65, 0.13)",
    ok: "#4ec27f",
    "kind-core": "#c4a7ff",
    "kind-core-soft": "rgba(160, 120, 255, 0.14)",
    "kind-glue": "#7ec9d8",
    "kind-glue-soft": "rgba(94, 180, 200, 0.14)",
    "kind-wiring": "#9aa4b4",
    "kind-wiring-soft": "rgba(150, 160, 180, 0.13)",
    "kind-ripple": "#d8b98a",
    "kind-ripple-soft": "rgba(200, 160, 100, 0.13)",
    "kind-tests": "#8fc99b",
    "kind-tests-soft": "rgba(100, 190, 130, 0.13)",
    "kind-docs": "#a0a8bb",
    "kind-docs-soft": "rgba(140, 150, 175, 0.12)",
  },
};

const REVIEWER_LIGHT: ThemeDef = {
  id: "reviewer-light",
  label: "Reviewer Light",
  group: "Reviewer",
  mode: "light",
  shiki: "github-light",
  palette: {
    bg: "#fbfbfc",
    fg: "#1c2027",
    red: "#c0403f",
    orange: "#a86a2a",
    yellow: "#a06a08",
    green: "#1a7f45",
    blue: "#2f6feb",
    cyan: "#0f7490",
    purple: "#6b3fd4",
    comment: "#8b93a1",
  },
  overrides: {
    "bg-raised": "#ffffff",
    "bg-inset": "#f3f4f6",
    "bg-hover": "#eef0f4",
    border: "#e2e5ea",
    "border-strong": "#cdd2da",
    "fg-muted": "#5b6270",
    "fg-faint": "#8b93a1",
    accent: "#2f6feb",
    "accent-soft": "rgba(47, 111, 235, 0.1)",
    "add-bg": "rgba(34, 134, 58, 0.09)",
    "add-bg-strong": "rgba(34, 134, 58, 0.22)",
    "add-gutter": "rgba(34, 134, 58, 0.13)",
    "del-bg": "rgba(203, 36, 49, 0.08)",
    "del-bg-strong": "rgba(203, 36, 49, 0.2)",
    "del-gutter": "rgba(203, 36, 49, 0.12)",
    "search-match": "rgba(226, 168, 22, 0.3)",
    "search-active": "rgba(247, 148, 30, 0.6)",
    risk: "#c0403f",
    "risk-soft": "rgba(192, 64, 63, 0.1)",
    warn: "#a06a08",
    "warn-soft": "rgba(160, 106, 8, 0.12)",
    ok: "#1a7f45",
  },
};

function bundled(
  id: string,
  label: string,
  mode: ThemeMode,
  palette: Palette,
  shiki = id,
): ThemeDef {
  return { id, label, group: "Editor themes", mode, palette, shiki };
}

const BUNDLED: ThemeDef[] = [
  bundled("github-dark", "GitHub Dark", "dark", {
    bg: "#0d1117",
    fg: "#c9d1d9",
    red: "#ff7b72",
    orange: "#ffa657",
    yellow: "#d29922",
    green: "#7ee787",
    blue: "#79c0ff",
    purple: "#d2a8ff",
    comment: "#8b949e",
  }),
  bundled("github-light", "GitHub Light", "light", {
    bg: "#ffffff",
    fg: "#24292f",
    red: "#cf222e",
    orange: "#e36209",
    yellow: "#9a6700",
    green: "#116329",
    blue: "#0969da",
    purple: "#8250df",
    comment: "#6e7781",
  }),
  bundled("one-dark-pro", "One Dark Pro", "dark", {
    bg: "#282c34",
    fg: "#abb2bf",
    red: "#e06c75",
    orange: "#d19a66",
    yellow: "#e5c07b",
    green: "#98c379",
    blue: "#61afef",
    cyan: "#56b6c2",
    purple: "#c678dd",
    comment: "#7f848e",
  }),
  bundled("dracula", "Dracula", "dark", {
    bg: "#282a36",
    fg: "#f8f8f2",
    red: "#ff5555",
    orange: "#ffb86c",
    yellow: "#f1fa8c",
    green: "#50fa7b",
    blue: "#8be9fd",
    cyan: "#8be9fd",
    purple: "#bd93f9",
    comment: "#6272a4",
  }),
  bundled("nord", "Nord", "dark", {
    bg: "#2e3440",
    fg: "#d8dee9",
    red: "#bf616a",
    orange: "#d08770",
    yellow: "#ebcb8b",
    green: "#a3be8c",
    blue: "#88c0d0",
    cyan: "#8fbcbb",
    purple: "#b48ead",
    comment: "#616e88",
  }),
  bundled("tokyo-night", "Tokyo Night", "dark", {
    bg: "#1a1b26",
    fg: "#a9b1d6",
    red: "#f7768e",
    orange: "#ff9e64",
    yellow: "#e0af68",
    green: "#9ece6a",
    blue: "#7aa2f7",
    cyan: "#7dcfff",
    purple: "#bb9af7",
    comment: "#565f89",
  }),
  bundled("catppuccin-mocha", "Catppuccin Mocha", "dark", {
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    red: "#f38ba8",
    orange: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    blue: "#89b4fa",
    cyan: "#94e2d5",
    purple: "#cba6f7",
    comment: "#6c7086",
  }),
  bundled("solarized-dark", "Solarized Dark", "dark", {
    bg: "#002b36",
    fg: "#93a1a1",
    red: "#dc322f",
    orange: "#cb4b16",
    yellow: "#b58900",
    green: "#859900",
    blue: "#268bd2",
    cyan: "#2aa198",
    purple: "#6c71c4",
    comment: "#586e75",
  }),
  bundled("solarized-light", "Solarized Light", "light", {
    bg: "#fdf6e3",
    fg: "#586e75",
    red: "#dc322f",
    orange: "#cb4b16",
    yellow: "#b58900",
    green: "#859900",
    blue: "#268bd2",
    cyan: "#2aa198",
    purple: "#6c71c4",
    comment: "#93a1a1",
  }),
  {
    ...bundled("monokai", "Monokai (original)", "dark", {
      bg: "#272822",
      fg: "#f8f8f2",
      red: "#f92672",
      orange: "#fd971f",
      yellow: "#e6db74",
      green: "#a6e22e",
      blue: "#66d9ef",
      cyan: "#66d9ef",
      purple: "#ae81ff",
      comment: "#75715e",
    }),
    group: "Monokai",
  },
];

const MONOKAI_PRO: ThemeDef[] = MONOKAI_PRO_VARIANTS.map(({ id, label, palette }) => ({
  id,
  label: `${label} — community palette`,
  group: "Monokai",
  mode: "dark" as const,
  palette,
  shiki: id,
  raw: buildTextMateTheme(id, palette, "dark"),
}));

/** Every selectable theme, in picker order. `system` is handled separately. */
export const THEMES: ThemeDef[] = [REVIEWER_DARK, REVIEWER_LIGHT, ...BUNDLED, ...MONOKAI_PRO];

export const THEMES_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export const SYSTEM_THEME_ID = "system";
export const DEFAULT_THEME_ID = SYSTEM_THEME_ID;

/**
 * Resolve a stored theme id to a concrete theme. `system` (and any unknown id)
 * falls back to the app's own dark/light pair, keeping today's
 * `prefers-color-scheme` behavior.
 */
export function resolveTheme(id: string, prefersLight: boolean): ThemeDef {
  if (id && id !== SYSTEM_THEME_ID) {
    const t = THEMES_BY_ID.get(id);
    if (t) return t;
  }
  return prefersLight ? REVIEWER_LIGHT : REVIEWER_DARK;
}

/**
 * The shiki descriptor for a theme, memoized so its identity is stable — hooks
 * use it as an effect dependency, and shiki mutates the raw object on load.
 */
const shikiThemes = new Map<string, { name: string; raw?: RawTheme }>();

export function shikiThemeFor(theme: ThemeDef): { name: string; raw?: RawTheme } {
  let entry = shikiThemes.get(theme.id);
  if (!entry) {
    entry = theme.raw ? { name: theme.shiki, raw: theme.raw } : { name: theme.shiki };
    shikiThemes.set(theme.id, entry);
  }
  return entry;
}

/** Small swatch set for the picker's preview chips. */
export function previewColors(theme: ThemeDef): string[] {
  const p = theme.palette;
  return [p.bg, p.fg, p.red, p.green, p.blue, p.purple];
}

export { REVIEWER_DARK, REVIEWER_LIGHT };
