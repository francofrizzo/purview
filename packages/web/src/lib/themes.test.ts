import { describe, expect, it } from "vitest";
import { contrast, mix, readable } from "./color";
import {
  REVIEWER_DARK,
  THEMES,
  TOKEN_NAMES,
  buildTextMateTheme,
  deriveTokens,
  resolveTheme,
  shikiThemeFor,
  tokensFor,
} from "./themes";

describe("color helpers", () => {
  it("mixes toward the second color", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("lifts a color until it clears the contrast floor", () => {
    const lifted = readable("#333333", "#000000", 4);
    expect(contrast(lifted, "#000000")).toBeGreaterThanOrEqual(4);
  });

  it("leaves an already-legible color alone", () => {
    expect(readable("#ffffff", "#000000", 4)).toBe("#ffffff");
  });
});

describe("deriveTokens", () => {
  const theme = THEMES.find((t) => t.id === "dracula")!;

  it("produces every token the app reads", () => {
    const tokens = deriveTokens(theme.palette, theme.mode);
    for (const name of TOKEN_NAMES) {
      expect(tokens[name], name).toBeTruthy();
    }
    expect(Object.keys(tokens).sort()).toEqual([...TOKEN_NAMES].sort());
  });

  it("keeps the palette background as the app background", () => {
    expect(deriveTokens(theme.palette, theme.mode).bg).toBe(theme.palette.bg);
  });

  it("derives diff tints from the palette's green and red", () => {
    const tokens = deriveTokens(theme.palette, theme.mode);
    expect(tokens["add-bg"]).toContain("rgba(80, 250, 123");
    expect(tokens["del-bg"]).toContain("rgba(255, 85, 85");
    // the strong (intra-line) tint must be more opaque than the row tint
    const alpha = (v: string) => Number(v.slice(v.lastIndexOf(",") + 1, -1));
    expect(alpha(tokens["add-bg-strong"])).toBeGreaterThan(alpha(tokens["add-bg"]));
  });

  it("gives every theme a search mark whose active state is the stronger one", () => {
    const alpha = (v: string) => Number(v.slice(v.lastIndexOf(",") + 1, -1));
    for (const t of THEMES) {
      const tokens = tokensFor(t);
      expect(tokens["search-match"], t.id).toMatch(/^rgba\(/);
      expect(alpha(tokens["search-active"]), t.id).toBeGreaterThan(alpha(tokens["search-match"]));
    }
  });

  it("does not regress the app's own dark theme", () => {
    const tokens = tokensFor(REVIEWER_DARK);
    expect(tokens.bg).toBe("#0c0d10");
    expect(tokens["bg-raised"]).toBe("#131519");
    expect(tokens.accent).toBe("#7aa2f7");
    expect(tokens["add-bg"]).toBe("rgba(63, 185, 80, 0.1)");
    expect(tokens.ok).toBe("#4ec27f");
    expect(tokens["kind-core"]).toBe("#c4a7ff");
  });
});

describe("every shipped theme", () => {
  it.each(THEMES.map((t) => [t.id, t] as const))("%s stays legible and coherent", (_id, theme) => {
    const tokens = tokensFor(theme);
    // status colors must be readable on the theme's own background
    for (const key of ["accent", "ok", "risk", "warn", "fg", "fg-muted"] as const) {
      expect(contrast(tokens[key], tokens.bg), key).toBeGreaterThanOrEqual(3);
    }
    // and the chips must not collapse into each other
    const chips = ["kind-core", "kind-glue", "kind-ripple", "kind-tests", "kind-wiring"] as const;
    for (let i = 0; i < chips.length; i++) {
      for (let j = i + 1; j < chips.length; j++) {
        expect(tokens[chips[i]], `${chips[i]} vs ${chips[j]}`).not.toBe(tokens[chips[j]]);
      }
    }
    // backgrounds must be layered, not identical
    expect(tokens["bg-raised"]).not.toBe(tokens.bg);
    expect(tokens["bg-inset"]).not.toBe(tokens.bg);
  });

  it("gives every theme a unique id and a shiki theme name", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of THEMES) expect(t.shiki).toBeTruthy();
  });

  it("memoizes the shiki descriptor so hooks see a stable identity", () => {
    const t = THEMES.find((x) => x.id === "monokai-pro-spectrum")!;
    expect(shikiThemeFor(t)).toBe(shikiThemeFor(t));
    expect(shikiThemeFor(t).raw).toBeDefined();
    expect(shikiThemeFor(THEMES[0]).raw).toBeUndefined();
  });
});

describe("resolveTheme", () => {
  it("maps system to the app's own pair", () => {
    expect(resolveTheme("system", false).id).toBe("reviewer-dark");
    expect(resolveTheme("system", true).id).toBe("reviewer-light");
  });

  it("falls back for an unknown id", () => {
    expect(resolveTheme("gone", false).id).toBe("reviewer-dark");
    expect(resolveTheme("", true).id).toBe("reviewer-light");
  });
});

describe("buildTextMateTheme", () => {
  const theme = buildTextMateTheme("test", THEMES.find((t) => t.id === "dracula")!.palette);

  it("emits a global setting plus scoped rules", () => {
    expect(theme.tokenColors[0].scope).toBeUndefined();
    expect(theme.tokenColors[0].settings.foreground).toBe("#f8f8f2");
    expect(theme.colors["editor.background"]).toBe("#282a36");
    expect(theme.tokenColors.length).toBeGreaterThan(10);
  });

  it("maps comments and strings to the palette", () => {
    const scopeOf = (scope: string) =>
      theme.tokenColors.find((t) => (t.scope ? [t.scope].flat().includes(scope) : false));
    expect(scopeOf("comment")?.settings.foreground).toBe("#6272a4");
    expect(scopeOf("string")?.settings.foreground).toBe("#f1fa8c");
  });
});
