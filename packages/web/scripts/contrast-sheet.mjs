#!/usr/bin/env node
/**
 * Contrast sheet: one local HTML page that renders every theme's tokens in
 * the contexts the app actually puts them in (body text on each surface,
 * chips, diff rows, buttons, code spans, the heart and agent tints…) and
 * scores each pairing with its WCAG contrast ratio against the floor that
 * context needs.
 *
 *   node scripts/contrast-sheet.mjs [out.html]
 *
 * The themes are loaded from src/lib/themes.ts through Vite, so the sheet can
 * never drift from what the app ships. Translucent tokens are composited over
 * the backdrop they sit on before measuring, the way the eye sees them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "contrast-sheet.html"));

const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { THEMES, tokensFor, shikiThemeFor } = await server.ssrLoadModule("/src/lib/themes.ts");
await server.close();
const { createHighlighter } = await import("shiki");

/**
 * The colors shiki actually paints for a theme, read off a highlighted
 * snippet (the diff does the same), not guessed from scope rules: TextMate
 * resolves scopes by specificity, so the first matching rule is often wrong.
 */
const SNIPPET = "// note\nconst s = \"text\";\nreturn s;";
const highlighter = await createHighlighter({ langs: ["ts"], themes: [] });
async function syntaxColors(theme) {
  const entry = shikiThemeFor(theme);
  const raw = entry.raw ?? (await import("shiki")).bundledThemes[entry.name];
  if (!raw) return {};
  await highlighter.loadTheme(raw);
  const name = entry.raw ? entry.raw.name : entry.name;
  const { tokens } = highlighter.codeToTokens(SNIPPET, { lang: "ts", theme: name });
  const find = (text) => tokens.flat().find((tk) => tk.content.trim() === text)?.color;
  return { comment: find("// note"), string: find('"text"'), keyword: find("return") ?? find("const") };
}

/* ------------------------------------------------------------ color math */

