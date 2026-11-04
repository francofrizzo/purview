import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  callForms,
  callsIn,
  definitionOnLine,
  importsName,
  extractFunctions,
  languageOf,
  lineCalls,
  moduleName,
  stripCode,
  touchedLines,
  ungreppable,
} from "../src/change-graph/functions.js";
import { buildChangeGraph, type GraphFile } from "../src/change-graph/graph.js";
import { blastRadius, changeMap, githubBlobUrl } from "../src/change-graph/index.js";
import { prCheckoutPath, setGhRunner } from "@reviewer/core";
import { git } from "./git-fixtures.js";
import { buildFixture, key } from "./fixtures.js";
import { createApp } from "../src/app.js";
import { readConfig, writeConfig } from "../src/config.js";

const lines = (s: string) => s.replace(/^\n/, "").split("\n");
const spans = (src: string, lang: "go" | "ts" | "py") =>
  extractFunctions(lines(src), lang).map((f) => `${f.qualifier ? `${f.qualifier}.` : ""}${f.name} ${f.start}-${f.end}`);

describe("languageOf", () => {
  it("knows Go, TS/JS and Python by extension", () => {
    expect(languageOf("a/b.go")).toBe("go");
    expect(languageOf("x.tsx")).toBe("ts");
    expect(languageOf("x.mjs")).toBe("ts");
    expect(languageOf("x.py")).toBe("py");
    expect(languageOf("x.rb")).toBeNull();
    expect(languageOf("Makefile")).toBeNull();
  });
});

describe("stripCode", () => {
  it("blanks comments and string contents, keeping each line's length", () => {
    const src = ['const a = "x { y";  // }', "/* {", " } */ f(`${a}`)"];
    const out = stripCode(src, "ts");
    expect(out.map((l) => l.length)).toEqual(src.map((l) => l.length));
    expect(out.join("\n")).not.toMatch(/[{}]/);
    expect(out[2]).toContain("f(");
  });
  it("handles Python triple quotes and # comments", () => {
    const out = stripCode(['x = """a', "def f(): {", '"""  # def g():', "y = 1"], "py");
    expect(out.join("\n")).not.toContain("def");
    expect(out[3]).toBe("y = 1");
  });
  it("treats Go raw strings as strings across lines", () => {
    const out = stripCode(["q := `select {", "}`", "f()"], "go");
    expect(out.join("")).not.toMatch(/[{}]/);
  });
});

describe("extractFunctions: TypeScript", () => {
  it("finds declarations, arrow consts, class methods and field arrows", () => {
    const src = `
import { x } from "y";

export async function charge(order: Order, opts: { id?: string } = {}): Promise<Result> {
  const key = idempotencyKey(order.id);
  if (key) {
    return retry(() => send(key));
  }
}

export const idempotencyKey = (id: string): string =>
  hash(id).slice(0, 32);

const handler = async (
  req: Req,
) => {
  return charge(req.order);
};

export class ChargeService {
  private readonly n = 3;
  constructor(private readonly pool: Pool) {}

  async retry<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  onDone = (x: number) => {
    this.retry(() => x);
  };

  abstract nothing(): void;
}

const notAFunction = (a + b) * 2;
`;
    expect(spans(src, "ts")).toEqual([
      "charge 3-8",
      "idempotencyKey 10-11",
      "handler 13-17",
      "ChargeService.constructor 21-21",
      "ChargeService.retry 23-25",
      "ChargeService.onDone 27-29",
    ]);
  });

  it("skips object return types and generic bounds when finding the body", () => {
    const src = `
function shape<T extends { a: number }>(x: T): { a: number } {
  return { a: x.a };
}
function after() {
  return 1;
}`;
    expect(spans(src, "ts")).toEqual(["shape 1-3", "after 4-6"]);
  });

  it("leaves closures to their function and reads object-literal methods", () => {
    const src = `
export function Overview() {
  const onScroll = () => {
    jump();
  };
  function inner() {}
  return null;
}
export const api = {
  async fileLines(key: string) {
    return request(key);
  },
};`;
    expect(spans(src, "ts")).toEqual(["Overview 1-7", "fileLines 9-11"]);
  });

  it("ignores overloads and interface methods without a body", () => {
    const src = `
export function f(a: string): void;
export function f(a: unknown): void {
  g(a);
}`;
    expect(spans(src, "ts")).toEqual(["f 2-4"]);
  });
});

