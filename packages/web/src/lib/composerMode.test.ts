import { describe, expect, it } from "vitest";
import { isPreviewToggleKey, rememberMode, rememberedMode, toggledMode } from "./composerMode";

const key = (over: Partial<Parameters<typeof isPreviewToggleKey>[0]>) => ({
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("isPreviewToggleKey", () => {
  it("matches ⌘⇧P and Ctrl+Shift+P, whatever case the key arrives in", () => {
    expect(isPreviewToggleKey(key({ metaKey: true, shiftKey: true, key: "P" }))).toBe(true);
    expect(isPreviewToggleKey(key({ metaKey: true, shiftKey: true, key: "p" }))).toBe(true);
    expect(isPreviewToggleKey(key({ ctrlKey: true, shiftKey: true, key: "P" }))).toBe(true);
  });

  it("leaves plain typing, ⌘P and Alt chords alone", () => {
    expect(isPreviewToggleKey(key({}))).toBe(false);
    expect(isPreviewToggleKey(key({ key: "P", shiftKey: true }))).toBe(false);
    expect(isPreviewToggleKey(key({ metaKey: true }))).toBe(false);
    expect(isPreviewToggleKey(key({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    // ⌘⇧↵ (ask chat) and ⌘⇧F (search all) share the modifiers, not the key.
    expect(isPreviewToggleKey(key({ metaKey: true, shiftKey: true, key: "Enter" }))).toBe(false);
    expect(isPreviewToggleKey(key({ metaKey: true, shiftKey: true, key: "F" }))).toBe(false);
  });
});

describe("toggledMode", () => {
  it("flips between the two modes", () => {
    expect(toggledMode("write")).toBe("preview");
    expect(toggledMode("preview")).toBe("write");
  });
});

describe("remembered mode", () => {
  it("starts in Write and hands the next editor the last choice", () => {
    expect(rememberedMode()).toBe("write");
    rememberMode("preview");
    expect(rememberedMode()).toBe("preview");
    rememberMode("write");
    expect(rememberedMode()).toBe("write");
  });
});
