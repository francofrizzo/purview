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
    expect(parseMarkdown("> quoted")).toEqual([
      { type: "quote", text: "quoted", blocks: [{ type: "paragraph", text: "quoted" }] },
    ]);
    expect(parseMarkdown("---")).toEqual([{ type: "hr" }]);
  });

  it("parses a quote's lines as markdown, so alerts can hold headings and details", () => {
    const [q] = parseMarkdown("> [!WARNING]\n> ## Limit reached\n> <details><summary>Why</summary>\n> body\n> </details>");
    expect(q.type).toBe("quote");
    if (q.type !== "quote") return;
    expect(q.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "details"]);
  });
});

describe("parseMarkdown tables", () => {
  it("parses a pipe table with per-column alignment", () => {
    const src = "| flow | before | after |\n| :-- | :-: | --: |\n| login | 3 | 1 |\n| logout | 2 | 2 |";
    expect(parseMarkdown(src)).toEqual([
      {
        type: "table",
        align: ["left", "center", "right"],
        header: ["flow", "before", "after"],
        rows: [
          ["login", "3", "1"],
          ["logout", "2", "2"],
        ],
      },
    ]);
  });

  it("accepts rows without outer pipes and squares ragged rows to the header", () => {
    const src = "a | b | c\n--- | --- | ---\n1 | 2\n1 | 2 | 3 | 4";
    expect(parseMarkdown(src)).toEqual([
      {
        type: "table",
        align: [null, null, null],
        header: ["a", "b", "c"],
        rows: [
          ["1", "2", ""],
          ["1", "2", "3"],
        ],
      },
    ]);
  });

  it("keeps an escaped pipe inside a cell", () => {
    const [block] = parseMarkdown("| expr | value |\n| --- | --- |\n| `a \\| b` | or |");
    expect(block).toMatchObject({ type: "table", rows: [["`a | b`", "or"]] });
  });

  it("is still a paragraph while the separator row has not arrived", () => {
    expect(parseMarkdown("| flow | before |")).toEqual([
      { type: "paragraph", text: "| flow | before |" },
    ]);
  });

  it("ends at a blank line and lets prose follow", () => {
    expect(parseMarkdown("| a |\n| - |\n| 1 |\n\nafter")).toEqual([
      { type: "table", align: [null], header: ["a"], rows: [["1"]] },
      { type: "paragraph", text: "after" },
    ]);
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

  it("keeps underscores inside words literal", () => {
    expect(
      parseInline("the ART get_balance tool now answers, honouring statement_required like prod"),
    ).toEqual([
      {
        type: "text",
        text: "the ART get_balance tool now answers, honouring statement_required like prod",
      },
    ]);
    expect(parseInline("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
    expect(parseInline("a __dunder__init b")).toEqual([
      { type: "text", text: "a __dunder__init b" },
    ]);
  });

  it("still reads underscore emphasis at word boundaries, next to intraword ones", () => {
    expect(parseInline("call get_balance, _then_ stop")).toEqual([
      { type: "text", text: "call get_balance, " },
      { type: "em", text: "then" },
      { type: "text", text: " stop" },
    ]);
    expect(parseInline("x*y*z")).toEqual([
      { type: "text", text: "x" },
      { type: "em", text: "y" },
      { type: "text", text: "z" },
    ]);
  });

  it("leaves an unmatched marker as plain text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", text: "2 * 3 = 6" }]);
  });
});

describe("parseMarkdown <details>", () => {
  it("reads GitHub's collapsible, summary and all", () => {
    const md = [
      "Intro.",
      "",
      "<details>",
      "<summary>🤖 Agente</summary>",
      "",
      "El namespace `test-` queda **fuera**.",
      "",
      "- uno",
      "</details>",
      "",
      "After.",
    ].join("\n");
    expect(parseMarkdown(md)).toEqual([
      { type: "paragraph", text: "Intro." },
      {
        type: "details",
        summary: "🤖 Agente",
        open: false,
        blocks: [
          { type: "paragraph", text: "El namespace `test-` queda **fuera**." },
          { type: "list", ordered: false, items: ["uno"] },
        ],
      },
      { type: "paragraph", text: "After." },
    ]);
  });

  it("handles one-line tags, `open`, nesting and a missing summary", () => {
    const [d] = parseMarkdown(
      "<details open> <summary>Outer</summary>\nA\n<details>\nB\n</details>\n</details> tail",
    ) as Extract<ReturnType<typeof parseMarkdown>[number], { type: "details" }>[];
    expect(d.open).toBe(true);
    expect(d.summary).toBe("Outer");
    expect(d.blocks[0]).toEqual({ type: "paragraph", text: "A" });
    expect(d.blocks[1]).toMatchObject({ type: "details", summary: "Details", blocks: [{ type: "paragraph", text: "B" }] });
    expect(parseMarkdown("<details open> <summary>Outer</summary>\nA\n</details> tail")[1]).toEqual({
      type: "paragraph",
      text: "tail",
    });
  });

  it("runs an unclosed one to the end", () => {
    expect(parseMarkdown("<details><summary>S</summary>\nbody")).toEqual([
      { type: "details", summary: "S", open: false, blocks: [{ type: "paragraph", text: "body" }] },
    ]);
  });

  it("stops a paragraph at a <details> line", () => {
    expect(parseMarkdown("text\n<details>\nx\n</details>").map((b) => b.type)).toEqual(["paragraph", "details"]);
  });
});

describe("parseInline GitHub extras", () => {
  it("drops layout-only HTML and themed banner twins", () => {
    expect(parseInline("<p>Review in <b>Linear</b></p>")).toEqual([
      { type: "text", text: "Review in " },
      { type: "strong", text: "Linear" },
    ]);
    expect(parseInline("![a](https://x/b.png#gh-light-mode-only)ok")).toEqual([{ type: "text", text: "ok" }]);
    expect(
      parseInline(
        '<a href="https://x/s#gh-light-mode-only"><img src="l.svg" alt="Stack"></a><a href="https://x/s#gh-dark-mode-only"><img src="d.svg" alt="Stack"></a>',
      ),
    ).toEqual([{ type: "link", text: "Stack", href: "https://x/s" }]);
    // generics are not tags
    expect(parseInline("List<Promise<void>>")).toEqual([{ type: "text", text: "List<Promise<void>>" }]);
  });

  it("renders strike, kbd, sub/sup, b/i, br, a and img", () => {
    expect(parseInline("~~old~~ press <kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup>")).toEqual([
      { type: "del", text: "old" },
      { type: "text", text: " press " },
      { type: "kbd", text: "Ctrl" },
      { type: "text", text: " H" },
      { type: "sub", text: "2" },
      { type: "text", text: "O x" },
      { type: "sup", text: "2" },
    ]);
    expect(parseInline("<b>bold</b><br/><i>it</i>")).toEqual([
      { type: "strong", text: "bold" },
      { type: "br" },
      { type: "em", text: "it" },
    ]);
    expect(parseInline('<a href="https://x.dev">site</a> <img src="https://i/p.png" alt="shot">')).toEqual([
      { type: "link", text: "site", href: "https://x.dev" },
      { type: "text", text: " " },
      { type: "image", alt: "shot", href: "https://i/p.png" },
    ]);
  });

  it("leaves unknown angle brackets and tags inside code alone", () => {
    expect(parseInline("returns Promise<void> or Map<K, V>")).toEqual([
      { type: "text", text: "returns Promise<void> or Map<K, V>" },
    ]);
    expect(parseInline("`<kbd>x</kbd>`")).toEqual([{ type: "code", text: "<kbd>x</kbd>" }]);
  });
});
