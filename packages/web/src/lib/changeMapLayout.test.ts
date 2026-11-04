import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE, layoutChangeMap, shortPaths } from "./changeMapLayout";

const nodes = (...ids: string[]) => ids.map((id) => ({ id }));
const col = (x: number) => x / (DEFAULT_SIZE.w + DEFAULT_SIZE.colGap);

describe("layoutChangeMap", () => {
  it("puts callers left of what they call and lists the unlinked apart", () => {
    const l = layoutChangeMap({
      nodes: nodes("a", "b", "c", "d", "lonely"),
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "a", to: "c" },
        { from: "d", to: "c" },
      ],
    });
    expect(l.isolated).toEqual(["lonely"]);
    expect(col(l.boxes.get("a")!.x)).toBe(0);
    expect(col(l.boxes.get("b")!.x)).toBe(1);
    expect(col(l.boxes.get("c")!.x)).toBe(2);
    expect(col(l.boxes.get("d")!.x)).toBe(0);
    expect(l.boxes.has("lonely")).toBe(false);
    expect(l.edges.every((e) => !e.back)).toBe(true);
    expect(l.width).toBe(3 * DEFAULT_SIZE.w + 2 * DEFAULT_SIZE.colGap);
  });

  it("stacks separate groups, the biggest first, and loops a cycle", () => {
    const l = layoutChangeMap({
      nodes: nodes("x", "y", "p", "q", "r"),
      edges: [
        { from: "x", to: "y" },
        { from: "p", to: "q" },
        { from: "q", to: "r" },
        { from: "r", to: "p" },
      ],
    });
    expect(l.boxes.get("p")!.y).toBeLessThan(l.boxes.get("x")!.y);
    expect(l.edges.filter((e) => e.back)).toEqual([{ from: "r", to: "p", back: true }]);
  });

  it("ignores self-calls and edges to unknown ids", () => {
    const l = layoutChangeMap({ nodes: nodes("a"), edges: [{ from: "a", to: "a" }, { from: "a", to: "zz" }] });
    expect(l.isolated).toEqual(["a"]);
    expect(l.height).toBe(0);
  });
});

describe("shortPaths", () => {
  it("uses the basename unless two files share it", () => {
    const m = shortPaths(["src/a/index.ts", "src/b/index.ts", "src/c/charge.ts"]);
    expect(m.get("src/a/index.ts")).toBe("a/index.ts");
    expect(m.get("src/c/charge.ts")).toBe("charge.ts");
  });
});
