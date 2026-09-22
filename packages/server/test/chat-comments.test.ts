import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { DEFAULT_SERVER_PORT, setGhRunner } from "@reviewer/core";
import { createApp, DEFAULT_PORT } from "../src/app.js";
import {
  DELETED_COMMENT_TTL_MS,
  readComments,
  readDeletedComments,
  writeComments,
} from "../src/comments.js";
import { chatToolFlags } from "../src/chat.js";
import { chatChildEnv } from "../src/chat-session.js";
import { analysisToolFlags } from "../src/analysis.js";
import { runClaude, setClaudeSpawner, type ClaudeChild } from "../src/claude-runner.js";
import { cliCommand } from "../src/skill-paths.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

const keyStr = `${key.host}/${key.owner}/${key.repo}/${key.number}`;
const encodedKey = encodeURIComponent(keyStr);
const cliPath = fileURLToPath(new URL("../../core/dist/cli.js", import.meta.url));
const execFileAsync = promisify(execFile);

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-chat-comments-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  gh = fakeGh();
  gh.install();
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const CHAT = { "X-Purview-Actor": "chat" };

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const commentsUrl = (rest = "") => `/api/prs/${encodedKey}/comments${rest}`;

async function create(body: string, headers: Record<string, string> = {}, line = 2) {
  const res = await req("POST", commentsUrl(), { file: "src/foo.ts", line, side: "RIGHT", body }, headers);
  expect(res.status).toBe(201);
  return (await res.json()).comment as { id: string; author?: string; status: string };
}

function setStatus(id: string, status: "pushed" | "submitted") {
  writeComments(
    key,
    readComments(key, root).map((c) =>
      c.id === id
        ? { ...c, status, githubCommentId: 1, ...(status === "submitted" ? { submittedAt: "2026-01-01T00:00:00Z" } : {}) }
        : c,
    ),
    root,
  );
}

/* ------------------------------------------------------------ attribution */

describe("comment author", () => {
  it("records the chat's drafts as Claude's and the reader's as yours", async () => {
    const mine = await create("reader draft");
    const claudes = await create("claude draft", CHAT);
    expect(mine.author).toBe("you");
    expect(claudes.author).toBe("claude");
    expect(claudes.status).toBe("draft");
  });

  it("reads comments written before authorship existed as the reader's (no author on disk)", () => {
    writeComments(
      key,
      [{ id: "old", file: "src/foo.ts", subjectType: "line", line: 2, side: "RIGHT", body: "x", createdAt: "t", status: "draft" }],
      root,
    );
    expect(readComments(key, root)[0].author).toBeUndefined();
  });

  it("refuses a CLI-created comment outside the current diff", async () => {
    const outside = await req("POST", commentsUrl(), { file: "src/foo.ts", line: 6, side: "RIGHT", body: "x" }, CHAT);
    expect(outside.status).toBe(422);
    expect((await outside.json()).error).toBe("comment_outside_diff");
    const noFile = await req("POST", commentsUrl(), { file: "src/nope.ts", body: "x" }, CHAT);
    expect(noFile.status).toBe(422);
  });
});

/* ------------------------------------------------------------------ guards */

