import { describe, expect, it } from "vitest";
import { editorAvailable, effectiveEditor } from "./editor";
import type { GlobalConfig } from "../api/types";
describe("editor menu", () => {
  it("uses the custom name with a fallback for older selections", () => {
    const editor = { id: "custom", command: "nova {path}" };
    expect(effectiveEditor({ editor } as GlobalConfig)?.name).toBe("your editor");
    expect(effectiveEditor({ editor: { ...editor, name: "Nova" } } as GlobalConfig)?.name).toBe("Nova");
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
