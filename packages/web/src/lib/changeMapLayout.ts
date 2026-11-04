/**
 * Where the change map draws each function: callers left of what they call,
 * one column per call depth, each group of connected functions in its own
 * band, the biggest first. Functions with no call to or from another changed
 * function are not drawn as boxes at all; they are listed by file instead.
 */

export interface LayoutInput {
  nodes: { id: string }[];
  edges: { from: string; to: string }[];
}

export interface LayoutBox {
  x: number;
  y: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** an edge that closes a cycle (or stays in its column): drawn as a loop below */
  back: boolean;
}

export interface Layout {
  boxes: Map<string, LayoutBox>;
  edges: LayoutEdge[];
  /** ids with no edge, in input order */
  isolated: string[];
  width: number;
  height: number;
}

export interface LayoutSize {
  /** box width and height */
  w: number;
  h: number;
  colGap: number;
  rowGap: number;
  /** vertical space between two groups */
  groupGap: number;
}

export const DEFAULT_SIZE: LayoutSize = { w: 184, h: 44, colGap: 44, rowGap: 10, groupGap: 22 };

export function layoutChangeMap(input: LayoutInput, size: LayoutSize = DEFAULT_SIZE): Layout {
  const order = new Map(input.nodes.map((n, i) => [n.id, i]));
  const edges = input.edges.filter((e) => order.has(e.from) && order.has(e.to) && e.from !== e.to);
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const isolated = input.nodes.map((n) => n.id).filter((id) => !linked.has(id));

  // Groups: connected through calls in either direction.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const id of linked) parent.set(id, id);
  for (const e of edges) parent.set(find(e.from), find(e.to));
  const groups = new Map<string, string[]>();
  for (const id of input.nodes.map((n) => n.id).filter((id) => linked.has(id))) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length || order.get(a[0])! - order.get(b[0])!);

  const boxes = new Map<string, LayoutBox>();
  const outEdges: LayoutEdge[] = [];
  let top = 0;
  let width = 0;
  for (const members of ordered) {
    const inGroup = new Set(members);
    const groupEdges = edges.filter((e) => inGroup.has(e.from));
    // Cycles: an edge back to a function still on the DFS stack is drawn as a loop.
    const back = new Set<LayoutEdge>();
    const state = new Map<string, 1 | 2>();
    const outs = (id: string) => groupEdges.filter((e) => e.from === id);
    const visit = (id: string) => {
      state.set(id, 1);
      for (const e of outs(id)) {
        const s = state.get(e.to);
        if (s === 1) back.add(e as LayoutEdge);
        else if (s === undefined) visit(e.to);
      }
      state.set(id, 2);
    };
    for (const id of members) if (!state.has(id)) visit(id);
    const forward = groupEdges.filter((e) => !back.has(e as LayoutEdge));

    // Column: the longest chain of calls leading to it.
    const layer = new Map<string, number>(members.map((id) => [id, 0]));
    for (let pass = 0; pass < members.length; pass++) {
      let moved = false;
      for (const e of forward) {
        const next = layer.get(e.from)! + 1;
        if (next > layer.get(e.to)!) {
          layer.set(e.to, next);
          moved = true;
        }
      }
      if (!moved) break;
    }
    const depth = Math.max(...layer.values()) + 1;
    const columns: string[][] = Array.from({ length: depth }, () => []);
    for (const id of members) columns[layer.get(id)!].push(id);

    // Fewer crossings: a few sweeps sorting each column by its neighbours' rows.
    const rowOf = () => {
      const m = new Map<string, number>();
      for (const col of columns) col.forEach((id, i) => m.set(id, i));
      return m;
    };
    for (let sweep = 0; sweep < 4; sweep++) {
      const rows = rowOf();
      const down = sweep % 2 === 0;
      const range = down ? columns.map((_, i) => i).slice(1) : columns.map((_, i) => i).reverse().slice(1);
      for (const c of range) {
        const key = new Map<string, number>();
        for (const id of columns[c]) {
          const near = forward.filter((e) => (down ? e.to === id : e.from === id)).map((e) => rows.get(down ? e.from : e.to)!);
          key.set(id, near.length ? near.reduce((a, b) => a + b, 0) / near.length : rows.get(id)!);
        }
        columns[c].sort((a, b) => key.get(a)! - key.get(b)! || order.get(a)! - order.get(b)!);
      }
    }

    const tallest = Math.max(...columns.map((c) => c.length));
    const step = size.h + size.rowGap;
    columns.forEach((col, c) => {
      const offset = ((tallest - col.length) * step) / 2;
      col.forEach((id, i) => boxes.set(id, { x: c * (size.w + size.colGap), y: top + offset + i * step }));
    });
    for (const e of groupEdges) outEdges.push({ from: e.from, to: e.to, back: back.has(e as LayoutEdge) || layer.get(e.to)! <= layer.get(e.from)! });
    const hasLoop = groupEdges.some((e) => back.has(e as LayoutEdge) || layer.get(e.to)! <= layer.get(e.from)!);
    top += tallest * step - size.rowGap + (hasLoop ? 28 : 0) + size.groupGap;
    width = Math.max(width, depth * (size.w + size.colGap) - size.colGap);
  }
  return { boxes, edges: outEdges, isolated, width, height: Math.max(0, top - size.groupGap) };
}

/**
 * The file a box names: its basename, or the last two segments when another
 * changed file shares that basename.
 */
export function shortPaths(paths: string[]): Map<string, string> {
  const base = (p: string) => p.split("/").pop() ?? p;
  const count = new Map<string, number>();
  for (const p of new Set(paths)) count.set(base(p), (count.get(base(p)) ?? 0) + 1);
  return new Map(
    paths.map((p) => [p, (count.get(base(p)) ?? 0) > 1 ? p.split("/").slice(-2).join("/") : base(p)]),
  );
}
