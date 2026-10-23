import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendEvents, listPrs, readEvents, rebuildState } from "../src/store.js";
import { eventsPath, prDir, statePath, type PrKey } from "../src/paths.js";

const roots: string[] = [];
const scratch = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-incremental-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const key: PrKey = { host: "github.com", owner: "test", repo: "test", number: 1 };

it.each(["valid", "missing", "corrupt", "old"])("appends to a %s snapshot with the same JSON as a refold", (snapshot) => {
  const root = scratch();
  appendEvents(key, [
    { type: "pr-initialized", ...key, title: "Test", url: "https://github.com/test/test/pull/1" },
    { type: "revision-added", revision: 1, baseSha: "base", headSha: "head", mergeBase: "base", files: [{ path: "a.ts", hunkIds: ["h1"] }] },
  ], root);
  if (snapshot === "missing") fs.unlinkSync(statePath(key, root));
  if (snapshot === "corrupt") fs.writeFileSync(statePath(key, root), "{");
  if (snapshot === "old") {
    const state = JSON.parse(fs.readFileSync(statePath(key, root), "utf8"));
    state.shapeVersion = 0;
    fs.writeFileSync(statePath(key, root), JSON.stringify(state));
  }
  appendEvents(key, [{ type: "hunk-viewed", hunkId: "h1", revision: 1 }, { type: "pr-retitled", title: "Next" }], root);
  const actual = JSON.parse(fs.readFileSync(statePath(key, root), "utf8"));
  rebuildState(key, root);
  expect(JSON.parse(fs.readFileSync(statePath(key, root), "utf8"))).toEqual(actual);
});

// Opt-in: never copy private review data into the repository. Run against a
// supplied state copy, copying its largest history again before any writes.
it.skipIf(!process.env.PURVIEW_TEST_STATE_COPY)("matches a full refold on the largest copied real log", () => {
  const source = process.env.PURVIEW_TEST_STATE_COPY!;
  const histories = listPrs(source).map(key => ({ key, events: readEvents(key, source) }));
  const largest = histories.sort((a, b) => b.events.length - a.events.length)[0];
  expect(largest).toBeDefined();
  const root = scratch();
  fs.mkdirSync(prDir(largest.key, root), { recursive: true });
  fs.copyFileSync(eventsPath(largest.key, source), eventsPath(largest.key, root));
  const state = rebuildState(largest.key, root);
  const hunkId = Object.keys(state.hunks)[0];
  appendEvents(largest.key, [{ type: "hunk-viewed", hunkId, revision: state.currentRevision }, { type: "hunk-unviewed", hunkId, revision: state.currentRevision }], root);
  const actual = JSON.parse(fs.readFileSync(statePath(largest.key, root), "utf8"));
  rebuildState(largest.key, root);
  expect(JSON.parse(fs.readFileSync(statePath(largest.key, root), "utf8"))).toEqual(actual);
});
