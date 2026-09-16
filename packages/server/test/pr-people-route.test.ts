import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyToString, prDir, updateMeta, type PrKey } from "@reviewer/core";
import { buildFixture, key } from "./fixtures.js";
import { createApp } from "../src/app.js";

const { calls, result } = vi.hoisted(() => ({ calls: [] as string[][], result: { relationship: "own" as "own" | "unknown" } }));
vi.mock("../src/pr-people.js", async (original) => ({
  ...await original<typeof import("../src/pr-people.js")>(),
  createPrPeopleLoader: () => async (keys: PrKey[]) => {
    calls.push(keys.map(keyToString));
    return Object.fromEntries(keys.map((k) => [keyToString(k), result.relationship === "unknown" ? { relationship: "unknown" } : { author: "fixture", relationship: "own" }]));
  },
}));
let root: string;
const archivedKey = { ...key, number: 8 };
beforeEach(() => {
  calls.length = 0;
  result.relationship = "own";
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

  it("retains saved grouping and metadata when GitHub becomes unavailable", async () => {
    const app = createApp({ stateDir: root });
    const first = await app.request("/api/prs/people?scope=active&force=true");
    expect((await first.json())[keyToString(key)]).toMatchObject({ author: "fixture", relationship: "own" });
    result.relationship = "unknown";
    const offline = await app.request("/api/prs/people?scope=active&force=true");
    expect((await offline.json())[keyToString(key)]).toMatchObject({ author: "fixture", relationship: "own" });
    // A new app instance still serves local grouping without waiting for GitHub.
    const list = await createApp({ stateDir: root }).request("/api/prs");
    const { prs } = await list.json();
    expect(prs.find((pr: { key: string }) => pr.key === keyToString(key)).meta)
      .toMatchObject({ author: "fixture", reviewRelationship: "own" });
  });

  it("rejects invalid scopes before starting GitHub requests", async () => {
    const response = await createApp({ stateDir: root }).request("/api/prs/people?scope=invalid");
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
