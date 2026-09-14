import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn(async (id: string, code: string) => ({ svg: `<svg data-id="${id}">${code}</svg>` }));
const initialize = vi.fn();

vi.mock("mermaid", () => ({
  default: { initialize, render },
}));

const OPTS = { dark: true, fontFamily: "IBM Plex Sans" };

describe("renderMermaid", () => {
  beforeEach(async () => {
    const { resetMermaidForTests } = await import("./mermaid");
    resetMermaidForTests();
    render.mockClear();
    initialize.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("never touches the mermaid module while the fence is still open", async () => {
    const { renderMermaid } = await import("./mermaid");
    const result = await renderMermaid("graph TD\n  A -->", true, OPTS);
    expect(result).toEqual({ status: "pending" });
    expect(render).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("renders a closed fence to svg", async () => {
    const { renderMermaid } = await import("./mermaid");
    const result = await renderMermaid("graph TD\n  A --> B", false, OPTS);
    expect(result.status).toBe("ok");
    expect(result).toMatchObject({ svg: expect.stringContaining("A --> B") });
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", theme: "dark" }),
    );
  });

  it("caches identical source: a second call does not re-render", async () => {
    const { renderMermaid } = await import("./mermaid");
    await renderMermaid("graph TD\n  A --> B", false, OPTS);
    await renderMermaid("graph TD\n  A --> B", false, OPTS);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("resolves to error (not a throw) when mermaid.render rejects", async () => {
    render.mockRejectedValueOnce(new Error("parse error"));
    const { renderMermaid } = await import("./mermaid");
    const result = await renderMermaid("not a diagram", false, OPTS);
    expect(result).toEqual({ status: "error" });
  });

  it("resolves to error when the mermaid module itself fails to load", async () => {
    vi.doMock("mermaid", () => {
      throw new Error("network error");
    });
    vi.resetModules();
    const { renderMermaid, resetMermaidForTests } = await import("./mermaid");
    resetMermaidForTests();
    const result = await renderMermaid("graph TD\n  A --> B", false, OPTS);
    expect(result).toEqual({ status: "error" });
    vi.doUnmock("mermaid");
    vi.resetModules();
  });
});
