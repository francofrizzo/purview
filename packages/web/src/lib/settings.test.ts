import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  fontStack,
  lineHeightFor,
  parseSettings,
  readLegacySettings,
  resolveAppearance,
  CODE_FONT_FALLBACK,
  UI_FONT_FALLBACK,
} from "./settings";

describe("parseSettings", () => {
  it("returns the defaults for missing or unusable input", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps known keys and drops everything else", () => {
    const out = parseSettings({ themeId: "dracula", nope: 1, codeFont: " Fira Code " });
    expect(out.themeId).toBe("dracula");
    expect(out.codeFont).toBe("Fira Code");
    expect(out).not.toHaveProperty("nope");
    expect(Object.keys(out).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it("falls back per key when a value has the wrong shape", () => {
    const out = parseSettings({
      themeId: 42,
      tabSize: 3,
      diffViewMode: "sideways",
      diffWrap: "yes",
      useCodeFontForUi: 1,
    });
    expect(out.themeId).toBe(DEFAULT_SETTINGS.themeId);
    expect(out.tabSize).toBe(DEFAULT_SETTINGS.tabSize);
    expect(out.diffViewMode).toBe(DEFAULT_SETTINGS.diffViewMode);
    expect(out.diffWrap).toBe(DEFAULT_SETTINGS.diffWrap);
    expect(out.useCodeFontForUi).toBe(DEFAULT_SETTINGS.useCodeFontForUi);
  });

  it("clamps and rounds the code font size", () => {
    expect(parseSettings({ codeFontSize: 2 }).codeFontSize).toBe(11);
    expect(parseSettings({ codeFontSize: 99 }).codeFontSize).toBe(16);
    expect(parseSettings({ codeFontSize: 13.6 }).codeFontSize).toBe(14);
    expect(parseSettings({ codeFontSize: Number.NaN }).codeFontSize).toBe(
      DEFAULT_SETTINGS.codeFontSize,
    );
  });

  it("lets legacy values fill keys the stored object lacks, but never override them", () => {
    const legacy = { diffViewMode: "split" as const, diffWrap: false };
    expect(parseSettings(null, legacy).diffViewMode).toBe("split");
    expect(parseSettings({}, legacy).diffWrap).toBe(false);
    expect(parseSettings({ diffViewMode: "unified" }, legacy).diffViewMode).toBe("unified");
  });
});

describe("readLegacySettings", () => {
  const storage = (data: Record<string, string>) => ({
    getItem: (k: string) => data[k] ?? null,
  });

  it("migrates the standalone diff preferences", () => {
    expect(
      readLegacySettings(
        storage({ "reviewer.diffViewMode": "split", "reviewer.diffWrap": "off" }),
      ),
    ).toEqual({ diffViewMode: "split", diffWrap: false });
  });

  it("ignores unknown values and absent storage", () => {
    expect(readLegacySettings(storage({ "reviewer.diffViewMode": "weird" }))).toEqual({});
    expect(readLegacySettings(null)).toEqual({});
  });

  it("survives a throwing storage", () => {
    const hostile = {
      getItem() {
        throw new Error("blocked");
      },
    };
    expect(readLegacySettings(hostile)).toEqual({});
  });
});

describe("fontStack", () => {
  it("falls back to the built-in stack when no family is set", () => {
    expect(fontStack("", CODE_FONT_FALLBACK)).toBe(CODE_FONT_FALLBACK);
    expect(fontStack("   ", CODE_FONT_FALLBACK)).toBe(CODE_FONT_FALLBACK);
  });

  it("quotes a family and appends the fallback chain", () => {
    expect(fontStack("JetBrains Mono", CODE_FONT_FALLBACK)).toBe(
      `"JetBrains Mono", ${CODE_FONT_FALLBACK}`,
    );
  });

  it("leaves generic families unquoted", () => {
    expect(fontStack("monospace", CODE_FONT_FALLBACK)).toBe(`monospace, ${CODE_FONT_FALLBACK}`);
  });

  it("strips characters that could escape the declaration", () => {
    expect(fontStack('Evil"; color: red', CODE_FONT_FALLBACK)).toBe(
      `"Evil color: red", ${CODE_FONT_FALLBACK}`,
    );
  });
});

describe("resolveAppearance", () => {
  it("follows the system preference for the default theme", () => {
    expect(resolveAppearance(DEFAULT_SETTINGS, false).theme.id).toBe("reviewer-dark");
    expect(resolveAppearance(DEFAULT_SETTINGS, true).theme.id).toBe("reviewer-light");
  });

  it("pins an explicit theme regardless of the system preference", () => {
    const s = { ...DEFAULT_SETTINGS, themeId: "monokai-pro-octagon" };
    expect(resolveAppearance(s, true).theme.id).toBe("monokai-pro-octagon");
  });

  it("falls back to the default pair for a theme id that no longer exists", () => {
    const s = { ...DEFAULT_SETTINGS, themeId: "removed-theme" };
    expect(resolveAppearance(s, false).theme.id).toBe("reviewer-dark");
  });

  it("only shares the code font with the UI when asked", () => {
    const s = { ...DEFAULT_SETTINGS, codeFont: "Fira Code" };
    expect(resolveAppearance(s, false).uiFont).toBe(UI_FONT_FALLBACK);
    expect(resolveAppearance({ ...s, useCodeFontForUi: true }, false).uiFont).toBe(
      `"Fira Code", ${CODE_FONT_FALLBACK}`,
    );
  });

  it("derives a line height from the code font size", () => {
    expect(lineHeightFor(12)).toBe(20);
    expect(resolveAppearance({ ...DEFAULT_SETTINGS, codeFontSize: 16 }, false).codeLineHeight).toBe(
      lineHeightFor(16),
    );
  });
});
