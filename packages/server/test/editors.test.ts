import { describe, expect, it, vi } from "vitest";
import { commandArgs, getEditors, probeEditors, selectedEditor } from "../src/editors.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((_file, _args, _options, callback) => callback(new Error("not found"), "")),
}));
import { execFile } from "node:child_process";

const editor = { id: "code", name: "VS Code", available: true, command: "code {path}" };
describe("editor choice", () => {
  it("defaults to the first available editor in list order", () => {
    expect(selectedEditor(null, [editor])).toEqual(editor);
    expect(selectedEditor(null, [])).toBeUndefined();
    expect(selectedEditor(null, [{ ...editor, available: false }, { ...editor, id: "zed" }])?.id).toBe("zed");
    expect(selectedEditor(null, [editor, { ...editor, id: "zed" }])?.id).toBe("code");
    expect(selectedEditor({ id: "none" }, [editor])).toBeUndefined();
    expect(selectedEditor({ id: "code" }, [{ ...editor, available: false }])).toBeUndefined();
    expect(selectedEditor({ id: "custom", command: "tool {path}" }, [])?.command).toBe("tool {path}");
  });
  it("parses quotes without evaluating shell syntax", () => {
    expect(commandArgs(`'/some editor/code' --folder "{path}"`)).toEqual(["/some editor/code", "--folder", "{path}"]);
    expect(commandArgs("code $(touch nope) {path}")).toContain("$(touch");
    expect(() => commandArgs('code "')).toThrow("Unclosed quote");
  });
});
describe("editor probes", () => {
  function deps() {
    return { which: vi.fn(async (name: string): Promise<string | undefined> => name === "code" ? "/bin/code" : undefined),
      exists: vi.fn(async (p: string) => p === "/Applications/Cursor.app" || p === "/home/me/Applications/Zed.app"),
      platform: "darwin", home: "/home/me", env: {} as NodeJS.ProcessEnv };
  }
  it("prefers PATH, falls back to either application directory and reports unavailable entries", async () => {
    const d = deps(); const found = await probeEditors(d);
    expect(found.find(e => e.id === "code")?.command).toBe("'/bin/code' {path}");
    expect(d.exists).not.toHaveBeenCalledWith("/Applications/Visual Studio Code.app");
    expect(found.find(e => e.id === "cursor")?.command).toBe("open -a '/Applications/Cursor.app' {path}");
    expect(found.find(e => e.id === "zed")?.available).toBe(true);
    expect(found.find(e => e.id === "idea")?.available).toBe(false);
    expect(d.which).toHaveBeenCalledTimes(9);
  });
  it("does not probe bundles outside macOS", async () => {
    const d = deps(); d.platform = "linux"; await probeEditors(d); expect(d.exists).not.toHaveBeenCalled();
  });
  it.each(["vim", "/usr/bin/nvim", "nano", "emacs -nw"])("excludes terminal editor %s", async value => {
    const d = deps(); d.env.EDITOR = value;
    expect((await probeEditors(d)).some(e => e.id === "shell")).toBe(false);
  });
  it("prefers VISUAL over EDITOR", async () => {
    const d = deps(); d.env = { VISUAL: "zed --new", EDITOR: "vim" };
    expect((await probeEditors(d)).find(e => e.id === "shell")?.command).toBe("zed --new {path}");
  });
});

it("caches concurrent and subsequent detection requests once per process", async () => {
  const first = getEditors();
  expect(getEditors()).toBe(first);
  await first;
  expect(getEditors()).toBe(first);
  expect(execFile).toHaveBeenCalledTimes(9);
});
