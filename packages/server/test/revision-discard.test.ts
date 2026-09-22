import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyToString, loadState, readEvents, refreshPr, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { analysisIdle } from "../src/analysis.js";
import { REV2_PATCH, buildFixture, key } from "./fixtures.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";

const encodedKey = encodeURIComponent(keyToString(key));

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-discard-route-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  claude = fakeClaude({ lines: scriptedRun() });
  claude.install();
});

afterEach(() => {
  claude.restore();
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

/** Advance the fixture PR to revision 2 through a stubbed gh. */
function refreshToRev2() {
  setGhRunner((args) => {
    const joined = args.join(" ");
    if (joined.includes("Accept: application/vnd.github.v3.diff")) return REV2_PATCH;
    if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    return JSON.stringify({
      node_id: "PR_1",
      number: key.number,
      title: "Add widgets",
      html_url: "https://example.invalid/pr",
      state: "open",
      base: { ref: "main", sha: "base1" },
      head: { ref: "feature", sha: "head2" },
    });
  });
  return refreshPr(key, root);
}

const discard = (n: number | string) =>
  app.request(`/api/prs/${encodedKey}/revisions/${n}/discard`, { method: "POST" });

describe("POST /api/prs/:key/revisions/:n/discard", () => {
  it("drops the latest revision and serves the one before it", async () => {
    refreshToRev2();
    const res = await discard(2);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ discarded: 2, revision: 1 });
    expect(body.state.currentRevision).toBe(1);

    const detail = await (await app.request(`/api/prs/${encodedKey}`)).json();
    expect(detail.state.currentRevision).toBe(1);
    expect(detail.state.revisions.map((r: { revision: number }) => r.revision)).toEqual([1]);
    expect(detail.diff).toContain("+new2"); // revision 1's diff, not revision 2's
    expect(readEvents(key, root).at(-1)).toMatchObject({ type: "revision-discarded", revision: 2 });
  });

  it("409s for a revision that is not the latest", async () => {
    refreshToRev2();
    const res = await discard(1);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("not_latest");
    expect(body.detail).toMatch(/only the latest revision/);
    expect(loadState(key, root).currentRevision).toBe(2);
  });

  it("409s for the only revision", async () => {
    const res = await discard(1);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("only_revision");
  });

  it("400s for a revision that is not a number, 404s for an unknown PR", async () => {
    expect((await discard("latest")).status).toBe(400);
    const other = encodeURIComponent("github.com/acme/other/1");
    expect((await app.request(`/api/prs/${other}/revisions/2/discard`, { method: "POST" })).status).toBe(404);
  });

  it("409s while comments written since the revision was added exist", async () => {
    refreshToRev2();
    const created = await app.request(`/api/prs/${encodedKey}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "src/foo.ts", line: 2, side: "RIGHT", body: "Why?" }),
    });
    expect(created.status).toBe(201);
    const res = await discard(2);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("comments_since");
    expect(body.detail).toMatch(/^1 comment was written since r2 was added/);

    // Deleting it clears the way.
    const { id } = (await created.json()).comment;
    await app.request(`/api/prs/${encodedKey}/comments/${id}`, { method: "DELETE" });
    expect((await discard(2)).status).toBe(200);
  });

  it("409s while an analysis is queued or running", async () => {
    refreshToRev2();
    claude.restore();
    claude = fakeClaude({ hang: true, lines: scriptedRun() });
    claude.install();
    expect((await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" })).status).toBe(200);

    const res = await discard(2);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("analysis_in_progress");
    expect(loadState(key, root).currentRevision).toBe(2);

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "DELETE" });
    await analysisIdle();
  });
});
