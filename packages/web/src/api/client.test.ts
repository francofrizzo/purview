import { describe, expect, it } from "vitest";
import { adaptState, type WireState } from "./client";

const wire = (extra: Partial<WireState> = {}): WireState => ({
  currentRevision: 1,
  revisions: [],
  summary: "",
  units: [],
  hunks: {},
  files: [],
  unassignedHunkIds: [],
  ...extra,
});

describe("adaptState", () => {
  it("carries every view of the shape the analysis wrote", () => {
    const state = adaptState(
      wire({
        fileNotes: { "a.ts": "note" },
        concepts: [{ term: "Charge key", means: "What makes two charges one.", aka: ["idempotencyKey"] }],
        example: { case: "A retry", before: ["Charged twice."], after: ["Charged once."] },
      }),
    );
    expect(state.fileNotes).toEqual({ "a.ts": "note" });
    expect(state.concepts?.[0].term).toBe("Charge key");
    expect(state.example?.after).toEqual(["Charged once."]);
  });

  it("leaves a view out when the analysis drew none", () => {
    const state = adaptState(wire());
    expect("concepts" in state).toBe(false);
    expect("example" in state).toBe(false);
  });
});
