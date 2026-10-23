import { describe, expect, it } from "vitest";
import { editorAvailable, editorMenuText } from "./editor";
import type { GlobalConfig } from "../api/types";
describe("editor menu", () => {
  it("maps idle and preparation labels to the same ownership tooltip", () => {
    expect(editorMenuText(false, "Cursor")).toEqual({ label: "open in Cursor", hint: "Purview's own copy of this PR, detached at its head commit, in Cursor" });
    expect(editorMenuText(true, "Cursor")).toEqual({ ...editorMenuText(false, "Cursor"), label: "preparing checkout…" });
    expect(editorMenuText(false).label).toBe("open in editor");
  });
  it("shows a selected available editor, or any found one when nothing is chosen", () => {
    const config = { editor: null } as GlobalConfig;
    const editors = [{ id: "code", name: "Code", command: "code {path}", available: true }];
    expect(editorAvailable(config, editors)).toBe(true);
    expect(editorAvailable(config, [])).toBe(false);
    expect(editorAvailable({ ...config, editor: { id: "none" } }, editors)).toBe(false);
    expect(editorAvailable(config, [...editors, { ...editors[0], id: "zed" }])).toBe(true);
    expect(editorAvailable({ ...config, editor: { id: "custom", command: "tool {path}" } }, [])).toBe(true);
  });
});
