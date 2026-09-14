import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyToString, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { readComments } from "../src/comments.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

const encodedKey = encodeURIComponent(keyToString(key));

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;
let gh: FakeGh;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-reanchor-route-test-"));
  gh = fakeGh();
  gh.install();
  claude = fakeClaude();
  claude.install();
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
});

afterEach(() => {
  claude.restore();
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function addDraft(body: string, line: number, file = "src/foo.ts") {
  const res = await app.request(`/api/prs/${encodedKey}/comments`, {
    ...json({ file, line, side: "RIGHT", body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).comment as { id: string };
}

const reanchor = (id: string) =>
  app.request(`/api/prs/${encodedKey}/comments/${id}/reanchor`, { method: "POST" });

describe("POST /api/prs/:key/comments/:id/reanchor", () => {
  it("returns an applicable proposal validated against the current diff", async () => {
    buildFixture(root);
    // Line 999 is nowhere in the fixture's diff, so this draft needs help.
    const draft = await addDraft("still valid?", 999);
    claude = fakeClaude({
      lines: scriptedRun({
        text: JSON.stringify({
          applicable: true,
          file: "src/foo.ts",
          line: 11,
          side: "RIGHT",
          reason: "Same concern, now at the renumbered line.",
        }),
      }),
    });
    claude.install();

    const res = await reanchor(draft.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.proposal).toMatchObject({
      applicable: true,
      file: "src/foo.ts",
      line: 11,
      side: "RIGHT",
    });
    // Nothing was applied — the draft's own line is untouched.
    expect(readComments(key, root)[0].line).toBe(999);
  });

  it("rejects a model proposal that lands outside the current diff, never trusting it blindly", async () => {
    buildFixture(root);
    const draft = await addDraft("still valid?", 999);
    claude = fakeClaude({
      lines: scriptedRun({
        text: JSON.stringify({ applicable: true, file: "src/foo.ts", line: 4321, side: "RIGHT" }),
      }),
    });
    claude.install();

    const res = await reanchor(draft.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.proposal.applicable).toBe(false);
    expect(body.proposal.reason).toMatch(/not part of the current diff/);
  });

  it("passes through a model's applicable:false verdict", async () => {
    buildFixture(root);
    const draft = await addDraft("still valid?", 999);
    claude = fakeClaude({
      lines: scriptedRun({
        text: JSON.stringify({ applicable: false, reason: "The code this discussed is gone." }),
      }),
    });
    claude.install();

    const res = await reanchor(draft.id);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.proposal).toEqual({
      applicable: false,
      reason: "The code this discussed is gone.",
    });
  });

  it("reports a clean failure when the claude run errors", async () => {
    buildFixture(root);
    const draft = await addDraft("still valid?", 999);
    claude = fakeClaude({ exitCode: 1, lines: scriptedRun({ isError: true }) });
    claude.install();

    const res = await reanchor(draft.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBeTruthy();
  });

  it("400s for a pushed comment (only drafts are reanchorable)", async () => {
    buildFixture(root);
    const draft = await addDraft("first", 2);
    await app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" });

    const res = await reanchor(draft.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_reanchorable");
  });

  it("400s for a file-level comment", async () => {
    buildFixture(root);
    const res0 = await app.request(`/api/prs/${encodedKey}/comments`, {
      ...json({ file: "src/foo.ts", body: "whole file" }),
    });
    const draft = (await res0.json()).comment as { id: string };

    const res = await reanchor(draft.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_reanchorable");
  });

  it("404s an unknown comment id", async () => {
    buildFixture(root);
    const res = await reanchor("nope");
    expect(res.status).toBe(404);
  });
});
