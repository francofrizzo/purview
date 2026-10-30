/**
 * The surfaces where a theme's colors meet: every place the app paints one
 * token on another (body text on each pane, chips on their tints, code on
 * diff rows, comments under the word highlight…), each with the contrast
 * floor that context needs. One list feeds two consumers:
 *
 * - `themes.test.ts` (via `checkTheme`) refuses a theme that falls under a
 *   floor, unless the theme declares an explicit allowance for that surface;
 * - `scripts/contrast-sheet.mjs` renders the same list as a page to look at.
 *
 * A new surface goes here and nowhere else, so the test and the sheet can
 * never disagree about what is checked. Floors are what the token derivation
 * promises for the context (see `deriveTokens`): 4.5 body text, 3.2 muted,
 * 2.4 faint, 3.4–3.6 colored text, 3.0 chips and code comments, 4.0 the
 * short word-highlight and search marks, 1.25 a divider; WCAG AA (4.5, or 3.0 for large text and outlines) is reported
 * separately as the stricter yardstick.
 */

import { composite, contrast, mix, parseColor, toHex } from "./color";
import type { ChromeTokens, ThemeDef } from "./themes";

/** The colors a theme's shiki grammar paints for three scopes. */
export interface SyntaxColors {
  comment?: string;
  string?: string;
  keyword?: string;
}

export type SurfaceKind = "text" | "chip" | "mono" | "swatch";

export interface Surface {
  /** stable id, the key an allowance names */
  id: string;
  group: string;
  label: string;
  /** a chrome token, or `syntax:<scope>` for a shiki color */
  fg: string;
  /** background layers, innermost first; each a token name or a color */
  layers: string[];
  floor: number;
  kind: SurfaceKind;
  /** text the sheet renders in this pairing */
  sample: string;
  /**
   * The rendered color is the token mixed this far toward `fg`: how the
   * diff lifts comment tokens on tinted rows (see index.css `.tok-comment`).
   */
  lift?: number;
}

const s = (
  id: string,
  group: string,
  label: string,
  fg: string,
  floor: number,
  layers: string[],
  sample: string,
  extra: Partial<Pick<Surface, "kind" | "lift">> = {},
): Surface => ({ id, group, label, fg, layers, floor, sample, kind: extra.kind ?? "text", lift: extra.lift });

const chip = (id: string, name: string, fg: string, soft: string, on = "bg-raised") =>
  s(id, "Chips and badges", `${name} chip`, fg, 3.0, [on, soft], name, { kind: "chip" });

const textOn = (surface: string): Surface[] => [
  s(`body-on-${surface}`, "Text on surfaces", `body text on ${surface}`, "fg", 4.5, [surface], "Charge retries: idempotency keys + backoff"),
  s(`muted-on-${surface}`, "Text on surfaces", `muted text on ${surface}`, "fg-muted", 3.2, [surface], "why must-read: the money-safety decision"),
  s(`faint-on-${surface}`, "Text on surfaces", `faint text on ${surface}`, "fg-faint", 2.4, [surface], "4/15 viewed · asked you 4d ago"),
];