describe("extractFunctions: Go", () => {
  it("finds functions and methods with their receiver type", () => {
    const src = `
package billing

func New(cfg Config) *Service {
	return &Service{cfg: cfg}
}

func (s *Service) Charge(ctx context.Context, o Order) (map[string]interface{}, error) {
	key := IdempotencyKey(o)
	if s.cfg.Retry {
		return s.retry(ctx, func() error { return nil })
	}
	return nil, nil
}

func Map[T any](xs []T, f func(T) T) []T {
	return xs
}

func Decode(v interface{ Unmarshal() }) {
	v.Unmarshal()
}`;
    expect(spans(src, "go")).toEqual(["New 3-5", "Service.Charge 7-13", "Map 15-17", "Decode 19-21"]);
  });
});

describe("extractFunctions: Python", () => {
  it("finds top-level defs and methods by indentation, skipping nested defs", () => {
    const src = `
import os

def charge(order,
           retries=3):
    """Charge it.

def not_this(): pass
"""
    def helper():
        return 1
    return helper()


class Ledger:
    def record(self, key):
        self.rows.append(key)

    async def find(self, key): return None

def last(): return 2
`;
    expect(spans(src, "py")).toEqual(["charge 3-11", "Ledger.record 15-16", "Ledger.find 18-18", "last 20-20"]);
  });
});

describe("definitionOnLine", () => {
  it("names what a lone removed line defines", () => {
    expect(definitionOnLine("export function formatReport(report: Report): string[] {", "ts")).toBe("formatReport");
    expect(definitionOnLine("export const sum = (a: number) => a + 1;", "ts")).toBe("sum");
    expect(definitionOnLine("  async findByKey(key: string) {", "ts")).toBe("findByKey");
    expect(definitionOnLine("  if (ready) {", "ts")).toBeNull();
    expect(definitionOnLine('describe("x", () => {', "ts")).toBeNull();
    expect(definitionOnLine("const total = (a + b) * 2;", "ts")).toBeNull();
    expect(definitionOnLine("func (s *Service) Charge(o Order) error {", "go")).toBe("Charge");
    expect(definitionOnLine("    def record(self, key):", "py")).toBe("record");
  });
});

describe("calls", () => {
  it("counts names followed by a paren, generics included, strings and comments not", () => {
    const s = stripCode(["a(); this.b(1); c<T>(x); // d()", 'e("f()"); g [0]; Map[int](xs)'], "ts");
    const calls = callsIn(s, 1, 2);
    expect([...calls.keys()].sort()).toEqual(["Map", "a", "b", "c", "e"]);
    expect(lineCalls("  return chargeService.charge(order);", "charge", "ts")).toBe(true);
    expect(lineCalls("  // charge(order) used to be here", "charge", "ts")).toBe(false);
    expect(lineCalls("import { charge } from './x';", "charge", "ts")).toBe(false);
  });
});

describe("callForms and importsName", () => {
  it("says what a call is made on", () => {
    expect(callForms("x := pricing.ApplyDiscount(t)", "ApplyDiscount", "go")).toEqual([{ receiver: "pricing" }]);
    expect(callForms("ApplyDiscount(t); a().ApplyDiscount()", "ApplyDiscount", "go")).toEqual([{ receiver: null }, { receiver: "" }]);
    expect(callForms("return <SectionHead title='x' />", "SectionHead", "ts", { jsx: true })).toEqual([{ receiver: null }]);
    expect(callForms("return <SectionHead title='x' />", "SectionHead", "ts")).toEqual([]);
  });
  it("recognises the lines of an import", () => {
    expect(importsName("import { applyDiscount } from './price';", "applyDiscount")).toBe(true);
    expect(importsName("from billing.price import apply_discount", "apply_discount")).toBe(true);
    expect(importsName("  applyDiscount,", "applyDiscount")).toBe(true);
    expect(importsName("  type applyDiscount as d,", "applyDiscount")).toBe(true);
    expect(importsName("  return applyDiscount(x);", "applyDiscount")).toBe(false);
    expect(importsName('import { describe } from "vitest";', "describe", "reconcileNightly")).toBe(false);
    expect(importsName("import { applyDiscount } from '../billing/price';", "applyDiscount", "price")).toBe(true);
    expect(importsName("from billing.price import apply_discount", "apply_discount", "price")).toBe(true);
    expect(moduleName("src/billing/index.ts")).toBe("billing");
    expect(moduleName("src/billing/price.ts")).toBe("price");
  });
  it("finds JSX components as calls in .tsx bodies", () => {
    const { graph } = buildChangeGraph(
      [
        {
          path: "src/A.tsx",
          status: "added",
          head: ["export function A() {", "  return <B", "    x={1} />;", "}", "function B() {", "  return null;", "}"],
          hunks: [hunk("x", 0, 1, ["+export function A() {", "+  return <B", "+    x={1} />;", "+}", "+function B() {", "+  return null;", "+}"])],
        },
      ],
      [],
    );
    expect(graph.edges.map((e) => `${e.from.split("#")[1]}>${e.to.split("#")[1]}`)).toEqual(["A@1>B@5"]);
  });
});

