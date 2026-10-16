#!/usr/bin/env node
/**
 * Contrast sheet: one local HTML page that renders every theme's tokens in
 * the contexts the app actually puts them in and scores each pairing with
 * its WCAG contrast ratio against the floor that context needs.
 *
 *   pnpm contrast-sheet [out.html]      (from packages/web)
 *
 * The surfaces come from src/lib/contrast.ts, the same list themes.test.ts
 * enforces, so the sheet shows exactly what the test checks: a surface added
 * there appears here. Themes load from src/lib/themes.ts through Vite, so
 * nothing can drift from what the app ships. Syntax rows use the colors
 * shiki paints for the theme, read off a highlighted snippet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "contrast-sheet.html"));

const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { THEMES, tokensFor, shikiThemeFor } = await server.ssrLoadModule("/src/lib/themes.ts");
const { SYNTAX_SNIPPET, checkTheme, readSyntaxColors } = await server.ssrLoadModule("/src/lib/contrast.ts");
await server.close();
const { createHighlighter } = await import("shiki");

const highlighter = await createHighlighter({ langs: ["ts"], themes: [] });
async function syntaxColors(theme) {
  const entry = shikiThemeFor(theme);
  await highlighter.loadTheme(entry.raw ?? entry.name);
  const name = entry.raw ? entry.raw.name : entry.name;
  return readSyntaxColors(highlighter.codeToTokens(SYNTAX_SNIPPET, { lang: "ts", theme: name }).tokens);
}

/* -------------------------------------------------------------- the page */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

const sections = [];
const summary = [];
for (const theme of THEMES) {
  const t = tokensFor(theme);
  const { results: rows, failures: fails, staleAllowances } = checkTheme(theme, t, await syntaxColors(theme));
  const scale = theme.contrast?.floorScale;
  const allowed = rows.filter((r) => r.allowed || (scale !== undefined && r.ratio < r.floor));
  const belowAA = rows.filter((r) => r.pass && !r.aa && r.kind !== "swatch");
  summary.push({ theme, fails, allowed, staleAllowances });

  const groups = new Map();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);

  sections.push(`
<section class="theme" id="${esc(theme.id)}" data-mode="${theme.mode}" data-fails="${fails.length}"
  style="--bg:${t.bg};--bg-raised:${t["bg-raised"]};--bg-inset:${t["bg-inset"]};--fg:${t.fg};--fg-muted:${t["fg-muted"]};--fg-faint:${t["fg-faint"]};--border:${t.border};--border-strong:${t["border-strong"]};--accent:${t.accent}">
  <header class="theme-head">
    <h2>${esc(theme.label)} <span class="mode">${theme.mode}</span><span class="group">${esc(theme.group)}</span></h2>
    <p class="theme-sum">${fails.length ? `<b class="bad">${fails.length} below floor</b>` : `<b class="good">all above floor</b>`}${
      scale ? ` · floors scaled to ${Math.round(scale * 100)}% (low-contrast palette by design)` : ""
    }${allowed.length ? ` · ${allowed.length} under the usual floor by declared allowance` : ""} · ${belowAA.length} pass their floor but miss AA 4.5 · palette ${["bg", "fg", "red", "orange", "yellow", "green", "blue", "purple"].map((k) => `<i class="sw" style="background:${theme.palette[k]}" title="${k} ${theme.palette[k]}"></i>`).join("")}</p>
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
      <tr class="${r.pass ? "ok" : "fail"}" data-pass="${r.pass}" id="${esc(theme.id)}--${esc(r.id)}">
        <td class="ctx" title="${esc(r.id)}">${esc(r.label)}</td>
        <td class="sample-cell" style="background:${r.bgColor}">
          ${
            r.kind === "swatch"
              ? `<span class="sw-line" style="background:${r.fgColor}"></span>`
              : `<span class="sample${r.kind === "chip" ? " chip" : ""}${r.kind === "mono" ? " mono" : ""}" style="color:${r.fgColor}${r.kind === "chip" ? `;background:${r.bgColor}` : ""}">${esc(r.sample)}</span>`
          }
        </td>
        <td class="tok"><i class="sw" style="background:${r.fgColor}"></i>${esc(r.fg)}${r.lift ? ` ↑${Math.round(r.lift * 100)}%` : ""}</td>
        <td class="tok"><i class="sw" style="background:${r.bgColor}"></i>${esc(r.layers.join(" / "))}</td>
        <td class="num ${r.pass ? "" : "bad"}">${fmt(r.ratio)}</td>
        <td class="num" title="${r.allowed ? "declared allowance" : scale ? "scaled floor" : "the surface's floor"}">${r.effectiveFloor.toFixed(2).replace(/0$/, "")}${r.allowed ? "*" : ""}</td>
        <td class="aa">${r.kind === "swatch" ? "" : r.aa ? "AA" : r.ratio >= 3 ? "AA large" : "—"}</td>
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
  <span style="opacity:.7">WCAG ratios, translucent tokens composited over their real backdrop. Floor = what the app's token derivation promises for that context (src/lib/contrast.ts, the same list themes.test.ts enforces); * = a floor the theme declares for itself; AA = WCAG 4.5 (3.0 for large text and outlines). Syntax rows use the colors shiki paints for the theme.</span>
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
  if (s.fails.length) console.log(`  ${s.theme.label}: ${s.fails.map((f) => `${f.label} (${fmt(f.ratio)} < ${f.effectiveFloor})`).join("; ")}`);
  if (s.staleAllowances.length) console.log(`  ${s.theme.label}: stale allowance ${s.staleAllowances.join(", ")}`);
}
