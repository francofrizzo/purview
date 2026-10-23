import { describe, expect, it, vi } from "vitest";
import { act, create } from "react-test-renderer";
import { UnitSidebar } from "./UnitSidebar";
import { mockDetail } from "../mocks/fixture";

const { titles } = vi.hoisted(() => ({ titles: vi.fn() }));
vi.mock("./Markdown", () => ({ InlineMarkdown: ({ text }: { text: string }) => { titles(text); return text; } }));
vi.mock("../lib/settings", () => ({ useSettings: () => ({ settings: { hideReviewedUnits: false }, update: vi.fn() }) }));

describe("unit sidebar render isolation", () => {
  it("skips unchanged rows during search and collapse updates, but updates matches and selection", () => {
    const detail = structuredClone(mockDetail);
    detail.state.removedUnits = [];
    const props = { detail, selectedUnitId: null, onSelect: vi.fn(), onReclassify: vi.fn(), onQuote: vi.fn() };
    let root: ReturnType<typeof create>;
    act(() => { root = create(<UnitSidebar {...props} />); });
    const mounted = titles.mock.calls.length;
    expect(mounted).toBeGreaterThan(0);
    titles.mockClear();
    // Parent updates from keystrokes and hunk toggles, with fresh search maps.
    for (let i = 0; i < 4; i++) act(() => root.update(<UnitSidebar {...props} matchCounts={new Map()} />));
    expect(titles).toHaveBeenCalledTimes(0);
    const id = detail.state.units.find((u) => u.attention === "must-read")!.id;
    act(() => root.update(<UnitSidebar {...props} matchCounts={new Map([[id, 3]])} />));
    expect(titles).toHaveBeenCalledTimes(1);
    titles.mockClear();
    act(() => root.update(<UnitSidebar {...props} selectedUnitId={id} matchCounts={new Map([[id, 3]])} />));
    expect(titles).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
