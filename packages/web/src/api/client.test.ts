import { describe, expect, it } from "vitest";
import { adaptDetail, adaptState, type WirePrDetail, type WireState } from "./client";

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
        behaviorChanges: [],
        architecture: { sources: ["docs/architecture.md"], checked: [], deviations: [], decisions: [] },
      }),
    );
    expect(state.fileNotes).toEqual({ "a.ts": "note" });
    expect(state.concepts?.[0].term).toBe("Charge key");
    expect(state.behaviorChanges).toEqual([]);
    expect(state.architecture?.sources).toEqual(["docs/architecture.md"]);
  });

  it("leaves a view out when the analysis drew none", () => {
    const state = adaptState(wire());
    expect("concepts" in state).toBe(false);
    expect("fileNotes" in state).toBe(false);
    expect("architecture" in adaptState(wire({ architecture: null }))).toBe(false);
  });
});

describe("adaptDetail", () => {
  const raw = (extra: Partial<WirePrDetail> = {}): WirePrDetail => ({
    state: wire(),
    files: [],
    diff: "",
    meta: { title: "t", author: "me" } as WirePrDetail["meta"],
    ...extra,
  });

  it("keeps whose PR it is and who comments go to", () => {
    const detail = adaptDetail(
      raw({ authoredByYou: true, commentAudience: { effective: "agent", override: null } }),
      "github.com/o/r/1",
    );
    expect(detail.authoredByYou).toBe(true);
    expect(detail.commentAudience).toEqual({ effective: "agent", override: null });
  });
});
