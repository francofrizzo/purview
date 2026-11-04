/**
 * Lazy mermaid wrapper for the chat's ```mermaid fences.
 *
 * Mirrors lib/highlight.ts: nothing from the `mermaid` package touches the
 * main bundle until a mermaid fence actually needs rendering, and the
 * dynamic import() keeps it in its own async chunk. `securityLevel: "strict"`
 * is non-negotiable — a diagram's source is assistant/PR-adjacent text, not
 * trusted markup, and strict mode is what keeps mermaid from honoring
 * script/click bindings embedded in it.
 */

export type MermaidRenderResult =
  | { status: "pending" }
  | { status: "ok"; svg: string }
  /** The source did not parse or render; the same source will fail again. */
  | { status: "error" }
  /** The mermaid module could not be loaded (a 404 while the app rebuilds,
   *  a dropped connection); a later call imports again. */
  | { status: "unavailable" };

/** The app tokens a diagram is painted with, so it reads as part of the
 *  theme instead of mermaid's own palette. Only text-on-surface pairs that
 *  contrast.ts already checks: fg and fg-muted on bg-inset, bg-raised and
 *  bg-hover. */
export interface MermaidColors {
  bg: string;
  surface: string;
  muted: string;
  border: string;
  fg: string;
  line: string;
}

export interface MermaidRenderOptions {
  dark: boolean;
  fontFamily: string;
  colors?: MermaidColors;
}

/** mermaid's `base` theme, fed the app's tokens: nodes and actors on the
 *  raised surface, notes and groups on the hover one, lines in muted text. */
export function themeVariables(c: MermaidColors, dark: boolean): Record<string, unknown> {
  return {
    darkMode: dark,
    background: c.bg,
    fontSize: "13px",
    textColor: c.fg,
    lineColor: c.line,
    primaryColor: c.surface,
    primaryTextColor: c.fg,
    primaryBorderColor: c.border,
    secondaryColor: c.muted,
    secondaryTextColor: c.fg,
    secondaryBorderColor: c.border,
    tertiaryColor: c.muted,
    tertiaryTextColor: c.fg,
    tertiaryBorderColor: c.border,
    mainBkg: c.surface,
    nodeBorder: c.border,
    nodeTextColor: c.fg,
    clusterBkg: c.muted,
    clusterBorder: c.border,
    titleColor: c.fg,
    edgeLabelBackground: c.bg,
    actorBkg: c.surface,
    actorBorder: c.border,
    actorTextColor: c.fg,
    actorLineColor: c.border,
    signalColor: c.line,
    signalTextColor: c.fg,
    labelBoxBkgColor: c.muted,
    labelBoxBorderColor: c.border,
    labelTextColor: c.fg,
    loopTextColor: c.fg,
    noteBkgColor: c.muted,
    noteBorderColor: c.border,
    noteTextColor: c.fg,
    activationBkgColor: c.muted,
    activationBorderColor: c.border,
    sequenceNumberColor: c.bg,
  };
}

/**
 * The look, on top of the colors: the svg is inlined into the page, so these
 * rules read the app's tokens directly. Flat, rounded, thin: nodes sit on the
 * raised surface like the app's panes, and the one accent goes to where the
 * flow branches (a decision, an alt or a loop) so the eye finds it first.
 * Edge labels are small pills on the canvas, clear of the lines they name.
 */
const THEME_CSS = `
  * { filter: none !important; }
  .node rect, .node polygon, .node circle, .node path, rect.actor, .note, .labelBox {
    stroke-width: 1px !important;
  }
  .node rect.label-container, rect.actor, rect.note { rx: 6px; ry: 6px; }
  .node polygon { fill: var(--accent-soft) !important; stroke: var(--accent) !important; }
  .nodeLabel, .nodeLabel p { font-size: 13px; color: var(--fg) !important; }
  .flowchart-link, .messageLine0, .messageLine1 {
    stroke: var(--fg-muted) !important;
    stroke-width: 1.25px !important;
  }
  .messageLine1 { stroke-dasharray: 4 3 !important; }
  .arrowMarkerPath, #arrowhead path, .marker { fill: var(--fg-muted) !important; stroke: none !important; }
  .labelBkg { background: transparent !important; }
  .edgeLabel p, span.edgeLabel {
    margin: 0;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--bg-inset) !important;
    color: var(--fg-muted) !important;
    font-size: 11.5px;
  }
  .actor-line { stroke: var(--border-strong) !important; stroke-dasharray: 2 4 !important; stroke-width: 1px !important; }
  text.actor > tspan, .messageText { fill: var(--fg) !important; font-size: 13px !important; }
  .messageText { fill: var(--fg-muted) !important; font-size: 12px !important; }
  .note { fill: var(--bg-hover) !important; stroke: var(--border) !important; }
  .noteText > tspan, .noteText { fill: var(--fg-muted) !important; font-size: 12px !important; }
  .loopLine { stroke: var(--accent) !important; stroke-width: 1px !important; stroke-dasharray: 3 3 !important; opacity: 0.7; }
  .labelBox { fill: var(--accent-soft) !important; stroke: var(--accent) !important; }
  .labelText, .labelText > tspan { fill: var(--accent) !important; font-size: 11.5px !important; }
  .loopText, .loopText > tspan { fill: var(--fg-muted) !important; font-size: 11.5px !important; }
  .cluster rect { rx: 8px; ry: 8px; fill: var(--bg-hover) !important; stroke: var(--border) !important; }
`;