/** Every surface, in the order the sheet shows them. Syntax rows need `syntax`. */
export function contrastSurfaces(syntax: SyntaxColors = {}): Surface[] {
  const mono = { kind: "mono" as const };
  const out: Surface[] = [
    ...textOn("bg"),
    ...textOn("bg-raised"),
    ...textOn("bg-inset"),
    ...textOn("bg-hover"),
    s("accent-on-bg", "Text on surfaces", "accent text on bg", "accent", 3.6, ["bg"], "updated in r3 · set in repo settings"),
    s("accent-on-inset", "Text on surfaces", "accent text on bg-inset", "accent", 3.6, ["bg-inset"], "Analyzing this pull request…"),
    s("accent-on-raised", "Text on surfaces", "accent text on bg-raised", "accent", 3.6, ["bg-raised"], "open the PR description"),
    s("ok-on-raised", "Text on surfaces", "ok text on bg-raised", "ok", 3.0, ["bg-raised"], "2/2 viewed"),
    s("risk-on-raised", "Text on surfaces", "risk text on bg-raised", "risk", 3.0, ["bg-raised"], "Must read (2)"),
    s("bot-on-raised", "Text on surfaces", "bot label on bg-raised", "bot", 3.0, ["bg-raised"], "bot"),
    s("warn-on-raised", "Text on surfaces", "warn text on bg-raised", "warn", 3.0, ["bg-raised"], "Skim (1)"),
    s("warn-on-bg", "Text on surfaces", "warn text on bg (home list: \"no reviewers\", \"update\")", "warn", 3.0, ["bg"], "no reviewers · update"),
    s("heart-on-raised", "Text on surfaces", "heart text on bg-raised", "heart", 3.0, ["bg-raised"], "Heart · where the logic lives"),
    s("agent-on-raised", "Text on surfaces", "agent text on bg-raised", "agent", 3.0, ["bg-raised"], "Note for agent"),

    s("btn-primary", "Buttons", "primary button (accent on accent-soft)", "accent", 3.6, ["bg-raised", "accent-soft"], "finish review", { kind: "chip" }),
    s("btn-agent", "Buttons", "agent button (agent on agent-soft)", "agent", 3.6, ["bg-raised", "agent-soft"], "save note", { kind: "chip" }),
    s("btn-solid", "Buttons", "solid accent button (bg on accent)", "bg", 3.6, ["accent"], "finish review", { kind: "chip" }),
    s("btn-solid-badge", "Buttons", "pending badge on the solid button (accent on bg)", "accent", 3.6, ["accent", "bg"], "pending", { kind: "chip" }),
    s("btn-plain", "Buttons", "plain button text (fg on bg-inset)", "fg", 4.5, ["bg-raised", "bg-inset"], "mark unit viewed", { kind: "chip" }),
    s("selected-row", "Buttons", "selected row (fg on accent-soft)", "fg", 4.5, ["bg-raised", "accent-soft"], "1  Idempotent charge path"),
    s("selected-row-muted", "Buttons", "selected row, muted (fg-muted on accent-soft)", "fg-muted", 3.2, ["bg-raised", "accent-soft"], "2 risks · changed · 1/3"),

    chip("chip-core", "core", "kind-core", "kind-core-soft"),
    chip("chip-glue", "glue", "kind-glue", "kind-glue-soft"),
    chip("chip-refactor", "refactor", "kind-refactor", "kind-refactor-soft"),
    chip("chip-data", "data", "kind-data", "kind-data-soft"),
    chip("chip-wiring", "wiring", "kind-wiring", "kind-wiring-soft"),
    chip("chip-ripple", "ripple", "kind-ripple", "kind-ripple-soft"),
    chip("chip-tests", "tests", "kind-tests", "kind-tests-soft"),
    chip("chip-docs", "docs", "kind-docs", "kind-docs-soft"),
    chip("chip-must-read", "must-read", "risk", "risk-soft"),
    chip("chip-skim", "skim", "warn", "warn-soft"),
    chip("chip-verified", "verified", "ok", "ok-soft"),
    chip("chip-bot", "bot", "bot", "bot-soft"),
    chip("chip-agent", "agent", "agent", "agent-soft"),
    chip("chip-heart", "heart", "heart", "heart-soft"),
    chip("chip-core-inset", "chip on bg-inset: core", "kind-core", "kind-core-soft", "bg-inset"),
    chip("chip-risk-inset", "chip on bg-inset: risk", "risk", "risk-soft", "bg-inset"),
    chip("badge-requested", "reviewer still to answer badge (fg-muted on bg-inset, home list)", "fg-muted", "bg-inset", "bg"),
    s("badge-approved", "Chips and badges", "reviewer approved badge (bg on ok)", "bg", 3.0, ["ok"], "check", { kind: "chip" }),
    s("badge-changes", "Chips and badges", "reviewer changes badge (bg on risk)", "bg", 3.0, ["risk"], "cross", { kind: "chip" }),
    s("age-1", "Chips and badges", "age-1 (fresh request)", "age-1", 3.0, ["bg-raised"], "asked you 2h ago"),
    s("age-2", "Chips and badges", "age-2 (waiting)", "age-2", 3.0, ["bg-raised"], "asked you 2d ago"),
    s("age-3", "Chips and badges", "age-3 (stale)", "age-3", 3.0, ["bg-raised"], "asked you 9d ago"),

    s("diff-add", "Diff rows", "added line", "fg", 4.5, ["bg", "add-bg"], '+  return createHash("sha256")', mono),
    s("diff-del", "Diff rows", "removed line", "fg", 4.5, ["bg", "del-bg"], "-  return md5(orderId)", mono),
    s("diff-add-strong", "Diff rows", "added, strong (word highlight)", "fg", 4.0, ["bg", "add-bg", "add-bg-strong"], "createHash", mono),
    s("diff-del-strong", "Diff rows", "removed, strong (word highlight)", "fg", 4.0, ["bg", "del-bg", "del-bg-strong"], "md5", mono),
    s("gutter-add", "Diff rows", "line number on add gutter", "fg-faint", 2.4, ["bg", "add-gutter"], "509", mono),
    s("gutter-del", "Diff rows", "line number on del gutter", "fg-faint", 2.4, ["bg", "del-gutter"], "502", mono),
    s("moved-in", "Diff rows", "moved-in line (faded add tint)", "fg", 4.5, ["bg", "moved-add-bg"], "←  func contactlessToolCallResults(", mono),
    s("moved-out", "Diff rows", "moved-out line (faded del tint)", "fg", 4.5, ["bg", "moved-del-bg"], "→  func contactlessToolCallResults(", mono),
    s("moved-marker-in", "Diff rows", "arrow marker on a moved-in line", "ok", 3.0, ["bg", "moved-add-bg"], "←", mono),
    s("moved-marker-out", "Diff rows", "arrow marker on a moved-out line", "risk", 3.0, ["bg", "moved-del-bg"], "→", mono),
    s("gutter-moved-in", "Diff rows", "line number on a moved-in gutter", "fg-faint", 2.4, ["bg", "moved-add-gutter"], "509", mono),
    s("gutter-moved-out", "Diff rows", "line number on a moved-out gutter", "fg-faint", 2.4, ["bg", "moved-del-gutter"], "502", mono),
    s("moved-band-link", "Diff rows", "fold band \"go to\" and hint (fg-muted on the faded tint)", "fg-muted", 3.2, ["bg", "moved-add-bg"], "go to report.ts ←", mono),
    s("search-on-add", "Diff rows", "search match over an added line", "fg", 4.0, ["bg", "add-bg", "search-match"], "idempotencyKey", mono),
    s("search-active-ring", "Diff rows", "active match ring on an added line (outline)", "search-active", 1.5, ["bg", "add-bg"], "", { kind: "swatch" }),
    s("changed-in-on-add", "Diff rows", "changed-in row wash over add", "fg", 4.5, ["bg", "add-bg", "changed-in-bg"], "+  currency: string,", mono),
    s("hunk-header", "Diff rows", "hunk header (fg-muted on bg-hover)", "fg-muted", 3.2, ["bg", "bg-hover"], "@@ -18,10 +18,26 @@ export class ChargeService", mono),
    s("hunk-header-focused", "Diff rows", "focused hunk header (fg-muted on accent-soft)", "fg-muted", 3.2, ["bg", "bg-hover", "accent-soft"], "@@ -0,0 +1,14 @@", mono),
    ...["bg", "add-bg", "del-bg"].map((bg) => s(`risk-bar-${bg}`, "Diff rows", `risk bar on ${bg}`, "risk", 3.0, ["bg", bg], "│", { kind: "swatch" })),
    s("risk-caption-chip", "Diff rows", "risk caption chip", "risk", 3.0, ["bg", "risk-soft"], "money"),
    s("risk-caption-why", "Diff rows", "risk caption why", "fg-muted", 3.2, ["bg"], "A retry can charge twice."),
    s("heart-why", "Diff rows", "heart why row (fg on heart-soft)", "fg", 4.5, ["bg", "heart-soft"], "short-circuits on the ledger row before touching the gateway"),
    s("heart-mark", "Diff rows", "heart mark on heart-soft", "heart", 3.0, ["bg", "heart-soft"], "♥ heart"),
    s("comment-marker-add", "Diff rows", "comment marker (accent on add-bg)", "accent", 3.0, ["bg", "add-bg"], "● 3"),
    s("comment-marker-del", "Diff rows", "comment marker (accent on del-bg)", "accent", 3.0, ["bg", "del-bg"], "● 3"),

    s("code-span", "Code and prose", "code span (fg on bg-inset)", "fg", 4.5, ["bg-raised", "bg-inset"], "charge()", { kind: "chip" }),
    s("code-span-muted", "Code and prose", "code span in muted prose", "fg-muted", 3.2, ["bg-raised", "bg-inset"], "src/billing/ledger.ts", { kind: "chip" }),
    s("tooltip", "Code and prose", "tooltip (fg on bg-raised)", "fg", 4.5, ["bg-raised"], "Comments, chat and review  m c r"),
    s("placeholder", "Code and prose", "placeholder (fg-faint on bg-inset)", "fg-faint", 2.4, ["bg-raised", "bg-inset"], "Ask about this PR…  (↵ send · ⇧↵ newline)"),
    s("agent-card", "Code and prose", "agent note card (fg on agent-soft)", "fg", 4.5, ["bg-raised", "agent-soft"], "Rename this before merging; the old name leaks."),
    s("warn-banner", "Code and prose", "warn banner (warn on warn-soft)", "warn", 3.4, ["bg-raised", "warn-soft"], "Clear this conversation? It cannot be recovered."),
    s("risk-banner", "Code and prose", "risk banner (risk on risk-soft)", "risk", 3.4, ["bg-raised", "risk-soft"], "Analysis failed: claude exited with code 3"),
    s("divider", "Code and prose", "border on bg (divider)", "border", 1.25, ["bg"], "", { kind: "swatch" }),
    s("outline", "Code and prose", "border-strong on bg-raised (control outline)", "border-strong", 1.5, ["bg-raised"], "", { kind: "swatch" }),
  ];

  // Syntax: shiki's own colors on the rows the diff paints them on. Comments
  // are lifted toward the foreground on tinted rows (index.css), by the
  // fractions `lift` names; the plain-line row has none.
  if (syntax.comment) {
    out.push(
      s("syn-comment", "Syntax on diff rows", "code comment on a plain line", "syntax:comment", 3.0, ["bg"], "// TODO(ENG-5932): run the configured tools instead", mono),
      s("syn-comment-add", "Syntax on diff rows", "code comment on an added line (lifted)", "syntax:comment", 3.0, ["bg", "add-bg"], "+// wrapped for the live test; answers every call", { ...mono, lift: 0.38 }),
      s("syn-comment-del", "Syntax on diff rows", "code comment on a removed line (lifted)", "syntax:comment", 3.0, ["bg", "del-bg"], "-// voiceToolNotAvailableResult answers every tool call", { ...mono, lift: 0.38 }),
      s("syn-comment-add-strong", "Syntax on diff rows", "code comment under the word highlight, added (lifted)", "syntax:comment", 3.0, ["bg", "add-bg", "add-bg-strong"], "answerContactlessLiveTestToolCalls", { ...mono, lift: 0.7 }),
      s("syn-comment-del-strong", "Syntax on diff rows", "code comment under the word highlight, removed (lifted)", "syntax:comment", 3.0, ["bg", "del-bg", "del-bg-strong"], "voiceToolNotAvailableResult", { ...mono, lift: 0.7 }),
    );
  }
  if (syntax.string) {
    out.push(
      s("syn-string-add", "Syntax on diff rows", "string on an added line", "syntax:string", 3.0, ["bg", "add-bg"], '+  "La herramienta no está disponible."', mono),
      s("syn-string-del", "Syntax on diff rows", "string on a removed line", "syntax:string", 3.0, ["bg", "del-bg"], '-  "La herramienta no está disponible."', mono),
    );
  }
  if (syntax.keyword) {
    out.push(
      s("syn-keyword-add", "Syntax on diff rows", "keyword on an added line", "syntax:keyword", 3.0, ["bg", "add-bg"], "+  return results, nil", mono),
      s("syn-keyword-del", "Syntax on diff rows", "keyword on a removed line", "syntax:keyword", 3.0, ["bg", "del-bg"], "-  func contactlessToolCallResults(", mono),
    );
  }
  return out;
}

