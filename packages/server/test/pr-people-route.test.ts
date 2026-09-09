import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyToString, prDir, updateMeta, type PrKey } from "@reviewer/core";
import { buildFixture, key } from "./fixtures.js";
import { createApp } from "../src/app.js";

const { calls } = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../src/pr-people.js", async (original) => ({
  ...await original<typeof import("../src/pr-people.js")>(),
  createPrPeopleLoader: () => async (keys: PrKey[]) => {
    calls.push(keys.map(keyToString));
    return Object.fromEntries(keys.map((k) => [keyToString(k), { author: "fixture", relationship: "own" }]));
  },
}));
let root: string;
const archivedKey = { ...key, number: 8 };
beforeEach(() => {
  calls.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-people-scope-"));
  buildFixture(root);
  fs.cpSync(prDir(key, root), prDir(archivedKey, root), { recursive: true });
  updateMeta(archivedKey, { number: 8, archived: true }, root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("dashboard GitHub lookup scopes", () => {
  it.each([
    ["active", [keyToString(key)]],
    ["archived", [keyToString(archivedKey)]],
    ["all", [keyToString(key), keyToString(archivedKey)]],
  ])("looks up only %s PRs", async (scope, expected) => {
    const response = await createApp({ stateDir: root }).request(`/api/prs/people?scope=${scope}&force=true`);
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual([...expected].sort());
    expect(calls).toHaveLength(1);
    expect(calls[0].sort()).toEqual([...expected].sort());
  });

  it("rejects invalid scopes before starting GitHub requests", async () => {
    const response = await createApp({ stateDir: root }).request("/api/prs/people?scope=invalid");
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
