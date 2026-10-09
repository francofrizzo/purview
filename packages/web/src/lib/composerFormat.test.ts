import { describe, expect, it } from "vitest";
import {
  applyFormat,
  continueList,
  formatActionFor,
  linkify,
  pasteUrlOverSelection,
  toggleLinePrefix,
  wrapSelection,
  type TextEdit,
} from "./composerFormat";

/** The edit, with the selection drawn in as «…» so a test reads like the screen. */
const shown = (e: TextEdit) => `${e.text.slice(0, e.start)}«${e.text.slice(e.start, e.end)}»${e.text.slice(e.end)}`;

describe("wrapSelection", () => {
  it("wraps the selected words and keeps them selected", () => {
    expect(shown(wrapSelection("make it bold", { start: 8, end: 12 }, "**"))).toBe("make it **«bold»**");
    expect(shown(wrapSelection("a b", { start: 2, end: 3 }, "`"))).toBe("a `«b»`");
  });

  it("unwraps when the markers are selected, or hug the selection", () => {
    expect(shown(wrapSelection("make it **bold**", { start: 8, end: 16 }, "**"))).toBe("make it «bold»");
    expect(shown(wrapSelection("make it **bold**", { start: 10, end: 14 }, "**"))).toBe("make it «bold»");
  });

  it("puts the markers in with the caret between them when nothing is selected", () => {
    expect(shown(wrapSelection("ab", { start: 1, end: 1 }, "_"))).toBe("a_«»_b");
  });

  it("accepts a backwards selection", () => {
    expect(shown(wrapSelection("x y", { start: 3, end: 2 }, "**"))).toBe("x **«y»**");
  });
});

describe("linkify", () => {
  it("links the selection and selects the url placeholder", () => {
    expect(shown(linkify("see docs now", { start: 4, end: 8 }))).toBe("see [docs](«url») now");
  });

  it("inserts an empty link with the caret in the brackets", () => {
    expect(shown(linkify("see ", { start: 4, end: 4 }))).toBe("see [«»](url)");
  });

  it("unwraps a selected link back to its text", () => {
    expect(shown(linkify("see [docs](https://x.y) now", { start: 4, end: 23 }))).toBe("see «docs» now");
  });
});

describe("pasteUrlOverSelection", () => {
  it("turns the selected words into a link to the pasted url", () => {
    expect(shown(pasteUrlOverSelection("read the docs", { start: 9, end: 13 }, "https://x.y/d")!)).toBe(
      "read the [docs](https://x.y/d)«»",
    );
  });

  it("stays out of the way for a plain paste, no selection, or a selected url", () => {
    expect(pasteUrlOverSelection("read the docs", { start: 9, end: 13 }, "words")).toBeNull();
    expect(pasteUrlOverSelection("read the docs", { start: 9, end: 13 }, "see https://x.y")).toBeNull();
    expect(pasteUrlOverSelection("read the docs", { start: 9, end: 9 }, "https://x.y")).toBeNull();
    expect(pasteUrlOverSelection("https://a.b", { start: 0, end: 11 }, "https://x.y")).toBeNull();
  });
});

describe("toggleLinePrefix", () => {
  it("adds a bullet to each selected line and selects the lines", () => {
    expect(shown(toggleLinePrefix("one\ntwo\nthree", { start: 1, end: 5 }, "bullet"))).toBe("«- one\n- two»\nthree");
  });

  it("numbers an ordered list from 1 and removes it again", () => {
    const on = toggleLinePrefix("a\nb", { start: 0, end: 3 }, "ordered");
    expect(shown(on)).toBe("«1. a\n2. b»");
    expect(shown(toggleLinePrefix(on.text, { start: on.start, end: on.end }, "ordered"))).toBe("«a\nb»");
  });

  it("swaps one list marker for another instead of stacking them", () => {
    expect(toggleLinePrefix("- a\n- b", { start: 0, end: 7 }, "task").text).toBe("- [ ] a\n- [ ] b");
    expect(toggleLinePrefix("- [ ] a\n- [x] b", { start: 0, end: 15 }, "bullet").text).toBe("- a\n- b");
    expect(toggleLinePrefix("1. a", { start: 0, end: 4 }, "bullet").text).toBe("- a");
  });

  it("quotes list items without touching the marker, and unquotes", () => {
    expect(toggleLinePrefix("- a\n- b", { start: 0, end: 7 }, "quote").text).toBe("> - a\n> - b");
    expect(toggleLinePrefix("> a\n> b", { start: 0, end: 7 }, "quote").text).toBe("a\nb");
  });

  it("keeps a bare caret on its character", () => {
    expect(shown(toggleLinePrefix("hello", { start: 3, end: 3 }, "bullet"))).toBe("- hel«»lo");
    expect(shown(toggleLinePrefix("- hello", { start: 5, end: 5 }, "bullet"))).toBe("hel«»lo");
    expect(shown(toggleLinePrefix("- hello", { start: 1, end: 1 }, "bullet"))).toBe("«»hello");
    expect(shown(toggleLinePrefix("", { start: 0, end: 0 }, "task"))).toBe("- [ ] «»");
  });

  it("does not reach the next line when the selection ends after a newline", () => {
    expect(toggleLinePrefix("a\nb\n", { start: 0, end: 2 }, "bullet").text).toBe("- a\nb\n");
  });

  it("keeps indentation in front of the marker", () => {
    expect(toggleLinePrefix("  a", { start: 0, end: 3 }, "bullet").text).toBe("  - a");
  });
});