/** The snippet `readSyntaxColors` expects to have been highlighted (lang `ts`). */
export const SYNTAX_SNIPPET = '// note\nconst s = "text";\nreturn s;';

/** Pick the three scope colors off shiki's tokens for `SYNTAX_SNIPPET`. */
export function readSyntaxColors(tokens: { content: string; color?: string }[][]): SyntaxColors {
  const flat = tokens.flat();
  const find = (text: string) => flat.find((t) => t.content.trim() === text)?.color;
  return { comment: find("// note"), string: find('"text"'), keyword: find("return") ?? find("const") };
}

export interface SurfaceResult extends Surface {
  /** the rendered foreground and background, opaque hex */
  fgColor: string;
  bgColor: string;
  ratio: number;
  /** the floor after the theme's allowance, if any */
  effectiveFloor: number;
  allowed: boolean;
  pass: boolean;
  /** clears WCAG AA for the kind (4.5 text, 3.0 outlines) */
  aa: boolean;
}

/** Resolve one surface against a token set (and shiki colors). */
export function measure(surface: Surface, tokens: ChromeTokens, syntax: SyntaxColors): SurfaceResult | null {
  const color = (ref: string): string | undefined =>
    ref.startsWith("syntax:") ? syntax[ref.slice(7) as keyof SyntaxColors] : ((tokens as Record<string, string>)[ref] ?? ref);
  const fgRaw = color(surface.fg);
  if (!fgRaw) return null;
  const bgColor = surface.layers.reduce((under, layer) => composite(color(layer) ?? layer, under), tokens.bg);
  const opaque = (c: string) => toHex(parseColor(c));
  const fgColor = surface.lift ? mix(opaque(fgRaw), tokens.fg, surface.lift) : opaque(fgRaw);
  const ratio = contrast(fgColor, bgColor);
  return {
    ...surface,
    fgColor,
    bgColor,
    ratio,
    effectiveFloor: surface.floor,
    allowed: false,
    pass: ratio >= surface.floor,
    aa: ratio >= (surface.kind === "swatch" ? 3.0 : 4.5),
  };
}

