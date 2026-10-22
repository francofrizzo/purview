import { describe, expect, it } from "vitest";
import { EMOJI_LIST, searchEmoji } from "./emoji";

describe("searchEmoji", () => {
  it("puts the exact name first, then names that start with the word, then keyword hits", () => {
    const names = searchEmoji("heart").map((e) => e.name);
    expect(names[0]).toBe("heart");
    expect(names.indexOf("heart_eyes")).toBeLessThan(names.indexOf("broken_heart"));
    expect(names).toContain("green_heart");
  });

  it("matches every word, so two words narrow rather than widen", () => {
    expect(searchEmoji("green heart").map((e) => e.char)).toEqual(["💚"]);
    expect(searchEmoji("rocket")[0].char).toBe("🚀");
    expect(searchEmoji("+1")[0].char).toBe("👍");
  });

  it("answers an empty query with the list as curated, and nothing for nonsense", () => {
    expect(searchEmoji("")[0].char).toBe(EMOJI_LIST[0].char);
    expect(searchEmoji("qzxv")).toEqual([]);
  });

  it("lists each character once", () => {
    expect(new Set(EMOJI_LIST.map((e) => e.char)).size).toBe(EMOJI_LIST.length);
  });
});
