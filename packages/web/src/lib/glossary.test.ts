import { describe, expect, it } from "vitest";
import type { Concept } from "../api/types";
import { buildGlossary, conceptTip } from "./glossary";

const snapshot: Concept = {
  term: "Snapshot source",
  means: "A source that sends its full list every time.",
  aka: ["SNAPSHOT"],
};
const pending: Concept = { term: "Pending", means: "Not reconciled yet.", aka: ["UNRECONCILED"] };
const key: Concept = { term: "Installment key", means: "What identifies an installment.", aka: ["tpk"], isNew: true };
const glossary = buildGlossary([snapshot, pending, key])!;

const named = (text: string) => glossary.find(text).map((h) => [text.slice(h.start, h.end), h.concept.term]);

describe("buildGlossary", () => {
  it("is nothing without concepts", () => {
    expect(buildGlossary(undefined)).toBeNull();
    expect(buildGlossary([])).toBeNull();
  });

  it("finds a code name as written and a term in any case", () => {
    expect(named("An UNRECONCILED row of a snapshot source")).toEqual([
      ["UNRECONCILED", "Pending"],
      ["snapshot source", "Snapshot source"],
    ]);
    // The code's own name only as written: an ordinary "unreconciled" is not it.
    expect(named("still unreconciled")).toEqual([]);
  });

  it("takes whole words only", () => {
    expect(named("tpk_id and tpks")).toEqual([]);
    expect(named("by tpk.")).toEqual([["tpk", "Installment key"]]);
  });

  it("prefers the longer name where two overlap", () => {
    expect(named("Each Snapshot source sends SNAPSHOT rows")).toEqual([
      ["Snapshot source", "Snapshot source"],
      ["SNAPSHOT", "Snapshot source"],
    ]);
  });

  it("names a whole code span", () => {
    expect(glossary.forCode("UNRECONCILED")?.term).toBe("Pending");
    expect(glossary.forCode("persistRecords")).toBeNull();
  });

  it("says the term and its meaning on hover, and whether the PR brings it", () => {
    expect(conceptTip(key)).toBe("Installment key (new in this PR): What identifies an installment.");
  });
});
