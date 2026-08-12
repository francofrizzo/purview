import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("joins wrapped lines into one paragraph and splits on blank lines", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", text: "one two" },
      { type: "paragraph", text: "three" },
    ]);
  });

  it("parses a fenced block with its language", () => {
    expect(parseMarkdown("```go\nfmt.Println()\n```")).toEqual([
      { type: "code", lang: "go", code: "fmt.Println()", open: false },
    ]);
  });

  it("treats an unterminated fence as code still arriving", () => {
    const [block] = parseMarkdown("```ts\nconst a =");
    expect(block).toEqual({ type: "code", lang: "ts", code: "const a =", open: true });
  });

  it("never lets markdown syntax inside a fence become blocks", () => {
    const blocks = parseMarkdown("```\n# not a heading\n- not a list\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "code", code: "# not a heading\n- not a list" });
  });

  it("parses headings, bullet lists and ordered lists", () => {
    expect(parseMarkdown("## Title")).toEqual([{ type: "heading", level: 2, text: "Title" }]);
    expect(parseMarkdown("- a\n- b")).toEqual([{ type: "list", ordered: false, items: ["a", "b"] }]);
    expect(parseMarkdown("1. a\n2. b")).toEqual([{ type: "list", ordered: true, items: ["a", "b"] }]);
  });

  it("folds an indented continuation into the previous list item", () => {
    expect(parseMarkdown("- first\n  continued\n- second")).toEqual([
      { type: "list", ordered: false, items: ["first continued", "second"] },
    ]);
  });

  it("parses blockquotes and thematic breaks", () => {
    expect(parseMarkdown("> quoted")).toEqual([{ type: "quote", text: "quoted" }]);
    expect(parseMarkdown("---")).toEqual([{ type: "hr" }]);
  });
});

describe("parseInline", () => {
  it("keeps code spans literal, including markup inside them", () => {
    expect(parseInline("call `a *b* c` now")).toEqual([
      { type: "text", text: "call " },
      { type: "code", text: "a *b* c" },
      { type: "text", text: " now" },
    ]);
  });

  it("parses bold, italics and links", () => {
    expect(parseInline("**bold**")).toEqual([{ type: "strong", text: "bold" }]);
    expect(parseInline("_soft_")).toEqual([{ type: "em", text: "soft" }]);
    expect(parseInline("[docs](https://x.dev/a)")).toEqual([
      { type: "link", text: "docs", href: "https://x.dev/a" },
    ]);
  });

  it("autolinks a bare url", () => {
    expect(parseInline("see https://x.dev now")[1]).toEqual({
      type: "link",
      text: "https://x.dev",
      href: "https://x.dev",
    });
  });

  it("leaves an unmatched marker as plain text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", text: "2 * 3 = 6" }]);
  });
});
