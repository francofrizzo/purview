import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setAnalysis, setShape } from "../src/service.js";
import { appendEvent, loadState, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import { fold } from "../src/reducer.js";
import { AnalysisSchema, ShapeSchema, type ReviewerEvent } from "../src/schemas.js";
import { ArchitectureSchema, architectureQuoteProblems, type Architecture } from "../src/architecture.js";
import type { FileDiff, PrKey } from "../src/index.js";

/** The `architecture` experiment: the PR against the repo's documented architecture. */

const ts = "2026-01-01T00:00:00.000Z";

const DOC = [
  "# Architecture",
  "",
  "## Persistence",
  "",
  "Only `src/billing/ledger.ts` reads or writes `charge_ledger`;",
  "everything else goes through `Ledger`.",
  "",
  "The ledger records each charge’s outcome.",
].join("\n");

const RULE = "Only `src/billing/ledger.ts` reads or writes `charge_ledger`; everything else goes through `Ledger`.";

function arch(over: Partial<Architecture> = {}): Architecture {
  return {
    sources: ["docs/architecture.md"],
    checked: [{ source: "docs/architecture.md", rule: RULE }],
    deviations: [
      {
        what: "Reconciler queries the ledger table itself",
        rule: { source: "docs/architecture.md", heading: "Persistence", quote: RULE },
        code: { unit: "u", file: "src/a.ts", line: 1, excerpt: "pool.query(`SELECT * FROM charge_ledger`)" },
      },
    ],
    decisions: [],
    ...over,
  };
}

describe("ArchitectureSchema", () => {
  it("takes a view with no deviations and no decisions: the empty answer", () => {
    expect(ArchitectureSchema.safeParse(arch({ deviations: [] })).success).toBe(true);
  });

  it("caps the rows and the strings, and an excerpt at three lines", () => {
    const d = arch().deviations[0];
    expect(ArchitectureSchema.safeParse(arch({ deviations: Array(6).fill(d) })).success).toBe(false);
    expect(ArchitectureSchema.safeParse(arch({ decisions: Array(5).fill({ what: "w", means: "m" }) })).success).toBe(false);
    expect(ArchitectureSchema.safeParse(arch({ checked: Array(13).fill({ source: "a.md", rule: "r" }) })).success).toBe(false);
    expect(ArchitectureSchema.safeParse(arch({ deviations: [{ ...d, what: "x".repeat(61) }] })).success).toBe(false);
    expect(ArchitectureSchema.safeParse(arch({ deviations: [{ ...d, why: "x".repeat(161) }] })).success).toBe(false);
    expect(ArchitectureSchema.safeParse(arch({ deviations: [{ ...d, code: { ...d.code, excerpt: "a\nb\nc\nd" } }] })).success).toBe(false);
    expect(ArchitectureSchema.safeParse(arch({ deviations: [{ ...d, code: { ...d.code, excerpt: "a\nb\nc" } }] })).success).toBe(true);
    expect(ArchitectureSchema.safeParse({ ...arch(), extra: 1 }).success).toBe(false);
  });

  it("rides on the analysis and on set-shape, where null drops it", () => {
    expect(AnalysisSchema.parse({ summary: "s", units: [], architecture: arch() }).architecture?.deviations).toHaveLength(1);
    expect(AnalysisSchema.parse({ summary: "s", units: [], architecture: null }).architecture).toBeNull();
    expect(ShapeSchema.parse({ architecture: null }).architecture).toBeNull();
  });

  it("folds into the state from an analysis, and a set-shape null drops it", () => {
    const rev = { ts, type: "revision-added", revision: 1, baseSha: "b", headSha: "h", mergeBase: "m", baseOnly: false, files: [{ path: "a.ts", hunkIds: ["h1"] }] } as ReviewerEvent;
    const set = { ts, type: "analysis-set", revision: 1, summary: "s", units: [], unassigned: ["h1"], architecture: arch() } as ReviewerEvent;
    expect(fold([rev, set]).architecture?.sources).toEqual(["docs/architecture.md"]);
    expect(fold([rev, set, { ts, type: "shape-set", revision: 1, architecture: null } as ReviewerEvent]).architecture).toBeUndefined();
    // A later analysis that draws none drops it too.
    expect(fold([rev, set, { ...set, architecture: undefined } as ReviewerEvent]).architecture).toBeUndefined();
  });
});

describe("architectureQuoteProblems", () => {
  let checkout: string;

  beforeEach(() => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-arch-checkout-"));
    fs.mkdirSync(path.join(checkout, "docs"));
    fs.writeFileSync(path.join(checkout, "docs/architecture.md"), DOC);
  });

  afterEach(() => {
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  it("finds a quote that wraps differently, and one typed with plain quotes for curly ones", () => {
    expect(architectureQuoteProblems(arch(), checkout)).toEqual([]);
    const plain = arch({ checked: [{ source: "docs/architecture.md", rule: "The ledger records each charge's outcome." }] });
    expect(architectureQuoteProblems(plain, checkout)).toEqual([]);
  });

  it("refuses a quote its source does not say, naming where it is", () => {
    const made = arch({ deviations: [{ ...arch().deviations[0], rule: { source: "docs/architecture.md", quote: "Jobs never touch the database." } }] });
    const problems = architectureQuoteProblems(made, checkout);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^architecture\.deviations\[0\]\.rule: "Jobs never touch the database\." is not in docs\/architecture\.md/);
  });

  it("refuses a source it cannot read, one outside the checkout, and a view with no checkout at all", () => {
    expect(architectureQuoteProblems(arch({ checked: [{ source: "docs/missing.md", rule: RULE }] }), checkout)[0]).toMatch(/cannot be read/);
    expect(architectureQuoteProblems(arch({ checked: [{ source: "../outside.md", rule: RULE }] }), checkout)[0]).toMatch(/not a path of the repo/);
    expect(architectureQuoteProblems(arch({ checked: [{ source: "/etc/hosts", rule: "localhost" }] }), checkout)[0]).toMatch(/not a path of the repo/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-arch-outside-"));
    fs.writeFileSync(path.join(outside, "rules.md"), RULE);
    fs.symlinkSync(path.join(outside, "rules.md"), path.join(checkout, "docs/link.md"));
    expect(architectureQuoteProblems(arch({ checked: [{ source: "docs/link.md", rule: RULE }] }), checkout)[0]).toMatch(/outside the checkout/);
    fs.rmSync(outside, { recursive: true, force: true });
    expect(architectureQuoteProblems(arch(), undefined)).toEqual([expect.stringMatching(/no checkout/)]);
  });
});

describe("architecture through the service", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 46 };
  let tmp: string;
  let checkout: string;
  let h1: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-arch-"));
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-arch-checkout-"));
    fs.mkdirSync(path.join(checkout, "docs"));
    fs.writeFileSync(path.join(checkout, "docs/architecture.md"), DOC);
    writeMeta(key, { host: key.host, owner: key.owner, repo: key.repo, number: key.number, url: "https://github.com/acme/widgets/pull/46", createdAt: ts, archived: false }, tmp);
    const added = ["charge()"];
    h1 = computeHunkId("src/a.ts", added, []);
    const files: FileDiff[] = [
      {
        path: "src/a.ts",
        status: "modified",
        binary: false,
        hunks: [{ id: h1, file: "src/a.ts", oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: "", addedLines: added, removedLines: [], text: "" }],
      },
    ];
    writeRevision(key, 1, "diff", files, { baseSha: "b", headSha: "h", mergeBase: "m" }, tmp);
    appendEvent(key, { type: "revision-added", revision: 1, baseSha: "b", headSha: "h", mergeBase: "m", baseOnly: false, files: toRevisionFiles(files) }, tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const unit = () => ({ id: "u", title: "t", summary: "s", kind: "core-logic", attention: "skim", attentionWhy: "w", order: 0, hunks: [h1] });

  it("saves a view whose quotes its sources say, and refuses one they do not, with what to fix", () => {
    setAnalysis(key, { summary: "s", units: [unit()], architecture: arch() }, { checkout }, tmp);
    expect(loadState(key, tmp).architecture?.deviations[0].rule.quote).toBe(RULE);
    expect(() =>
      setAnalysis(key, { summary: "s", units: [unit()], architecture: arch({ checked: [{ source: "docs/architecture.md", rule: "Nothing calls the gateway." }] }) }, { checkout }, tmp),
    ).toThrow(/architecture\.checked\[0\]: "Nothing calls the gateway\." is not in docs\/architecture\.md/);
  });

  it("refuses a view without a checkout to check it in, and rows pointing at no unit or file of the revision", () => {
    expect(() => setAnalysis(key, { summary: "s", units: [unit()], architecture: arch() }, {}, tmp)).toThrow(/no checkout/);
    const d = arch().deviations[0];
    expect(() =>
      setAnalysis(key, { summary: "s", units: [unit()], architecture: arch({ deviations: [{ ...d, code: { ...d.code, unit: "nope", file: "src/b.ts" } }], decisions: [{ what: "w", means: "m", unit: "gone" }] }) }, { checkout }, tmp),
    ).toThrow(/deviations\[0\]\.code: unit "nope"[\s\S]*"src\/b\.ts" is not a file[\s\S]*decisions\[0\]: unit "gone"/);
  });

  it("an analysis without one saves as before, with no checkout needed; set-shape redraws it or drops it with null", () => {
    setAnalysis(key, { summary: "s", units: [unit()] }, {}, tmp);
    expect(loadState(key, tmp).architecture).toBeUndefined();
    setShape(key, { architecture: arch({ deviations: [] }) }, tmp, { checkout });
    expect(loadState(key, tmp).architecture?.deviations).toEqual([]);
    expect(() => setShape(key, { architecture: arch() }, tmp)).toThrow(/no checkout/);
    setShape(key, { architecture: null }, tmp);
    expect(loadState(key, tmp).architecture).toBeUndefined();
  });
});
