import { describe, expect, it } from "vitest";
import { commentColorFor, markComments, tokenizeLines } from "./highlight";

describe("markComments", () => {
  it("tags tokens painted in the comment color and leaves the rest alone", () => {
    const marked = markComments(
      [[{ content: "// c", color: "#6A737D" }, { content: "x", color: "#ff0000" }], [{ content: "plain" }]],
      "#6a737d",
    );
    expect(marked[0][0]).toEqual({ content: "// c", color: "#6A737D", comment: true });
    expect(marked[0][1]).toEqual({ content: "x", color: "#ff0000" });
    expect(marked[1][0]).toEqual({ content: "plain" });
  });

  it("is a no-op without a known comment color", () => {
    const toks = [[{ content: "// c", color: "#6a737d" }]];
    expect(markComments(toks, undefined)).toBe(toks);
  });
});

describe("tokenizeLines", () => {
  it("learns the theme's comment color and marks comment tokens, not keywords", async () => {
    const theme = { name: "github-dark" };
    const tokens = await tokenizeLines("t1", "// note\nreturn 1;", "ts", theme);
    expect(tokens).not.toBeNull();
    const comment = commentColorFor(theme);
    expect(comment).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokens![0].some((t) => t.content.includes("note") && t.comment)).toBe(true);
    expect(tokens![1].every((t) => !t.comment)).toBe(true);
  }, 30_000);
});