describe("touchedLines", () => {
  it("places added lines and deletions at the head", () => {
    const t = touchedLines({ oldStart: 10, newStart: 10, newLines: 4, text: " a\n-b\n+c\n+d\n e\n" });
    expect(t.added).toEqual([11, 12]);
    expect(t.deletedBefore).toEqual([11]);
    expect(t.removed).toEqual([{ line: 11, text: "b" }]);
  });
});

describe("ungreppable", () => {
  it("skips short and common names", () => {
    expect(ungreppable("get")).toBe("too short");
    expect(ungreppable("String")).toBe("too common");
    expect(ungreppable("__init__")).toBe("too common");
    expect(ungreppable("idempotencyKey")).toBeNull();
  });
});

/* ---------------------------------------------------------------- graph */

function hunk(id: string, oldStart: number, newStart: number, body: string[]) {
  const newLines = body.filter((l) => !l.startsWith("-")).length;
  return { id, oldStart, newStart, newLines, text: body.join("\n") + "\n" };
}

describe("buildChangeGraph", () => {
  const charge = [
    "export class ChargeService {",
    "  async charge(order: Order) {",
    "    const key = idempotencyKey(order.id);",
    "    return this.retry(() => send(key));",
    "  }",
    "",
    "  private async retry(fn: () => Promise<R>) {",
    "    return fn();",
    "  }",
    "",
    "  untouched() {",
    "    return 1;",
    "  }",
    "}",
  ];
  const idem = ["export function idempotencyKey(id: string): string {", "  return id;", "}"];
  const files: GraphFile[] = [
    {
      path: "src/charge.ts",
      status: "modified",
      head: charge,
      hunks: [
        hunk("h1", 2, 2, [
          "   async charge(order: Order) {",
          "-    return send(order);",
          "+    const key = idempotencyKey(order.id);",
          "+    return this.retry(() => send(key));",
          "   }",
          " ",
          "+  private async retry(fn: () => Promise<R>) {",
          "+    return fn();",
          "+  }",
          "+",
        ]),
      ],
    },
    { path: "src/idempotency.ts", status: "added", head: idem, hunks: [hunk("h2", 0, 1, idem.map((l) => `+${l}`))] },
    {
      path: "src/report.ts",
      status: "modified",
      head: ["export const x = 1;"],
      hunks: [hunk("h3", 1, 1, ["-export function formatReport(r: Report) {", "-  return [];", "-}", " export const x = 1;"])],
    },
    { path: "src/format.ts", status: "added", head: ["export function formatReport(r: Report) {", "  return [];", "}"], hunks: [hunk("h4", 0, 1, ["+export function formatReport(r: Report) {", "+  return [];", "+}"])] },
    { path: "docs/x.md", status: "modified", head: ["hi"], hunks: [] },
  ];
  const units = [
    { id: "core", attention: "must-read" as const, hunkIds: ["h1", "h2"] },
    { id: "move", attention: "skim" as const, hunkIds: ["h3", "h4"] },
  ];

  it("marks changed and added functions, joins their calls and folds a move", () => {
    const { graph } = buildChangeGraph(files, units);
    const byName = Object.fromEntries(graph.nodes.map((n) => [n.name, n]));
    expect(Object.keys(byName).sort()).toEqual(["charge", "formatReport", "idempotencyKey", "retry"]);
    expect(byName.charge).toMatchObject({ status: "changed", qualifier: "ChargeService", unit: "core", line: 2, lines: 3 });
    expect(byName.retry.status).toBe("added");
    expect(byName.idempotencyKey).toMatchObject({ status: "added", unit: "core" });
    expect(byName.formatReport).toMatchObject({ status: "added", movedFrom: "src/report.ts", unit: "move" });
    const edges = graph.edges.map((e) => `${e.from.split("#")[1]} -> ${e.to.split("#")[1]}`).sort();
    expect(edges).toEqual(["ChargeService.charge@2 -> ChargeService.retry@7", "ChargeService.charge@2 -> idempotencyKey@1"]);
    expect(graph.unsupportedFiles).toBe(1);
    expect(graph.total).toBe(4);
  });

  it("reports a removed function that did not move", () => {
    const { graph } = buildChangeGraph(files.filter((f) => f.path !== "src/format.ts"), units);
    expect(graph.nodes.find((n) => n.name === "formatReport")).toMatchObject({ status: "removed", path: "src/report.ts", line: 1 });
  });

  it("caps the nodes, must-read units first", () => {
    const { graph } = buildChangeGraph(files, units, { maxNodes: 2 });
    expect(graph.nodes.every((n) => n.unit === "core")).toBe(true);
    expect(graph.total).toBe(4);
  });
});

