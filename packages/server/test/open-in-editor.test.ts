import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { keyToString, readMeta, writeMeta } from "@reviewer/core";
import { buildFixture, key } from "./fixtures.js";

vi.mock("../src/editors.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/editors.js")>(),
  getEditors: vi.fn(async () => [{ id: "code", name: "Visual Studio Code", available: true, command: "code {path}" }]),
}));
vi.mock("../src/pr-checkout.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/pr-checkout.js")>(), ensurePrCheckout: vi.fn(),
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
import { spawn } from "node:child_process";
import { ensurePrCheckout } from "../src/pr-checkout.js";
import { createApp } from "../src/app.js";
import { writeConfig } from "../src/config.js";
let root: string;
let app: ReturnType<typeof createApp>;
let unref: ReturnType<typeof vi.fn>;
const target = "/managed checkout/$&/github.com/acme/widgets/7";
const url = `/api/prs/${encodeURIComponent(keyToString(key))}/open-in-editor`;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-editor-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "no-web") });
  unref = vi.fn();
  vi.mocked(ensurePrCheckout).mockResolvedValue({ path: target, headSha: "head1" });
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref });
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ReturnType<typeof spawn>;
  });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
describe("open-in-editor route and target", () => {
  it.each([target, "/readers/other-branch", undefined])("always opens the managed target with configured path %s", async repoPath => {
    writeMeta(key, { ...readMeta(key, root), repoPath }, root);
    writeConfig({ managedCheckouts: false }, root);
    const res = await app.request(url, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: target });
    expect(ensurePrCheckout).toHaveBeenCalledWith(key, expect.objectContaining({ root, repoPath, headSha: "head1" }));
    expect(spawn).toHaveBeenCalledWith("code", [target], { detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledOnce();
  });
  it("returns no_editor without preparing or launching", async () => {
    writeConfig({ editor: { id: "none" } }, root);
    const res = await app.request(url, { method: "POST" });
    expect(res.status).toBe(409); expect((await res.json()).error).toBe("no_editor");
    expect(ensurePrCheckout).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });
  it("reports checkout failure and never falls back to the reader's clone", async () => {
    vi.mocked(ensurePrCheckout).mockResolvedValue({ error: "fetch failed" });
    const res = await app.request(url, { method: "POST" });
    expect(res.status).toBe(502); expect(await res.json()).toMatchObject({ error: "checkout_failed", detail: "fetch failed" });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("reports asynchronous spawn errors", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child as ReturnType<typeof spawn>;
    });
    const res = await app.request(url, { method: "POST" });
    expect(res.status).toBe(500); expect(await res.json()).toMatchObject({ detail: "ENOENT" });
  });
  it("launches an explicit editor without saving config first", async () => {
    writeConfig({ editor: { id: "none" } }, root);
    const res = await app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editor: { id: "custom", name: "Nova", command: "nova {path}" } }) });
    expect(res.status).toBe(200);
    expect(spawn).toHaveBeenCalledWith("nova", [target], { detached: true, stdio: "ignore" });
    expect(await (await app.request("/api/config")).json()).toMatchObject({ editor: { id: "none" } });
  });
  it.each([{ id: "custom", command: "nova" }, { id: "custom", command: "nova {path}", name: 12 }])("rejects invalid editor selections consistently: %j", async editor => {
    for (const endpoint of [url, "/api/config"]) {
      const res = await app.request(endpoint, { method: endpoint === url ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editor }) });
      expect(res.status).toBe(400);
    }
    expect(ensurePrCheckout).not.toHaveBeenCalled();
  });
  it("round trips selection and confirmation through config", async () => {
    const patch = { editor: { id: "custom", name: "Nova", command: 'code "{path}"' }, editorConfirmed: true };
    const res = await app.request("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject(patch);
    expect(await (await app.request("/api/config")).json()).toMatchObject(patch);
    expect(await (await app.request("/api/editors")).json()).toEqual([expect.objectContaining({ id: "code", available: true })]);
  });
});
