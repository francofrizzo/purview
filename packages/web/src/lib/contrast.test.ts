import { beforeAll, describe, expect, it } from "vitest";
import { createHighlighter } from "shiki";
import { SYNTAX_SNIPPET, checkTheme, contrastSurfaces, readSyntaxColors, type SyntaxColors } from "./contrast";
import { THEMES, shikiThemeFor, tokensFor } from "./themes";

/**
 * Every shipped theme clears every surface's floor (contrast.ts), or says
 * where it does not and by how much (ThemeDef.contrast). Adding a theme
 * that reads badly somewhere therefore fails here, with the surface named,
 * and so does an allowance that is no longer earning its keep.
 */

const syntaxByTheme = new Map<string, SyntaxColors>();

beforeAll(async () => {
  const hl = await createHighlighter({ langs: ["ts"], themes: [] });
  for (const theme of THEMES) {
    const entry = shikiThemeFor(theme);
    await hl.loadTheme(entry.raw ?? (entry.name as never));
    const { tokens } = hl.codeToTokens(SYNTAX_SNIPPET, { lang: "ts", theme: entry.raw ? entry.raw.name : entry.name });
    syntaxByTheme.set(theme.id, readSyntaxColors(tokens));
  }
}, 60_000);

describe("contrast surfaces", () => {
  it("have unique ids", () => {
    const ids = contrastSurfaces({ comment: "#888", string: "#888", keyword: "#888" }).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("read the three syntax colors off a highlighted snippet", () => {
    const syntax = syntaxByTheme.get("reviewer-dark")!;
    expect(syntax.comment).toMatch(/^#/);
    expect(syntax.string).toMatch(/^#/);
    expect(syntax.keyword).toMatch(/^#/);
  });
});

describe.each(THEMES.map((t) => [t.label, t] as const))("%s", (_label, theme) => {
  it("clears every surface's floor, or declares the exception", () => {
    const { failures } = checkTheme(theme, tokensFor(theme), syntaxByTheme.get(theme.id));
    expect(
      failures.map((f) => `${f.id}: ${f.ratio.toFixed(2)} < ${f.effectiveFloor} (${f.label})`),
    ).toEqual([]);
  });

  it("carries no allowance it no longer needs", () => {
    const { staleAllowances } = checkTheme(theme, tokensFor(theme), syntaxByTheme.get(theme.id));
    expect(staleAllowances).toEqual([]);
  });
});