/* --------------------------------------------------------- end to end */

describe("changeMap and blastRadius over a real clone", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-change-graph-"));
    const repo = prCheckoutPath(key, root);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    const write = (file: string, body: string[]) => fs.writeFileSync(path.join(repo, file), body.join("\n") + "\n");
    write("src/price.ts", ["export function applyDiscount(total: number) {", "  return total * 0.9;", "}"]);
    write("src/cart.ts", [
      "import { applyDiscount } from './price';",
      "export function checkout(total: number) {",
      "  // applyDiscount(total) in a comment",
      "  return applyDiscount(total);",
      "}",
    ]);
    write("README.md", ["applyDiscount(total) is documented here"]);
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "base"], repo);
    const baseSha = git(["rev-parse", "HEAD"], repo);
    write("src/price.ts", ["export function applyDiscount(total: number) {", "  return total * 0.8;", "}"]);
    git(["commit", "-q", "-am", "head"], repo);
    const headSha = git(["rev-parse", "HEAD"], repo);
    const patch = git(["diff", baseSha, headSha], repo) + "\n";
    buildFixture(root, patch, { baseSha, headSha, mergeBase: baseSha });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("draws the changed function and finds its caller outside the diff, with a GitHub link", async () => {
    const map = await changeMap(key, root);
    expect(map).toMatchObject({ available: true, nodes: [{ name: "applyDiscount", status: "changed", line: 1 }] });
    const blast = await blastRadius(key, root);
    expect(blast.available).toBe(true);
    if (!blast.available || !map.available) return;
    expect(blast.functions).toHaveLength(1);
    const [fn] = blast.functions;
    expect(fn.total).toBe(1);
    expect(fn.sites[0]).toMatchObject({ path: "src/cart.ts", line: 4, enclosing: "checkout", text: "return applyDiscount(total);" });
    expect(fn.sites[0].url).toBe(`https://github.com/acme/widgets/blob/${map.sha}/src/cart.ts#L4`);
    expect(githubBlobUrl(key, "abc", "a b/c.ts", 2)).toBe("https://github.com/acme/widgets/blob/abc/a%20b/c.ts#L2");
  });

  it("says so when no clone has the head commit", async () => {
    fs.rmSync(prCheckoutPath(key, root), { recursive: true, force: true });
    const blast = await blastRadius(key, root);
    expect(blast).toMatchObject({ available: false });
  });
});

describe("GET /api/prs/:key/change-map and /blast-radius", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-change-graph-route-"));
    buildFixture(root);
    // No checkout: the head files come from the contents API, faked here.
    setGhRunner((args) => {
      if (args.some((a) => a.includes("contents/src/foo.ts?ref="))) return "line1\nnew2\n";
      throw new Error("gh: Not Found (HTTP 404)");
    });
  });
  afterEach(() => {
    setGhRunner(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("404s while the experiment is off and answers once it is on", async () => {
    const app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });
    const k = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);
    expect((await app.request(`/api/prs/${k}/change-map`)).status).toBe(404);
    expect((await app.request(`/api/prs/${k}/blast-radius`)).status).toBe(404);
    writeConfig({ experiments: { ...readConfig(root).experiments, changeMap: true, blastRadius: true } }, root);
    const map = await app.request(`/api/prs/${k}/change-map`);
    expect(map.status).toBe(200);
    // The fixture's src/foo.ts has no functions to find.
    expect(await map.json()).toMatchObject({ available: true, nodes: [], edges: [] });
    const blast = await app.request(`/api/prs/${k}/blast-radius`);
    expect(await blast.json()).toMatchObject({ available: false });
  });
});
