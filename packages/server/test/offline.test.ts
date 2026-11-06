import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetGithubOffline } from "@reviewer/core";
import { createApp, GITHUB_OFFLINE_HEADER } from "../src/app.js";
import { buildFixture, key } from "./fixtures.js";

/** A `gh` that can't connect, as on a machine with no network. */
let root: string;
let savedPath: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-offline-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'error connecting to api.github.com' >&2\nexit 1\n", { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  resetGithubOffline();
});
afterEach(() => {
  process.env.PATH = savedPath;
  resetGithubOffline();
  fs.rmSync(root, { recursive: true, force: true });
});

it("offline, what needs GitHub answers 503 github_offline, notes still save, and every answer says GitHub is offline", async () => {
  buildFixture(root);
  const app = createApp({ stateDir: root, webDist: path.join(root, "no-web"), autoAnalyze: false });
  const url = `/api/prs/${encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`)}`;

  expect((await app.request(url)).headers.get(GITHUB_OFFLINE_HEADER)).toBeNull();
  const refresh = await app.request(`${url}/refresh`, { method: "POST" });
  expect(refresh.status).toBe(503);
  expect(((await refresh.json()) as { error: string }).error).toBe("github_offline");

  const note = await app.request(`${url}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "src/a.ts", subjectType: "file", body: "on a plane", audience: "agent" }),
  });
  expect(note.status).toBe(201);
  expect(note.headers.get(GITHUB_OFFLINE_HEADER)).toMatch(/^\d{4}-/);
});
