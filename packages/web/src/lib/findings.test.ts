import { describe, expect, it } from "vitest";
import { findingsBadge, sortFindings } from "./diffModel";
import { mockDetail } from "../mocks/fixture";
import type { Finding } from "../api/types";

const warning: Finding = { severity: "warning", text: "w", evidence: "a.ts:1" };
const note: Finding = { severity: "note", text: "n", evidence: "b.ts:2" };

describe("findingsBadge", () => {
  it("badges nothing when a unit has no findings", () => {
    expect(findingsBadge({})).toBeNull();
    expect(findingsBadge({ findings: [] })).toBeNull();
  });

  it("badges notes-only with the quieter ok severity", () => {
    expect(findingsBadge({ findings: [note, note] })).toEqual({
      severity: "note",
      count: 2,
      warnings: 0,
      notes: 2,
    });
  });

  it("a single warning makes the whole badge a warning, counting everything", () => {
    // One warning among notes still reads as "look here"; the count is the
    // total so the reader doesn't have to add two numbers to get it.
    expect(findingsBadge({ findings: [note, warning, note] })).toEqual({
      severity: "warning",
      count: 3,
      warnings: 1,
      notes: 2,
    });
  });
});

describe("sortFindings", () => {
  it("puts warnings first and is stable within each severity", () => {
    const a = { ...note, text: "a" };
    const b = { ...note, text: "b" };
    const w = { ...warning, text: "w" };
    expect(sortFindings([a, w, b]).map((f) => f.text)).toEqual(["w", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [note, warning];
    sortFindings(input);
    expect(input.map((f) => f.severity)).toEqual(["note", "warning"]);
  });
});

describe("mock fixture", () => {
  const byId = new Map(mockDetail.state.units.map((u) => [u.id, u]));

  it("renders both badge states so the UI can be eyeballed in mock mode", () => {
    expect(findingsBadge(byId.get("idempotent-charge-path")!)?.severity).toBe("warning");
    expect(findingsBadge(byId.get("transient-retry-backoff")!)?.severity).toBe("note");
    // ...and at least one unit with no findings at all, which must render
    // exactly as it did before findings existed.
    expect(findingsBadge(byId.get("wiring-and-docs")!)).toBeNull();
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

  it("has a unit that overflows the 2-item collapse, so 'show all' is exercised", () => {
    expect((byId.get("transient-retry-backoff")!.findings ?? []).length).toBeGreaterThan(2);
  });
});
