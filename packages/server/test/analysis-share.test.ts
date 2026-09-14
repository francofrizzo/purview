import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyToString, loadState, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { analysisIdle } from "../src/analysis.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";

const encodedKey = encodeURIComponent(keyToString(key));

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-analysis-share-route-"));
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  claude = fakeClaude({ lines: scriptedRun() });
  claude.install();
});

afterEach(() => {
  claude.restore();
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/prs/:key/analysis/export", () => {
  it("downloads the current analysis as an attachment", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/analysis/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(
      `${key.owner}-${key.repo}-${key.number}-analysis.json`,
    );
    const body = await res.json();
    expect(body.format).toBe("purview-analysis");
    expect(body.version).toBe(1);
    expect(body.pr).toEqual({ host: key.host, owner: key.owner, repo: key.repo, number: key.number });
    expect(body.units).toHaveLength(1);
    expect(body.units[0].id).toBe("unit-1");
  });

  it("404s for an unknown PR", async () => {
    const res = await app.request(
      `/api/prs/${encodeURIComponent("github.com/acme/other/1")}/analysis/export`,
    );
    expect(res.status).toBe(404);
  });

  it("409s when there is no analysis yet", async () => {
    // Build a PR with a revision but no analysis-set event (buildFixture's
    // default fixture always includes one, so this is assembled by hand).
    const { writeMeta, appendEvent, writeRevision, toRevisionFiles, parseDiff } = await import(
      "@reviewer/core"
    );
    const { REV1_PATCH } = await import("./fixtures.js");
    const files = parseDiff(REV1_PATCH);
    writeMeta(
      key,
      {
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
        title: "Add widgets",
        createdAt: new Date().toISOString(),
      },
      root,
    );
    appendEvent(
      key,
      {
        type: "pr-initialized",
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
        title: "Add widgets",
      },
      root,
    );
    writeRevision(key, 1, REV1_PATCH, files, { baseSha: "base1", headSha: "head1", mergeBase: "mb1" }, root);
    appendEvent(
      key,
      {
        type: "revision-added",
        revision: 1,
        baseSha: "base1",
        headSha: "head1",
        mergeBase: "mb1",
        baseOnly: false,
        files: toRevisionFiles(files),
      },
      root,
    );
    const res = await app.request(`/api/prs/${encodedKey}/analysis/export`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_analysis");
  });
});

describe("POST /api/prs/:key/analysis/import", () => {
  it("round-trips an export into a fresh copy of the same state", async () => {
    const { hunkIds } = buildFixture(root);
    const exportRes = await app.request(`/api/prs/${encodedKey}/analysis/export`);
    const envelope = await exportRes.json();

    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), "purview-analysis-share-importer-"));
    const importApp = createApp({ stateDir: importRoot, webDist: path.join(importRoot, "__no-web-dist__") });
    try {
      // Seed the importer with the same PR/revision but no analysis of its own.
      const { writeMeta, appendEvent, writeRevision, toRevisionFiles, parseDiff } = await import(
        "@reviewer/core"
      );
      const { REV1_PATCH } = await import("./fixtures.js");
      const files = parseDiff(REV1_PATCH);
      writeMeta(
        key,
        {
          host: key.host,
          owner: key.owner,
          repo: key.repo,
          number: key.number,
          url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
          title: "Add widgets",
          createdAt: new Date().toISOString(),
        },
        importRoot,
      );
      appendEvent(
        key,
        {
          type: "pr-initialized",
          host: key.host,
          owner: key.owner,
          repo: key.repo,
          number: key.number,
          url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
          title: "Add widgets",
        },
        importRoot,
      );
      writeRevision(
        key,
        1,
        REV1_PATCH,
        files,
        { baseSha: "base1", headSha: "head1", mergeBase: "mb1" },
        importRoot,
      );
      appendEvent(
        key,
        {
          type: "revision-added",
          revision: 1,
          baseSha: "base1",
          headSha: "head1",
          mergeBase: "mb1",
          baseOnly: false,
          files: toRevisionFiles(files),
        },
        importRoot,
      );

      const res = await importApp.request(`/api/prs/${encodedKey}/analysis/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.report).toEqual({
        unitsImported: 1,
        unitsDropped: 0,
        hunksMatched: hunkIds.length,
        hunksUnassigned: 0,
        sameRevision: true,
      });

      const state = loadState(key, importRoot);
      expect(state.units).toHaveLength(1);
      expect(state.units[0].id).toBe("unit-1");
      expect(state.analysisOrigin).toBe("import");
    } finally {
      fs.rmSync(importRoot, { recursive: true, force: true });
    }
  });

  it("rejects an envelope for a different PR", async () => {
    buildFixture(root);
    const exportRes = await app.request(`/api/prs/${encodedKey}/analysis/export`);
    const envelope = await exportRes.json();

    const otherKeyStr = `${key.host}/${key.owner}/other-repo/9`;
    const otherEncoded = encodeURIComponent(otherKeyStr);
    // Nothing needs to exist for "different PR" to be rejected before it ever
    // reads meta — the mismatch is checked against the *route's* key.
    const { writeMeta, appendEvent } = await import("@reviewer/core");
    writeMeta(
      { host: key.host, owner: key.owner, repo: "other-repo", number: 9 },
      {
        host: key.host,
        owner: key.owner,
        repo: "other-repo",
        number: 9,
        url: `https://${key.host}/${key.owner}/other-repo/pull/9`,
        createdAt: new Date().toISOString(),
      },
      root,
    );
    appendEvent(
      { host: key.host, owner: key.owner, repo: "other-repo", number: 9 },
      {
        type: "pr-initialized",
        host: key.host,
        owner: key.owner,
        repo: "other-repo",
        number: 9,
        url: `https://${key.host}/${key.owner}/other-repo/pull/9`,
      },
      root,
    );

    const res = await app.request(`/api/prs/${otherEncoded}/analysis/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("wrong_pr");
  });

  it("rejects a malformed envelope", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/analysis/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "an envelope" }),
    });
    expect(res.status).toBe(400);
  });

  it("409s while an analysis is queued/running for this PR", async () => {
    buildFixture(root);
    claude.restore();
    claude = fakeClaude({ hang: true, lines: scriptedRun() });
    claude.install();

    const analyzeRes = await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    expect(analyzeRes.status).toBe(200);

    const exportRes = await app.request(`/api/prs/${encodedKey}/analysis/export`);
    const envelope = await exportRes.json();
    const res = await app.request(`/api/prs/${encodedKey}/analysis/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("analysis_in_progress");

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "DELETE" });
    await analysisIdle();
  });
});
