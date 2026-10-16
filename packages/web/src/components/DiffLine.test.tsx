import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderContent } from "./DiffLine";

describe("renderContent", () => {
  it("renders a comment token with the tok-comment class and its color in --tok", () => {
    const html = renderToStaticMarkup(
      <>{renderContent("// c x", [{ content: "// c ", color: "#6a737d", comment: true }, { content: "x", color: "#ff0000" }])}</>,
    );
    expect(html).toContain('class="tok-comment"');
    // Only the variable inline: an inline color would outrank the CSS lift.
    expect(html).toContain('style="--tok:#6a737d"');
    expect(html).not.toContain("color:var(--tok)");
    // Other tokens keep a plain inline color.
    expect(html).toContain('style="color:#ff0000"');
  });

  it("keeps the overlay class next to the comment class", () => {
    const html = renderToStaticMarkup(
      <>{renderContent("abc", [{ content: "abc", color: "#6a737d", comment: true }], [{ start: 0, end: 3 }])}</>,
    );
    expect(html).toContain('class="tok-comment intra"');
  });
});