function parse(c) {
  c = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`unparseable color: ${c}`);
}
/** `top` over `under` (both may be translucent); returns an opaque rgb. */
function over(top, under) {
  const t = parse(top);
  const u = parse(under);
  const a = t.a + u.a * (1 - t.a);
  const ch = (x, y) => Math.round((x * t.a + y * u.a * (1 - t.a)) / (a || 1));
  return { r: ch(t.r, u.r), g: ch(t.g, u.g), b: ch(t.b, u.b), a: 1 };
}
function css({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`;
}
function lum({ r, g, b }) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg, bg) {
  const [a, b] = [lum(fg), lum(bg)];
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------------------------------------- the contexts */

/**
 * One row per place a color pair meets in the app. `floor` is what the app's
 * own token derivation promises for that context (see deriveTokens): 4.5 for
 * body text, 3.2 for muted text, 2.4 for faint text, 3.4-3.6 for colored
 * text, 3.0 for chips, 1.25 for a divider. The AA column says whether the
 * pairing also clears WCAG's 4.5 (or 3.0 for large text), which is the
 * stricter yardstick. Each row names the tokens; the background is composited
 * from the listed layers, innermost first.
 */
function contexts(t, syn) {
  const bg = (...layers) => layers.reduce((acc, l) => over(t[l] ?? l, css(acc)), parse(t.bg));
  const row = (group, label, fgTok, floor, layers, sample, extra = {}) => ({
    group,
    label,
    fgTok,
    floor,
    fg: parse(extra.fgOverride ?? t[fgTok]),
    bgDesc: layers.join(" / "),
    bg: bg(...layers),
    sample,
    ...extra,
  });
  const chip = (name, fgTok, softTok, surface = "bg-raised") =>
    row("Chips and badges", `${name} chip`, fgTok, 3.0, [surface, softTok], name, { chip: true });
  const text = (surface) => [
    row("Text on surfaces", `body text on ${surface}`, "fg", 4.5, [surface], "Charge retries: idempotency keys + backoff"),
    row("Text on surfaces", `muted text on ${surface}`, "fg-muted", 3.2, [surface], "why must-read: the money-safety decision"),
    row("Text on surfaces", `faint text on ${surface}`, "fg-faint", 2.4, [surface], "4/15 viewed · asked you 4d ago"),
  ];
  return [
    ...text("bg"),
    ...text("bg-raised"),
    ...text("bg-inset"),
    ...text("bg-hover"),
    row("Text on surfaces", "accent text on bg", "accent", 3.6, ["bg"], "updated in r3 · set in repo settings"),
    row("Text on surfaces", "accent text on bg-raised", "accent", 3.6, ["bg-raised"], "open the PR description"),
    row("Text on surfaces", "ok text on bg-raised", "ok", 3.0, ["bg-raised"], "2/2 viewed"),
    row("Text on surfaces", "risk text on bg-raised", "risk", 3.0, ["bg-raised"], "Must read (2)"),
    row("Text on surfaces", "warn text on bg-raised", "warn", 3.0, ["bg-raised"], "Skim (1)"),
    row("Text on surfaces", "heart text on bg-raised", "heart", 3.0, ["bg-raised"], "Heart · where the logic lives"),
    row("Text on surfaces", "agent text on bg-raised", "agent", 3.0, ["bg-raised"], "Note for agent"),

    row("Buttons", "primary button (accent on accent-soft)", "accent", 3.6, ["bg-raised", "accent-soft"], "finish review", { chip: true }),
    row("Buttons", "agent button (agent on agent-soft)", "agent", 3.6, ["bg-raised", "agent-soft"], "save note", { chip: true }),
    row("Buttons", "solid accent button (bg on accent)", "bg", 3.6, ["accent"], "finish review", { chip: true }),
    row("Buttons", "pending badge on the solid button (accent on bg)", "accent", 3.6, ["accent", "bg"], "pending", { chip: true }),
    row("Buttons", "plain button text (fg on bg-inset)", "fg", 4.5, ["bg-raised", "bg-inset"], "mark unit viewed", { chip: true }),
    row("Buttons", "selected row (fg on accent-soft)", "fg", 4.5, ["bg-raised", "accent-soft"], "1  Idempotent charge path"),
    row("Buttons", "selected row, muted (fg-muted on accent-soft)", "fg-muted", 3.2, ["bg-raised", "accent-soft"], "2 risks · changed · 1/3"),

    chip("core", "kind-core", "kind-core-soft"),
    chip("glue", "kind-glue", "kind-glue-soft"),
    chip("wiring", "kind-wiring", "kind-wiring-soft"),
    chip("ripple", "kind-ripple", "kind-ripple-soft"),
    chip("tests", "kind-tests", "kind-tests-soft"),
    chip("docs", "kind-docs", "kind-docs-soft"),
    chip("must-read", "risk", "risk-soft"),
    chip("skim", "warn", "warn-soft"),
    chip("verified", "ok", "ok-soft"),
    chip("changed", "warn", "warn-soft"),
    chip("bot", "bot", "bot-soft"),
    chip("agent", "agent", "agent-soft"),
    chip("heart", "heart", "heart-soft"),
    chip("chip on bg-inset: core", "kind-core", "kind-core-soft", "bg-inset"),
    chip("chip on bg-inset: risk", "risk", "risk-soft", "bg-inset"),
    row("Chips and badges", "age-1 (fresh request)", "age-1", 3.0, ["bg-raised"], "asked you 2h ago"),
    row("Chips and badges", "age-2 (waiting)", "age-2", 3.0, ["bg-raised"], "asked you 2d ago"),
    row("Chips and badges", "age-3 (stale)", "age-3", 3.0, ["bg-raised"], "asked you 9d ago"),

    row("Diff rows", "added line", "fg", 4.5, ["bg", "add-bg"], "+  return createHash(\"sha256\")", { mono: true }),
    row("Diff rows", "removed line", "fg", 4.5, ["bg", "del-bg"], "-  return md5(orderId)", { mono: true }),
    row("Diff rows", "added, strong (word highlight)", "fg", 4.5, ["bg", "add-bg", "add-bg-strong"], "createHash", { mono: true }),
    row("Diff rows", "removed, strong (word highlight)", "fg", 4.5, ["bg", "del-bg", "del-bg-strong"], "md5", { mono: true }),
    row("Diff rows", "line number on add gutter", "fg-faint", 2.4, ["bg", "add-gutter"], "509", { mono: true }),
    row("Diff rows", "line number on del gutter", "fg-faint", 2.4, ["bg", "del-gutter"], "502", { mono: true }),
    row("Diff rows", "moved in (violet)", "moved-fg", 3.0, ["bg", "moved-bg"], "+  func contactlessToolCallResults(", { mono: true }),
    row("Diff rows", "moved out (cyan)", "moved-out-fg", 3.0, ["bg", "moved-out-bg"], "-  func contactlessToolCallResults(", { mono: true }),
    row("Diff rows", "text on moved-in row", "fg", 4.5, ["bg", "moved-bg"], "+  results := make([]Result, 0)", { mono: true }),
    row("Diff rows", "search match over an added line", "fg", 4.5, ["bg", "add-bg", "search-match"], "idempotencyKey", { mono: true }),
    row("Diff rows", "active search match", "fg", 4.5, ["bg", "search-active"], "idempotencyKey", { mono: true }),
    row("Diff rows", "changed-in row wash over add", "fg", 4.5, ["bg", "add-bg", "changed-in-bg"], "+  currency: string,", { mono: true }),
    row("Diff rows", "hunk header (fg-muted on bg-hover)", "fg-muted", 3.2, ["bg", "bg-hover"], "@@ -18,10 +18,26 @@ export class ChargeService", { mono: true }),
    row("Diff rows", "focused hunk header (fg-muted on accent-soft)", "fg-muted", 3.2, ["bg", "bg-hover", "accent-soft"], "@@ -0,0 +1,14 @@", { mono: true }),
    row("Diff rows", "heart hunk header (fg-muted on heart-soft)", "fg-muted", 3.2, ["bg", "bg-hover", "heart-soft"], "@@ -499,20 +506,80 @@", { mono: true }),
    row("Diff rows", "heart why row (fg on heart-soft)", "fg", 4.5, ["bg", "heart-soft"], "short-circuits on the ledger row before touching the gateway"),
    row("Diff rows", "heart mark on heart-soft", "heart", 3.0, ["bg", "heart-soft"], "♥ heart"),
    row("Diff rows", "comment marker (accent on add-bg)", "accent", 3.0, ["bg", "add-bg"], "● 3"),
    ...(syn.comment
      ? [
          row("Syntax on diff rows", "code comment on a plain line", "syntax:comment", 3.0, ["bg"], "// TODO(ENG-5932): run the configured tools instead", { mono: true, fgOverride: syn.comment }),
          row("Syntax on diff rows", "code comment on an added line", "syntax:comment", 3.0, ["bg", "add-bg"], "+// wrapped for the live test; answers every call", { mono: true, fgOverride: syn.comment }),
          row("Syntax on diff rows", "code comment on a removed line", "syntax:comment", 3.0, ["bg", "del-bg"], "-// voiceToolNotAvailableResult answers every tool call", { mono: true, fgOverride: syn.comment }),
          row("Syntax on diff rows", "code comment, word highlight on added", "syntax:comment", 3.0, ["bg", "add-bg", "add-bg-strong"], "answerContactlessLiveTestToolCalls", { mono: true, fgOverride: syn.comment }),
          row("Syntax on diff rows", "code comment, word highlight on removed", "syntax:comment", 3.0, ["bg", "del-bg", "del-bg-strong"], "voiceToolNotAvailableResult", { mono: true, fgOverride: syn.comment }),
        ]
      : []),
    ...(syn.string
      ? [
          row("Syntax on diff rows", "string on an added line", "syntax:string", 4.5, ["bg", "add-bg"], "+  \"La herramienta no está disponible.\"", { mono: true, fgOverride: syn.string }),
          row("Syntax on diff rows", "string on a removed line", "syntax:string", 4.5, ["bg", "del-bg"], "-  \"La herramienta no está disponible.\"", { mono: true, fgOverride: syn.string }),
        ]
      : []),
    ...(syn.keyword
      ? [
          row("Syntax on diff rows", "keyword on an added line", "syntax:keyword", 4.5, ["bg", "add-bg"], "+  return results, nil", { mono: true, fgOverride: syn.keyword }),
          row("Syntax on diff rows", "keyword on a removed line", "syntax:keyword", 4.5, ["bg", "del-bg"], "-  func contactlessToolCallResults(", { mono: true, fgOverride: syn.keyword }),
        ]
      : []),

    row("Code and prose", "code span (fg on bg-inset)", "fg", 4.5, ["bg-raised", "bg-inset"], "charge()", { mono: true, chip: true }),
    row("Code and prose", "code span in muted prose", "fg-muted", 3.2, ["bg-raised", "bg-inset"], "src/billing/ledger.ts", { mono: true, chip: true }),
    row("Code and prose", "tooltip (fg on bg-raised)", "fg", 4.5, ["bg-raised"], "Comments, chat and review  m c r"),
    row("Code and prose", "placeholder (fg-faint on bg-inset)", "fg-faint", 2.4, ["bg-raised", "bg-inset"], "Ask about this PR…  (↵ send · ⇧↵ newline)"),
    row("Code and prose", "agent note card (fg on agent-soft)", "fg", 4.5, ["bg-raised", "agent-soft"], "Rename this before merging; the old name leaks."),
    row("Code and prose", "warn banner (warn on warn-soft)", "warn", 3.4, ["bg-raised", "warn-soft"], "Clear this conversation? It cannot be recovered."),
    row("Code and prose", "risk banner (risk on risk-soft)", "risk", 3.4, ["bg-raised", "risk-soft"], "Analysis failed: claude exited with code 3"),
    row("Code and prose", "border on bg (divider)", "border", 1.25, ["bg"], "", { swatch: true }),
    row("Code and prose", "border-strong on bg-raised (control outline)", "border-strong", 1.5, ["bg-raised"], "", { swatch: true }),
  ];
}

/* -------------------------------------------------------------- the page */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

const sections = [];
const summary = [];
for (const theme of THEMES) {
  const t = tokensFor(theme);
  const rows = contexts(t, await syntaxColors(theme)).map((r) => {
    const ratioValue = ratio(r.fg, r.bg);
    const aa = r.swatch ? ratioValue >= 3.0 : ratioValue >= 4.5;
    const pass = ratioValue >= r.floor;
    return { ...r, ratio: ratioValue, pass, aa };
  });
  const fails = rows.filter((r) => !r.pass);
  const belowAA = rows.filter((r) => r.pass && !r.aa && !r.swatch);
  summary.push({ theme, fails, belowAA, worst: [...rows].sort((a, b) => a.ratio / a.floor - b.ratio / b.floor)[0] });

  const groups = new Map();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);

  sections.push(`
<section class="theme" id="${esc(theme.id)}" data-mode="${theme.mode}" data-fails="${fails.length}"
  style="--bg:${t.bg};--bg-raised:${t["bg-raised"]};--bg-inset:${t["bg-inset"]};--fg:${t.fg};--fg-muted:${t["fg-muted"]};--fg-faint:${t["fg-faint"]};--border:${t.border};--border-strong:${t["border-strong"]};--accent:${t.accent}">
  <header class="theme-head">
    <h2>${esc(theme.label)} <span class="mode">${theme.mode}</span><span class="group">${esc(theme.group)}</span></h2>
    <p class="theme-sum">${fails.length ? `<b class="bad">${fails.length} below floor</b>` : `<b class="good">all above floor</b>`} · ${belowAA.length} pass their floor but miss AA 4.5 · palette ${["bg", "fg", "red", "orange", "yellow", "green", "blue", "purple"].map((k) => `<i class="sw" style="background:${theme.palette[k]}" title="${k} ${theme.palette[k]}"></i>`).join("")}</p>
  </header>
  ${[...groups]
    .map(
      ([name, list]) => `
  <h3>${esc(name)}</h3>
  <table>
    <thead><tr><th>context</th><th>as it renders</th><th>fg</th><th>on</th><th class="num">ratio</th><th class="num">floor</th><th>AA</th></tr></thead>
    <tbody>
    ${list
      .map(
        (r) => `
      <tr class="${r.pass ? "ok" : "fail"}" data-pass="${r.pass}">
        <td class="ctx">${esc(r.label)}</td>
        <td class="sample-cell" style="background:${css(r.bg)}">
          ${
            r.swatch
              ? `<span class="sw-line" style="background:${css(r.fg)}"></span>`
              : `<span class="sample${r.chip ? " chip" : ""}${r.mono ? " mono" : ""}" style="color:${css(r.fg)}${r.chip ? `;background:${css(r.bg)}` : ""}">${esc(r.sample)}</span>`
          }
        </td>
        <td class="tok"><i class="sw" style="background:${css(r.fg)}"></i>${esc(r.fgTok)}</td>
        <td class="tok"><i class="sw" style="background:${css(r.bg)}"></i>${esc(r.bgDesc)}</td>
        <td class="num ${r.pass ? "" : "bad"}">${fmt(r.ratio)}</td>
        <td class="num">${r.floor.toFixed(1)}</td>
        <td class="aa">${r.swatch ? "" : r.aa ? "AA" : r.ratio >= 3 ? "AA large" : "—"}</td>
      </tr>`,
      )
      .join("")}
    </tbody>
  </table>`,
    )
    .join("")}
</section>`);
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Purview contrast sheet</title>
<style>
  :root { color-scheme: light dark; font: 13px/1.45 "IBM Plex Sans", system-ui, sans-serif; }
  body { margin: 0; background: #111; color: #ddd; }
  @media (prefers-color-scheme: light) { body { background: #f3f4f6; color: #222; } }
  .top { position: sticky; top: 0; z-index: 2; background: inherit; border-bottom: 1px solid #8884; padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .top h1 { font-size: 15px; margin: 0 12px 0 0; }
  .top label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
  .top a { color: inherit; opacity: .8; text-decoration: none; padding: 2px 6px; border-radius: 4px; border: 1px solid #8884; }
  .top a[data-fails]:not([data-fails="0"]) { border-color: #e55; }
  .theme { padding: 12px 16px 24px; background: var(--bg); color: var(--fg); border-bottom: 8px solid #8882; }
  .theme-head h2 { margin: 0; font-size: 16px; display: flex; gap: 10px; align-items: baseline; }
  .theme-head .mode, .theme-head .group { font-size: 11px; font-weight: 500; color: var(--fg-faint); }
  .theme-sum { margin: 4px 0 0; font-size: 12px; color: var(--fg-muted); }
  .theme-sum .sw { margin-left: 2px; }
  .good { color: #3c3; } .bad { color: #e55; font-weight: 600; }
  h3 { font-size: 12px; margin: 16px 0 4px; color: var(--fg-muted); font-weight: 600; letter-spacing: .01em; }
  table { border-collapse: collapse; width: 100%; max-width: 1180px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; font-size: 12px; }
  th { color: var(--fg-faint); font-weight: 500; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .ctx { color: var(--fg-muted); width: 24%; }
  .tok { color: var(--fg-faint); font-family: ui-monospace, Menlo, monospace; font-size: 11px; white-space: nowrap; }
  .sample-cell { width: 36%; }
  .sample { white-space: nowrap; }
  .sample.mono { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; }
  .sample.chip { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 5px; border: 1px solid #8886; }
  .sw-line { display: block; height: 1px; width: 160px; margin: 6px 0; }
  tr.fail .ctx { color: #e55; }
  tr.fail .ctx::before { content: "✕ "; }
  body.only-fails tr[data-pass="true"] { display: none; }
  body.only-fails .theme[data-fails="0"] { display: none; }
  .aa { color: var(--fg-faint); font-size: 11px; }
</style>
</head>
<body>
<div class="top">
  <h1>Purview contrast sheet</h1>
  <label><input type="checkbox" id="only"> only failures</label>
  <span style="opacity:.7">WCAG ratios, translucent tokens composited over their real backdrop. Floor = what the app's token derivation promises for that context; AA = WCAG 4.5 (3.0 for large text and UI outlines). Syntax rows use the colors shiki paints for the theme (comment, string, keyword scopes).</span>
  <nav style="display:flex;flex-wrap:wrap;gap:6px;width:100%">
    ${summary.map((s) => `<a href="#${esc(s.theme.id)}" data-fails="${s.fails.length}">${esc(s.theme.label)}${s.fails.length ? ` · ${s.fails.length}` : ""}</a>`).join("")}
  </nav>
</div>
${sections.join("\n")}
<script>
  const only = document.getElementById("only");
  only.addEventListener("change", () => document.body.classList.toggle("only-fails", only.checked));
</script>
</body>
</html>`;

fs.writeFileSync(out, html);
const totalFails = summary.reduce((n, s) => n + s.fails.length, 0);
console.log(`${out}\n${THEMES.length} themes, ${totalFails} pairings below their floor`);
for (const s of summary) {
  if (s.fails.length) console.log(`  ${s.theme.label}: ${s.fails.map((f) => `${f.label} (${fmt(f.ratio)} < ${f.floor})`).join("; ")}`);
}
