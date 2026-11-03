import { describe, expect, it } from "vitest";
import { shownFindings } from "./diffModel";
import { mockDetail } from "../mocks/fixture";
import type { Finding } from "../api/types";

const warning: Finding = { severity: "warning", text: "w", evidence: "a.ts:1" };
const note: Finding = { severity: "note", text: "n", evidence: "b.ts:2" };

describe("shownFindings", () => {
  it("shows the warnings and hides an older analysis's notes", () => {
    expect(shownFindings([note, warning, note])).toEqual([warning]);
    expect(shownFindings([note])).toEqual([]);
    expect(shownFindings(undefined)).toEqual([]);
  });
});

describe("mock fixture", () => {
  const byId = new Map(mockDetail.state.units.map((u) => [u.id, u]));

  it("has a unit with a warning and one with only notes, which shows no findings", () => {
    expect(shownFindings(byId.get("idempotent-charge-path")!.findings)).toHaveLength(1);
    expect(byId.get("transient-retry-backoff")!.findings?.length).toBeGreaterThan(0);
    expect(shownFindings(byId.get("transient-retry-backoff")!.findings)).toEqual([]);
  });

  it("keeps every fixture finding within the schema's limits", () => {
    for (const unit of mockDetail.state.units) {
      const findings = unit.findings ?? [];
      expect(findings.length).toBeLessThanOrEqual(5);
      for (const f of findings) {
        expect(f.evidence.trim()).not.toBe("");
        expect(f.evidence.length).toBeLessThanOrEqual(200);
        expect(f.text.length).toBeGreaterThan(0);
        expect(f.text.length).toBeLessThanOrEqual(300);
      }
    }
  });
});
