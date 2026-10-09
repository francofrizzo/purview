import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GENERATED_UNIT_ID,
  keyToString,
  loadState,
  readFilesJson,
  readRepoConfig,
  repoKeyOf,
  setGhRunner,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { clearEffortCache, reviewEffort } from "../src/effort.js";
import { REV1_PATCH, buildFixture, key } from "./fixtures.js";

const LOCK = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 1111111..2222222 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -40,2 +40,3 @@
 a
+b
 c
`;

const encodedKey = encodeURIComponent(keyToString(key));
const encodedRepo = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}`);

let root: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-generated-route-"));
  // An analysis written before generated files existed: one unit holds the
  // lockfile hunk too.
  buildFixture(root, REV1_PATCH + LOCK);
  // No network here: every fact read fails, which only means "no signal".
  setGhRunner(() => {
    throw new Error("offline");
  });
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__"), autoAnalyze: false });
  clearEffortCache();
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (body: unknown) =>
  app.request(`/api/prs/${encodedKey}/generated`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const lockHunk = () => readFilesJson(key, 1, root).files.find((f) => f.path === "pnpm-lock.yaml")!.hunks[0].id;

describe("generated files on the server", () => {
  it("classifies a revision recorded before classification existed, pulling hunks out of old units", async () => {
    expect(loadState(key, root).units.map((u) => u.id)).toEqual(["unit-1"]);
    const body = await (await post({ path: "src/foo.ts", generated: false })).json();
    expect(body).toEqual({ ok: true, generated: ["pnpm-lock.yaml"] });
    const state = loadState(key, root);
    expect(state.units.map((u) => u.id)).toEqual(["unit-1", GENERATED_UNIT_ID]);
    expect(state.units[0].hunkIds).not.toContain(lockHunk());
  });

  it("POST /generated moves a file in and out, remembered for the repo", async () => {
    await post({ path: "src/foo.ts", generated: false }); // classify
    let body = await (await post({ path: "pnpm-lock.yaml", generated: false })).json();
    expect(body.generated).toEqual([]);
    let state = loadState(key, root);
    expect(state.units.some((u) => u.id === GENERATED_UNIT_ID)).toBe(false);
    // the lockfile hunk now waits for the incremental analysis: in no unit
    expect(state.units.flatMap((u) => u.hunkIds)).not.toContain(lockHunk());
    expect(readRepoConfig(repoKeyOf(key), root).generated.exclude).toContain("pnpm-lock.yaml");

    body = await (await post({ path: "src/foo.ts", generated: true })).json();
    expect(body.generated).toEqual(["src/foo.ts"]);
    state = loadState(key, root);
    // unit-1 held only src/foo.ts now: it is gone, not an empty husk
    expect(state.units.map((u) => u.id)).toEqual([GENERATED_UNIT_ID]);
    const detail = await (await app.request(`/api/prs/${encodedKey}`)).json();
    expect(detail.files.find((f: { path: string }) => f.path === "src/foo.ts").generated).toEqual({
      source: "repo",
      detail: "src/foo.ts",
    });

    expect((await post({ path: "nope.ts", generated: true })).status).toBe(400);
    expect((await post({ path: "src/foo.ts" })).status).toBe(400);
  });

  it("the PR list, readiness and effort leave the generated unit out", async () => {
    await post({ path: "src/foo.ts", generated: false });
    const list = await (await app.request("/api/prs")).json();
    const row = list.prs.find((p: { key: string }) => p.key === keyToString(key));
    expect(row.progress.units.total).toBe(1);
    expect(row.progress.hunks.total).toBe(2);
    expect(row.progress.files.total).toBe(1);
    const review = await (await app.request(`/api/prs/${encodedKey}/review`)).json();
    expect(review.readiness.hunks.total).toBe(2);
    expect(review.readiness.units.total).toBe(1);

    // only the generated unit left: "not analyzed"
    await post({ path: "src/foo.ts", generated: true });
    const after = (await (await app.request("/api/prs")).json()).prs[0];
    expect(after.progress.units.total).toBe(0);
    expect(after.progress.hunks.total).toBe(0);
    clearEffortCache();
    expect(reviewEffort(key, root)).toBeNull();
  });

  it("PUT repo config `generated` re-classifies the repo's PRs from cached facts", async () => {
    await post({ path: "src/foo.ts", generated: false }); // classify, caches facts
    const res = await app.request(`/api/repos/${encodedRepo}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generated: { include: ["src/**", " "], exclude: [] } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).local.generated).toEqual({ include: ["src/**"], exclude: [] });
    // the exact "src/foo.ts" exclude from the first call was replaced too
    expect(loadState(key, root).generated.map((g) => g.path).sort()).toEqual(["pnpm-lock.yaml", "src/foo.ts"]);
  });
});