/**
 * Every surface for a theme, with the theme's allowances applied. An
 * allowance (`ThemeDef.contrast.allow`) names a surface id and the floor
 * the theme is held to there instead; `floorScale` lowers every floor for a
 * palette that is low-contrast by design (Solarized).
 */
export function checkTheme(
  theme: ThemeDef,
  tokens: ChromeTokens,
  syntax: SyntaxColors = {},
): { results: SurfaceResult[]; failures: SurfaceResult[]; staleAllowances: string[] } {
  const scale = theme.contrast?.floorScale ?? 1;
  const allow = theme.contrast?.allow ?? {};
  const results: SurfaceResult[] = [];
  for (const surface of contrastSurfaces(syntax)) {
    const r = measure(surface, tokens, syntax);
    if (!r) continue;
    const own = allow[surface.id];
    r.effectiveFloor = own ?? surface.floor * scale;
    r.allowed = own !== undefined;
    r.pass = r.ratio >= r.effectiveFloor;
    results.push(r);
  }
  const ids = new Set(results.map((r) => r.id));
  // An allowance that is no longer needed, or names nothing, should go.
  const staleAllowances = Object.keys(allow).filter((id) => {
    const r = results.find((x) => x.id === id);
    return !ids.has(id) || (r !== undefined && r.ratio >= r.floor * scale);
  });
  return { results, failures: results.filter((r) => !r.pass), staleAllowances };
}
