import { describe, expect, it } from "vitest";
import { attentionColor } from "./Chips";

describe("attentionColor", () => {
  it("matches AttentionChip's own color per level", () => {
    expect(attentionColor("must-read")).toBe("var(--risk)");
    expect(attentionColor("skim")).toBe("var(--warn)");
    expect(attentionColor("skip")).toBe("var(--kind-wiring)");
  });

  it("falls back to skim's color for an unrecognized level", () => {
    // @ts-expect-error deliberately outside the Attention union
    expect(attentionColor("bogus")).toBe(attentionColor("skim"));
  });
});