describe("chat guards", () => {
  it("lets the chat edit and delete a draft — the reader's too (that rule is the prompt's)", async () => {
    const mine = await create("reader draft");
    const edit = await req("PATCH", commentsUrl(`/${mine.id}`), { body: "claude rewrote it" }, CHAT);
    expect(edit.status).toBe(200);
    expect((await edit.json()).comment.lastEditedBy).toBe("claude");
    const del = await req("DELETE", commentsUrl(`/${mine.id}`), undefined, CHAT);
    expect(del.status).toBe(200);
    expect((await del.json()).trashed).toBe(true);
  });

  for (const status of ["pushed", "submitted"] as const) {
    it(`refuses the chat editing or deleting a ${status} comment with 409`, async () => {
      const c = await create("reader draft");
      setStatus(c.id, status);
      const edit = await req("PATCH", commentsUrl(`/${c.id}`), { body: "nope", confirm: true }, CHAT);
      expect(edit.status).toBe(409);
      const body = await edit.json();
      expect(body.error).toBe("not_draft");
      expect(body.detail).toContain(status);
      const del = await req("DELETE", commentsUrl(`/${c.id}`), undefined, CHAT);
      expect(del.status).toBe(409);
      expect(readComments(key, root).find((x) => x.id === c.id)?.body).toBe("reader draft");
      expect(gh.deletedCommentIds).toEqual([]);
    });
  }

  it("confines the chat to the comment routes", async () => {
    const res = await req("POST", `/api/prs/${encodedKey}/sync`, undefined, CHAT);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden_actor");
    expect(gh.calls).toEqual([]);
  });

  it("serves CLI (actor-marked) requests on loopback only", async () => {
    const lanApp = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      port: 4779,
      lan: { token: "t0k", hosts: ["mybox.local"] },
    });
    const res = await lanApp.request(`http://mybox.local:4779${commentsUrl()}`, {
      headers: { ...CHAT, "x-purview-token": "t0k" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("loopback_only");
    // The same request without the actor header is an ordinary LAN client.
    const plain = await lanApp.request(`http://mybox.local:4779${commentsUrl()}`, {
      headers: { "x-purview-token": "t0k" },
    });
    expect(plain.status).toBe(200);
  });
});

/* -------------------------------------------------------------- undo edit */

describe("edit history and undo", () => {
  it("keeps previous bodies and undoes the latest edit", async () => {
    const c = await create("v1");
    await req("PATCH", commentsUrl(`/${c.id}`), { body: "v2" });
    await req("PATCH", commentsUrl(`/${c.id}`), { body: "v3" }, CHAT);
    let stored = readComments(key, root)[0];
    expect(stored.body).toBe("v3");
    expect(stored.lastEditedBy).toBe("claude");
    expect(stored.history?.map((h) => [h.body, h.replacedBy])).toEqual([
      ["v1", "you"],
      ["v2", "claude"],
    ]);

    const undo = await req("POST", commentsUrl(`/${c.id}/undo-edit`));
    expect(undo.status).toBe(200);
    stored = readComments(key, root)[0];
    expect(stored.body).toBe("v2");
    expect(stored.lastEditedBy).toBe("you");
    await req("POST", commentsUrl(`/${c.id}/undo-edit`));
    stored = readComments(key, root)[0];
    expect(stored.body).toBe("v1");
    expect(stored.lastEditedBy).toBeUndefined();
    expect(stored.history).toBeUndefined();
    const none = await req("POST", commentsUrl(`/${c.id}/undo-edit`));
    expect(none.status).toBe(409);
  });

  it("caps the history at five bodies", async () => {
    const c = await create("v0");
    for (let i = 1; i <= 7; i++) await req("PATCH", commentsUrl(`/${c.id}`), { body: `v${i}` }, CHAT);
    expect(readComments(key, root)[0].history?.map((h) => h.body)).toEqual(["v2", "v3", "v4", "v5", "v6"]);
  });

  it("does not undo a pushed comment's edit (its text also lives on GitHub)", async () => {
    const c = await create("v1");
    await req("PATCH", commentsUrl(`/${c.id}`), { body: "v2" }, CHAT);
    setStatus(c.id, "pushed");
    const res = await req("POST", commentsUrl(`/${c.id}/undo-edit`));
    expect(res.status).toBe(409);
  });
});

/* ------------------------------------------------------------ soft delete */

describe("deleted drafts (trash)", () => {
  it("hides a deleted draft from the list, keeps it restorable, and restores it", async () => {
    const c = await create("claude draft", CHAT);
    await req("DELETE", commentsUrl(`/${c.id}`), undefined, CHAT);

    const listed = await (await req("GET", commentsUrl())).json();
    expect(listed.comments).toEqual([]);
    expect(listed.deleted).toHaveLength(1);
    expect(listed.deleted[0]).toMatchObject({ id: c.id, deletedBy: "claude", body: "claude draft" });

    const restored = await req("POST", commentsUrl(`/${c.id}/restore`));
    expect(restored.status).toBe(200);
    const after = await (await req("GET", commentsUrl())).json();
    expect(after.comments.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect(after.comments[0]).toMatchObject({ status: "draft", author: "claude" });
    expect(after.deleted).toEqual([]);
    expect((await req("POST", commentsUrl(`/${c.id}/restore`))).status).toBe(404);
  });

  it("never pushes a deleted draft", async () => {
    await create("kept");
    const gone = await create("deleted by claude", CHAT, 11);
    await req("DELETE", commentsUrl(`/${gone.id}`), undefined, CHAT);
    const sync = await req("POST", `/api/prs/${encodedKey}/sync`);
    expect(sync.status).toBe(200);
    const payloads = gh.createReviewPayloads();
    expect(payloads).toHaveLength(1);
    const pushed = payloads[0].comments as { body: string }[];
    expect(pushed.map((p) => p.body)).toEqual(["kept"]);
    expect(readDeletedComments(key, root).map((d) => d.id)).toEqual([gone.id]);
  });

  it("forgets deleted drafts after the TTL", async () => {
    const c = await create("x");
    await req("DELETE", commentsUrl(`/${c.id}`));
    expect(readDeletedComments(key, root)).toHaveLength(1);
    expect(readDeletedComments(key, root, Date.now() + DELETED_COMMENT_TTL_MS + 1000)).toEqual([]);
    // the purge is persisted
    expect(readDeletedComments(key, root)).toEqual([]);
  });

  it("does not trash a pushed comment (it would come back as a duplicate)", async () => {
    const c = await create("x");
    setStatus(c.id, "pushed");
    const del = await req("DELETE", commentsUrl(`/${c.id}`));
    expect((await del.json()).trashed).toBe(false);
    expect(readDeletedComments(key, root)).toEqual([]);
  });
});

/* --------------------------------------------------------- permissions */

describe("tool permissions", () => {
  it("lets the chat run `comment` and keeps the analysis run off it", () => {
    const cmd = cliCommand();
    expect(chatToolFlags().allowedTools).toContain(`Bash(${cmd} comment:*)`);
    expect(chatToolFlags().disallowedTools).not.toContain(`Bash(${cmd} comment:*)`);
    const analysis = analysisToolFlags(path.join(root, "scratch"));
    expect(analysis.disallowedTools).toContain(`Bash(${cmd} comment:*)`);
    expect(analysis.allowedTools).not.toContain(`Bash(${cmd} comment:*)`);
  });

  it("marks the chat child as the chat actor and points it at this server", async () => {
    expect(chatChildEnv(5123)).toEqual({ PURVIEW_ACTOR: "chat", PURVIEW_PORT: "5123" });

    let seen: { cwd: string; env?: Record<string, string> } | undefined;
    setClaudeSpawner((_argv, opts) => {
      seen = opts;
      return {
        stdout: null,
        stderr: null,
        stdin: null,
        kill: () => true,
        on(event: string, listener: (arg: never) => void) {
          if (event === "exit") setTimeout(() => (listener as (c: number) => void)(0), 0);
          return this;
        },
      } as unknown as ClaudeChild;
    });
    try {
      const run = runClaude({ prompt: "hi", cwd: root, env: chatChildEnv(5123) });
      for await (const _ of run.events) void _;
    } finally {
      setClaudeSpawner(null);
    }
    expect(seen?.env).toEqual({ PURVIEW_ACTOR: "chat", PURVIEW_PORT: "5123" });
  });

  it("the CLI's default port is the server's", () => {
    expect(DEFAULT_SERVER_PORT).toBe(DEFAULT_PORT);
  });
});

/* ------------------------------------------------------- CLI round trip */

describe("reviewer-state comment (CLI -> server)", () => {
  let server: ServerType | undefined;
  let port = 0;

  async function listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: (r) => liveApp().fetch(r), port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        port = info.port;
        resolve();
      });
    });
  }
  // The guard validates Host against the port the app believes it serves on,
  // which is only known once the socket is bound.
  let appForPort: ReturnType<typeof createApp> | undefined;
  const liveApp = () =>
    (appForPort ??= createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__"), port }));

  afterEach(async () => {
    appForPort = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function cli(args: string[], env: Record<string, string> = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
        env: {
          ...process.env,
          PURVIEW_STATE_DIR: root,
          PURVIEW_PORT: String(port),
          PURVIEW_ACTOR: "chat",
          PURVIEW_SERVER_URL: "",
          ...env,
        },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("adds, lists, edits and deletes a draft as Claude", async () => {
    await listen();

    const add = await cli([
      "comment", "add", keyStr, "--file", "src/foo.ts", "--line", "2",
      "--body", "Why 'new2'? $HOME stays literal\nsecond line",
    ]);
    expect(add.code, add.stderr).toBe(0);
    const id = /Created draft comment (\S+) at src\/foo\.ts:2\./.exec(add.stdout)?.[1];
    expect(id).toBeTruthy();
    const stored = readComments(key, root)[0];
    expect(stored).toMatchObject({ id, author: "claude", status: "draft", line: 2, side: "RIGHT" });
    expect(stored.body).toBe("Why 'new2'? $HOME stays literal\nsecond line");

    const list = await cli(["comment", "list", keyStr]);
    expect(list.stdout).toContain(`${id}  draft     author=claude  src/foo.ts:2  Why 'new2'? $HOME stays literal`);

    const bodyFile = path.join(root, "body.md");
    fs.writeFileSync(bodyFile, "Edited from a file\n");
    const edit = await cli(["comment", "edit", keyStr, id!, "--body-file", bodyFile]);
    expect(edit.code, edit.stderr).toBe(0);
    expect(edit.stdout).toContain(`Edited draft comment ${id} at src/foo.ts:2.`);
    expect(readComments(key, root)[0].body).toBe("Edited from a file");

    const del = await cli(["comment", "delete", keyStr, id!]);
    expect(del.code, del.stderr).toBe(0);
    expect(del.stdout).toContain("can be restored");
    expect(readComments(key, root)).toEqual([]);
    expect(readDeletedComments(key, root)[0]).toMatchObject({ id, deletedBy: "claude" });
  });

  it("adds a file-level comment, and as the reader outside the chat", async () => {
    await listen();
    const add = await cli(["comment", "add", keyStr, "--file", "src/foo.ts", "--whole-file", "--body", "file note"], {
      PURVIEW_ACTOR: "",
    });
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).toContain("src/foo.ts (whole file)");
    expect(readComments(key, root)[0]).toMatchObject({ subjectType: "file", author: "you" });
  });

  it("reports the server's refusal for a pushed comment and exits non-zero", async () => {
    await listen();
    const c = await create("reader draft");
    setStatus(c.id, "pushed");
    const edit = await cli(["comment", "edit", keyStr, c.id, "--body", "x"]);
    expect(edit.code).toBe(1);
    expect(edit.stderr).toContain("Claude may only edit draft comments");
    expect(edit.stderr).toContain("409");
  });

  it("rejects bad flags before calling the server", async () => {
    await listen();
    const both = await cli(["comment", "add", keyStr, "--file", "src/foo.ts", "--line", "2", "--whole-file", "--body", "x"]);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("either --line or --whole-file");
    const none = await cli(["comment", "add", keyStr, "--file", "src/foo.ts", "--line", "2"]);
    expect(none.stderr).toContain("--body");
  });

  it("says plainly when the server is not running", async () => {
    // Bind and release a port so nothing is listening on it.
    await listen();
    const dead = port;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const res = await cli(["comment", "list", keyStr], { PURVIEW_PORT: String(dead) });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`Could not reach the Purview server at http://127.0.0.1:${dead}`);
  });
});
