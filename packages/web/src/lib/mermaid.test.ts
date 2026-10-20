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

  it("never renders source that does not parse, and clears what a failed render left in <body>", async () => {
    const leftovers: { id: string; parentElement: unknown; remove: () => void }[] = [];
    const body = {};
    const removed: string[] = [];
    vi.stubGlobal("document", {
      body,
      getElementById: (id: string) => {
        const el = { id, parentElement: body, remove: () => removed.push(id) };
        leftovers.push(el);
        return el;
      },
    });
    try {
      const parse = vi.fn(async () => false);
      const { renderMermaid } = await import("./mermaid");
      const mod = (await import("mermaid")) as unknown as { default: Record<string, unknown> };
      mod.default.parse = parse;
      expect(await renderMermaid("flowchart LR\n  A[x] -->", false, OPTS)).toEqual({ status: "error" });
      expect(render).not.toHaveBeenCalled();

      parse.mockResolvedValueOnce(true as never);
      render.mockRejectedValueOnce(new Error("render error"));
      expect(await renderMermaid("flowchart LR\n  A --> B", false, OPTS)).toEqual({ status: "error" });
      expect(removed.some((id) => id.startsWith("dmmd-"))).toBe(true);
      delete mod.default.parse;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves to error (not a throw) when mermaid.render rejects", async () => {
    render.mockRejectedValueOnce(new Error("parse error"));
    const { renderMermaid } = await import("./mermaid");
    const result = await renderMermaid("not a diagram", false, OPTS);
    expect(result).toEqual({ status: "error" });
  });

  it("does not cache a render failure: the next call renders again", async () => {
    render.mockRejectedValueOnce(new Error("parse error"));
    const { renderMermaid } = await import("./mermaid");
    expect(await renderMermaid("graph TD\n  A --> B", false, OPTS)).toEqual({ status: "error" });
    expect((await renderMermaid("graph TD\n  A --> B", false, OPTS)).status).toBe("ok");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("resolves to unavailable when the mermaid module fails to load, and imports again next time", async () => {
    let loads = 0;
    vi.doMock("mermaid", () => {
      loads += 1;
      if (loads === 1) throw new Error("404 while rebuilding");
      return { default: { initialize, render } };
    });
    vi.resetModules();
    const { renderMermaid, resetMermaidForTests } = await import("./mermaid");
    resetMermaidForTests();
    expect(await renderMermaid("graph TD\n  A --> B", false, OPTS)).toEqual({ status: "unavailable" });
    expect((await renderMermaid("graph TD\n  A --> B", false, OPTS)).status).toBe("ok");
    expect(loads).toBe(2);
    vi.doUnmock("mermaid");
    vi.resetModules();
  });
});
