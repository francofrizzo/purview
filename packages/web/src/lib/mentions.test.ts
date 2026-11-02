import { describe, expect, it } from "vitest";
import { findMentions, insertMention, mentionAt, mentionRefs, rankMentions, type MentionOption } from "./mentions";

describe("mentionAt", () => {
  it("finds the @word under the caret", () => {
    expect(mentionAt("look at @wid", 12)).toEqual({ start: 8, query: "wid" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("a\n@x", 4)).toEqual({ start: 2, query: "x" });
  });
  it("reads past a space, since titles have them", () => {
    expect(mentionAt("@charge ke", 10)).toEqual({ start: 0, query: "charge ke" });
  });
  it("ignores an @ inside a word, one followed by a space, and a line already ended", () => {
    expect(mentionAt("me@example.com", 14)).toBeNull();
    expect(mentionAt("@ x", 3)).toBeNull();
    expect(mentionAt("@foo\nbar", 8)).toBeNull();
  });
});

const opts: MentionOption[] = [
  { ref: { kind: "unit", id: "u1" }, kind: "unit", label: "Widget logic", number: 1, token: "@unit 1", tip: "" },
  { ref: { kind: "unit", id: "u2" }, kind: "unit", label: "Cache layer", number: 2, token: "@unit 2", tip: "" },
  { ref: { kind: "concept", id: "Snapshot" }, kind: "concept", label: "Snapshot", also: ["SNAP_SRC"], token: "@Snapshot", tip: "" },
  { ref: { kind: "file", path: "src/widget/cache.ts" }, kind: "file", label: "cache.ts", hint: "src/widget", token: "@cache.ts", tip: "" },
];

describe("rankMentions", () => {
  it("puts a label prefix before a word prefix before a substring", () => {
    expect(rankMentions(opts, "cache").map((o) => o.label)).toEqual(["Cache layer", "cache.ts"]);
    expect(rankMentions(opts, "logic").map((o) => o.label)).toEqual(["Widget logic"]);
    expect(rankMentions(opts, "widget").map((o) => o.label)).toEqual(["Widget logic", "cache.ts"]);
  });
  it("matches a unit's number and a concept's code names", () => {
    expect(rankMentions(opts, "2")[0].label).toBe("Cache layer");
    expect(rankMentions(opts, "snap_").map((o) => o.label)).toEqual(["Snapshot"]);
  });
  it("keeps the list's order for an empty query, up to the limit", () => {
    expect(rankMentions(opts, "", 2).map((o) => o.label)).toEqual(["Widget logic", "Cache layer"]);
  });
});

describe("insertMention", () => {
  it("writes the token and a space in place of the @query", () => {
    expect(insertMention("see @cac now", { start: 4, query: "cac" }, "@cache.ts")).toEqual({ text: "see @cache.ts now", caret: 14 });
    expect(insertMention("@x", { start: 0, query: "x" }, "@unit 2")).toEqual({ text: "@unit 2 ", caret: 8 });
  });
});

describe("findMentions / mentionRefs", () => {
  it("finds each token where it starts and ends a word", () => {
    const text = "why does @unit 2 call @cache.ts, and is @snapshot stale?";
    expect(findMentions(text, opts).map((m) => text.slice(m.start, m.end))).toEqual(["@unit 2", "@cache.ts", "@snapshot"]);
  });
  it("does not read @unit 2 into @unit 20, or a token inside a word", () => {
    expect(findMentions("@unit 20 and a@unit 1", opts)).toEqual([]);
  });
  it("names each ref once, in the order written", () => {
    expect(mentionRefs("@cache.ts then @unit 1 then @cache.ts", opts)).toEqual([
      { kind: "file", path: "src/widget/cache.ts" },
      { kind: "unit", id: "u1" },
    ]);
  });
});
