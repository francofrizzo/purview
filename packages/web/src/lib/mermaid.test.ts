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
      expect.objectContaining({ securityLevel: "strict", suppressErrorRendering: true, theme: "dark" }),
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

  it("removes the temporary element mermaid leaves on <body> when a render fails", async () => {
    const leftover = { remove: vi.fn() };
    const getElementById = vi.fn((id: string) => (id.startsWith("dmmd-") ? leftover : null));
    vi.stubGlobal("document", { getElementById });
    render.mockRejectedValueOnce(new Error("parse error"));
    const { renderMermaid } = await import("./mermaid");
    expect(await renderMermaid("graph TD\n  A -->> ", false, OPTS)).toEqual({ status: "error" });
    expect(getElementById).toHaveBeenCalledWith(`d${render.mock.calls[0][0]}`);
    expect(leftover.remove).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
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