describe("continueList", () => {
  it("continues bullets, numbers and task boxes", () => {
    expect(shown(continueList("- one", 5)!)).toBe("- one\n- «»");
    expect(shown(continueList("* one", 5)!)).toBe("* one\n* «»");
    expect(shown(continueList("1. one", 6)!)).toBe("1. one\n2. «»");
    expect(shown(continueList("- [x] done", 10)!)).toBe("- [x] done\n- [ ] «»");
    expect(shown(continueList("  - one", 7)!)).toBe("  - one\n  - «»");
  });

  it("ends the list on an empty item", () => {
    expect(shown(continueList("- one\n- ", 8)!)).toBe("- one\n«»");
    expect(shown(continueList("- [ ] ", 6)!)).toBe("«»");
  });

  it("moves the rest of the line onto the new item", () => {
    expect(shown(continueList("- one two", 5)!)).toBe("- one\n- «» two");
  });

  it("is a plain newline off a list or inside the marker", () => {
    expect(continueList("plain", 5)).toBeNull();
    expect(continueList("- one", 1)).toBeNull();
    expect(continueList("1.5 is a number", 15)).toBeNull();
  });
});

describe("formatActionFor", () => {
  const key = (over: Partial<Parameters<typeof formatActionFor>[0]>) => ({
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("maps ⌘B/I/E/K and the ⌘⇧ list and quote chords, by key or physical key", () => {
    expect(formatActionFor(key({ metaKey: true, key: "b" }))).toBe("bold");
    expect(formatActionFor(key({ ctrlKey: true, key: "I" }))).toBe("italic");
    expect(formatActionFor(key({ metaKey: true, key: "e" }))).toBe("code");
    expect(formatActionFor(key({ metaKey: true, key: "k" }))).toBe("link");
    expect(formatActionFor(key({ metaKey: true, shiftKey: true, key: "&", code: "Digit7" }))).toBe("ordered");
    expect(formatActionFor(key({ metaKey: true, shiftKey: true, key: "8" }))).toBe("bullet");
    expect(formatActionFor(key({ metaKey: true, shiftKey: true, key: ">", code: "Period" }))).toBe("quote");
    expect(formatActionFor(key({ metaKey: true, shiftKey: true, key: "S", code: "KeyS" }))).toBe("suggestion");
    expect(formatActionFor(key({ ctrlKey: true, shiftKey: true, key: "s" }))).toBe("suggestion");
  });

  it("leaves the other editor chords, plain typing and Alt alone", () => {
    expect(formatActionFor(key({ key: "b" }))).toBeNull();
    expect(formatActionFor(key({ metaKey: true, shiftKey: true, key: "b" }))).toBeNull();
    expect(formatActionFor(key({ metaKey: true, altKey: true, key: "b" }))).toBeNull();
    expect(formatActionFor(key({ metaKey: true, key: "Enter" }))).toBeNull();
    expect(formatActionFor(key({ metaKey: true, key: "s" }))).toBeNull();
    expect(formatActionFor(key({ metaKey: true, shiftKey: true, key: "P" }))).toBeNull();
    expect(formatActionFor(key({ metaKey: true, key: "f" }))).toBeNull();
    expect(formatActionFor(key({ metaKey: true, shiftKey: true, key: "F" }))).toBeNull();
  });
});

describe("applyFormat", () => {
  it("routes each action to its edit", () => {
    expect(applyFormat("a", { start: 0, end: 1 }, "italic").text).toBe("_a_");
    expect(applyFormat("a", { start: 0, end: 1 }, "quote").text).toBe("> a");
    expect(applyFormat("a", { start: 0, end: 1 }, "link").text).toBe("[a](url)");
  });
});