/** What to call a diagram when it is opened on its own: its own title
 *  (front matter `title:` or `accTitle:`), else the sentence that introduced
 *  it, without the colon ("The states a charge moves through:"). */
export function diagramCaption(code: string, lead?: string): string | null {
  const own = /^\s*(?:title|accTitle)\s*:\s*(.+?)\s*$/m.exec(code)?.[1];
  if (own) return own.replace(/^["']|["']$/g, "");
  const text = lead
    ?.replace(/[`*_]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .replace(/[:.]$/, "");
  return text && text.length <= 120 ? text : null;
}

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi | null> | null = null;
/** Re-init only when the effective config actually changed (theme/font switch). */
let initializedFor: string | null = null;

async function getMermaid(opts: MermaidRenderOptions): Promise<MermaidApi | null> {
  if (!mermaidPromise) {
    // A failed import is forgotten so the next diagram tries again: the chunk
    // 404s for a few seconds while `pnpm start` rebuilds dist, and a tab that
    // asked for a diagram in that window would otherwise never render one.
    mermaidPromise = import("mermaid")
      .then((mod: any) => (mod.default ?? mod) as MermaidApi)
      .catch(() => { mermaidPromise = null; return null; });
  }
  const mermaid = await mermaidPromise;
  if (!mermaid) return null;
  const key = configKey(opts);
  if (initializedFor !== key) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Without it a source that fails to parse leaves mermaid's "Syntax
      // error" diagram in a div appended to <body>, outside every layout.
      suppressErrorRendering: true,
      fontFamily: opts.fontFamily,
      ...(opts.colors
        ? {
            theme: "base",
            themeVariables: themeVariables(opts.colors, opts.dark),
            themeCSS: THEME_CSS,
            // Edges turn at right angles with a rounded corner, not as loose curves.
            flowchart: { nodeSpacing: 36, rankSpacing: 44, padding: 14, curve: "rounded" },
            sequence: { mirrorActors: false, actorMargin: 64, boxMargin: 8, noteMargin: 12, messageMargin: 36 },
          }
        : { theme: opts.dark ? "dark" : "base" }),
    });
    initializedFor = key;
  }
  return mermaid;
}

let renderSeq = 0;
/** Keyed by theme + font + source, so identical source never re-renders. Only
 *  successes stay: a failure is dropped so the next mount tries again. */
const cache = new Map<string, Promise<MermaidRenderResult>>();

function configKey(opts: MermaidRenderOptions): string {
  const colors = opts.colors ? Object.values(opts.colors).join(",") : "";
  return `${opts.dark ? "dark" : "base"}\u0000${opts.fontFamily}\u0000${colors}`;
}

function cacheKey(code: string, opts: MermaidRenderOptions): string {
  return `${configKey(opts)}\u0000${code}`;
}

/**
 * Render (memoized) mermaid source to inline SVG. `open` is the fence's own
 * "still streaming in" flag from lib/markdown.ts — an unclosed fence resolves
 * to `pending` without ever touching the mermaid module, so a diagram is
 * never attempted against half-arrived text. Never throws: a parse/render
 * failure resolves to `error` so the caller can fall back to the raw block.
 */
export function renderMermaid(
  code: string,
  open: boolean,
  opts: MermaidRenderOptions,
): Promise<MermaidRenderResult> {
  if (open) return Promise.resolve({ status: "pending" });
  const key = cacheKey(code, opts);
  const cached = cache.get(key);
  if (cached) return cached;
  const p = (async (): Promise<MermaidRenderResult> => {
    const mermaid = await getMermaid(opts);
    if (!mermaid) return { status: "unavailable" };
    const id = `mmd-${++renderSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return { status: "ok", svg };
    } catch {
      // mermaid renders into a temporary `#d<id>` div on <body>; drop it in
      // case a failure path still leaves it behind.
      if (typeof document !== "undefined") document.getElementById(`d${id}`)?.remove();
      return { status: "error" };
    }
  })();
  cache.set(key, p);
  void p.then((r) => { if (r.status !== "ok") cache.delete(key); });
  return p;
}

/** Test hook: drop the memo cache and force a fresh dynamic import + init. */
export function resetMermaidForTests(): void {
  cache.clear();
  mermaidPromise = null;
  initializedFor = null;
}
