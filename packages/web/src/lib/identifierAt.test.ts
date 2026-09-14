import { describe, expect, it } from "vitest";
import { wordAt, wordSpanAt } from "./identifierAt";

describe("wordAt", () => {
  it("expands a caret in the middle of a word to the whole word", () => {
    expect(wordAt("fetchWidgets(id)", 3)).toBe("fetchWidgets");
  });

  it("expands a caret right before a word", () => {
    expect(wordAt("foo.bar", 4)).toBe("bar");
  });

  it("expands a caret right after a word", () => {
    expect(wordAt("foo.bar", 3)).toBe("foo");
  });

  it("expands a caret at the very start of the text", () => {
    expect(wordAt("foo bar", 0)).toBe("foo");
  });

  it("expands a caret at the very end of the text", () => {
    expect(wordAt("foo", 3)).toBe("foo");
  });

  it("includes digits, underscore and $ as word characters", () => {
    expect(wordAt("$scope_2 + 1", 4)).toBe("$scope_2");
  });

  it("returns null between two non-word characters", () => {
    expect(wordAt("a.  .b", 3)).toBeNull();
  });

  it("returns null on an all-whitespace string", () => {
    expect(wordAt("   ", 1)).toBeNull();
  });

  it("returns null for an out-of-range offset", () => {
    expect(wordAt("foo", -1)).toBeNull();
    expect(wordAt("foo", 4)).toBeNull();
  });

  it("resolves each caret position across a multi-word line consistently", () => {
    const line = "const rate = getRate(id);";
    // Every caret from 0..length resolves to either null or a real substring
    // of the line — this is the sanity net for the boundary walk itself.
    for (let i = 0; i <= line.length; i++) {
      const word = wordAt(line, i);
      if (word !== null) expect(line.includes(word)).toBe(true);
    }
    expect(wordAt(line, line.indexOf("getRate"))).toBe("getRate");
    expect(wordAt(line, line.indexOf("getRate") + 3)).toBe("getRate");
  });
});

describe("wordSpanAt", () => {
  it("returns the [start, end) offsets wordAt slices from", () => {
    expect(wordSpanAt("foo.bar", 5)).toEqual({ start: 4, end: 7 });
    expect(wordSpanAt("fetchWidgets(id)", 0)).toEqual({ start: 0, end: 12 });
  });

  it("agrees with wordAt everywhere", () => {
    const line = "const rate = getRate(id);";
    for (let i = 0; i <= line.length; i++) {
      const span = wordSpanAt(line, i);
      expect(span ? line.slice(span.start, span.end) : null).toBe(wordAt(line, i));
    }
  });
});
