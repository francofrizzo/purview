import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setAnalysis, setUnit, setUnits } from "../src/service.js";
import { appendEvent, loadState, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import { ReviewUnitPatchSchema, ReviewUnitSchema } from "../src/schemas.js";
import { UNIT_DIAGRAM_MERMAID_MAX, UnitDiagramSchema, unitDiagramProblems } from "../src/diagram.js";
import type { FileDiff, PrKey } from "../src/index.js";

/** Unit diagrams (the `unitDiagrams` experiment): an optional Mermaid diagram on a unit. */

const ts = "2026-01-01T00:00:00.000Z";

const sequence = [
  "sequenceDiagram",
  "  participant Client",
  "  participant API",
  "  participant Ledger",
  "  Client->>API: charge(key)",
  "  API->>Ledger: lookup(key)",
  "  Ledger-->>API: first result",
  "  API-->>Client: same result",
].join("\n");

describe("UnitDiagramSchema", () => {
  it("takes each kind with its header, the title optional", () => {
    expect(UnitDiagramSchema.safeParse({ kind: "sequence", title: "Retrying a charge", mermaid: sequence }).success).toBe(true);
    expect(UnitDiagramSchema.safeParse({ kind: "state", mermaid: "stateDiagram-v2\n  [*] --> Pending\n  Pending --> Settled" }).success).toBe(true);
    expect(UnitDiagramSchema.safeParse({ kind: "flow", mermaid: "%% a comment first\nflowchart LR\n  A --> B" }).success).toBe(true);
    expect(UnitDiagramSchema.safeParse({ kind: "er", mermaid: "erDiagram\n  ORDER ||--o{ CHARGE : has" }).success).toBe(true);
  });

  it("refuses a header that does not match the kind, an unknown kind, an empty or oversized source and unknown keys", () => {
    expect(UnitDiagramSchema.safeParse({ kind: "state", mermaid: sequence }).success).toBe(false);
    expect(UnitDiagramSchema.safeParse({ kind: "flow", mermaid: "flowchart\n  A --> B" }).success).toBe(false);
    expect(UnitDiagramSchema.safeParse({ kind: "class", mermaid: "classDiagram\n  A <|-- B" }).success).toBe(false);
    expect(UnitDiagramSchema.safeParse({ kind: "sequence", mermaid: "" }).success).toBe(false);
    expect(UnitDiagramSchema.safeParse({ kind: "sequence", mermaid: sequence + "\n" + "%% x".repeat(UNIT_DIAGRAM_MERMAID_MAX) }).success).toBe(false);
    expect(UnitDiagramSchema.safeParse({ kind: "sequence", mermaid: sequence, title: "x".repeat(61) }).success).toBe(false);
    expect(UnitDiagramSchema.safeParse({ kind: "sequence", mermaid: sequence, theme: "dark" }).success).toBe(false);
  });

  it("refuses the directives that style, reconfigure or link the diagram", () => {
    const cases: [string, RegExp][] = [
      ["%%{init: {'securityLevel': 'loose'}}%%\n" + sequence, /%%\{init\}/],
      ["flowchart LR\n  A --> B\n  click A callback", /click/],
      ['flowchart LR\n  A --> B\n  click A href "javascript:alert(1)"', /javascript/],
      ["flowchart LR\n  A --> B\n  style A fill:#f00", /style/],
      ["flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00", /style/],
      ["flowchart LR\n  A --> B\n  classDef hot fill:#f00\n  class A hot", /classDef/],
      ["flowchart LR\n  A:::hot --> B", /:::class/],
      ["flowchart LR\n  A[<img src=x onerror=alert(1)>] --> B", /HTML tag/],
      [sequence + "\n  link API: Dashboard @ https://example.com", /link/],
    ];
    for (const [mermaid, why] of cases) {
      const kind = mermaid.includes("sequenceDiagram") ? "sequence" : "flow";
      const result = UnitDiagramSchema.safeParse({ kind, mermaid });
      expect(result.success, mermaid).toBe(false);
      expect(unitDiagramProblems(mermaid).join("\n"), mermaid).toMatch(why);
    }
  });

  it("lets ordinary labels through: a <br/>, a comparison, a word that merely starts like a directive", () => {
    expect(unitDiagramProblems("flowchart LR\n  A[amount < limit] --> B[charge<br/>once]\n  B --> styles[Styles]", "flow")).toEqual([]);
  });

  it("rides on a unit, and a patch may drop it with null; a full unit may not carry null", () => {
    const unit = { id: "u", title: "t", summary: "s", kind: "core-logic", attention: "skim", attentionWhy: "w", order: 0, diagram: { kind: "sequence", mermaid: sequence } };
    expect(ReviewUnitSchema.parse(unit).diagram?.kind).toBe("sequence");
    expect(ReviewUnitSchema.safeParse({ ...unit, diagram: null }).success).toBe(false);
    expect(ReviewUnitPatchSchema.parse({ diagram: null }).diagram).toBeNull();
    expect(ReviewUnitPatchSchema.safeParse({ diagram: { kind: "sequence", mermaid: "click x" } }).success).toBe(false);
  });
});

describe("unit diagrams through the service", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 45 };
  let tmp: string;
  let h1: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-diagram-"));
    writeMeta(
      key,
      {
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: "https://github.com/acme/widgets/pull/45",
        createdAt: ts,
        archived: false,
      },
      tmp,
    );
    const added = ["charge()"];
    h1 = computeHunkId("src/a.ts", added, []);
    const files: FileDiff[] = [
      {
        path: "src/a.ts",
        status: "modified",
        binary: false,
        hunks: [
          {
            id: h1,
            file: "src/a.ts",
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            header: "",
            addedLines: added,
            removedLines: [],
            text: "",
          },
        ],
      },
    ];
    writeRevision(key, 1, "diff", files, { baseSha: "b", headSha: "h", mergeBase: "m" }, tmp);
    appendEvent(
      key,
      {
        type: "revision-added",
        revision: 1,
        baseSha: "b",
        headSha: "h",
        mergeBase: "m",
        baseOnly: false,
        files: toRevisionFiles(files),
      },
      tmp,
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const analysis = (diagram?: unknown) => ({
    summary: "s",
    units: [
      {
        id: "u1",
        title: "Charge",
        summary: "s",
        kind: "core-logic",
        attention: "must-read",
        attentionWhy: "w",
        hunkIds: [h1],
        order: 1,
        ...(diagram ? { diagram } : {}),
      },
    ],
  });

  it("set-analysis keeps a unit's diagram", () => {
    setAnalysis(key, analysis({ kind: "sequence", title: "Retrying a charge", mermaid: sequence }), {}, tmp);
    expect(loadState(key, tmp).units.find((u) => u.id === "u1")?.diagram).toEqual({ kind: "sequence", title: "Retrying a charge", mermaid: sequence });
  });

  it("set-analysis refuses a unit diagram with a forbidden directive", () => {
    expect(() => setAnalysis(key, analysis({ kind: "flow", mermaid: "flowchart LR\n  A --> B\n  click A cb" }), {}, tmp)).toThrow();
    expect(loadState(key, tmp).units).toEqual([]);
  });

  it("a unit patch sets, replaces and drops the diagram, leaving the rest of the unit", () => {
    setAnalysis(key, analysis(), {}, tmp);
    setUnit(key, "u1", { diagram: { kind: "sequence", mermaid: sequence } }, {}, tmp);
    expect(loadState(key, tmp).units[0].diagram?.kind).toBe("sequence");
    setUnits(key, [{ unitId: "u1", payload: { diagram: { kind: "state", title: "A charge's life", mermaid: "stateDiagram-v2\n  [*] --> Pending" } } }], tmp);
    let unit = loadState(key, tmp).units[0];
    expect(unit.diagram).toEqual({ kind: "state", title: "A charge's life", mermaid: "stateDiagram-v2\n  [*] --> Pending" });
    expect(unit.title).toBe("Charge");
    setUnit(key, "u1", { title: "Charge once" }, {}, tmp);
    expect(loadState(key, tmp).units[0].diagram?.kind).toBe("state");
    setUnit(key, "u1", { diagram: null }, {}, tmp);
    unit = loadState(key, tmp).units[0];
    expect(unit.diagram).toBeUndefined();
    expect("diagram" in unit).toBe(false);
    expect(unit.title).toBe("Charge once");
  });

  it("a unit patch with a forbidden directive is refused whole", () => {
    setAnalysis(key, analysis(), {}, tmp);
    expect(() => setUnit(key, "u1", { title: "x", diagram: { kind: "sequence", mermaid: "%%{init: {}}%%\n" + sequence } }, {}, tmp)).toThrow();
    expect(loadState(key, tmp).units[0].title).toBe("Charge");
  });
});
