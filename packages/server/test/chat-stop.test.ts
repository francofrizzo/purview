/**
 * POST /chat/stop: kill the turn's agent child and keep the reply so far as an
 * `interrupted` message. The child is a real process (fake-claude-child.mjs
 * with FAKE_CLAUDE_HANG), so the signal, the exit and the stream's end are
 * all genuine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyToString, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { chatBusy, chatTurnDone } from "../src/chat-session.js";
import { readChat, replayTranscript, INTERRUPTED_NOTE } from "../src/chat.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeClaude, type FakeClaude } from "./fake-claude.js";

const PORT = 4779;
const SESSION = "0f8c2b1e-5d4a-4c3b-9a1f-2e7d6c5b4a39";
const encodedKey = encodeURIComponent(keyToString(key));

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;

const delta = (text: string) => ({
  type: "stream_event",
  session_id: SESSION,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const init = { type: "system", subtype: "init", session_id: SESSION, tools: ["Read"] };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-chat-stop-test-"));
  process.env.REVIEWER_SKILL_DIR = path.join(root, "skills");
  process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
  fs.mkdirSync(process.env.REVIEWER_SKILL_DIR, { recursive: true });
  setGhRunner(() => "{}");
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__"), port: PORT });
});

afterEach(async () => {
  claude?.killAll();
  await chatTurnDone(key);
  claude?.restore();
  setGhRunner(null);
  delete process.env.REVIEWER_SKILL_DIR;
  delete process.env.REVIEWER_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

const send = (text = "what is risky?") =>
  app.request(`/api/prs/${encodedKey}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

const stop = () => app.request(`/api/prs/${encodedKey}/chat/stop`, { method: "POST" });

/** Read SSE text off the response until `predicate` holds, then keep draining to the end. */
async function readUntil(res: Response, predicate: (text: string) => boolean) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let armed: (() => void) | null = null;
  const seen = new Promise<void>((resolve) => {
    armed = resolve;
  });
  const rest = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) armed?.();
    }
    armed?.();
  })();
  return { seen, rest, text: () => text };
}

describe("POST /chat/stop", () => {
  it("409s chat_idle when nothing is running", async () => {
    const res = await stop();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("chat_idle");
  });

  it("kills the child, keeps the streamed text as an interrupted reply, and frees the slot", async () => {
    claude = fakeClaude({ lines: [init, delta("The rounding "), delta("change is")], hang: true });
    claude.install();

    const res = await send();
    expect(res.status).toBe(200);
    const stream = await readUntil(res, (t) => t.includes("change is"));
    await stream.seen;
    expect(chatBusy(key)).toBe(true);

    const stopped = await stop();
    expect(stopped.status).toBe(200);
    const body = await stopped.json();
    expect(body.ok).toBe(true);
    expect(body.message).toMatchObject({ role: "assistant", text: "The rounding change is", interrupted: true });

    // The slot is free the moment the stop answers.
    expect(chatBusy(key)).toBe(false);

    // The SSE stream ended cleanly with the same `done` and no `error`.
    await stream.rest;
    const sse = stream.text();
    expect(sse).toContain("event: done");
    expect(sse).toContain('"interrupted":true');
    expect(sse).not.toContain("event: error");

    const chat = readChat(key, root);
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[1]).toMatchObject({ role: "assistant", text: "The rounding change is", interrupted: true });
    // The session survives: the harness's own transcript holds the partial turn.
    expect(chat.session?.id).toBe(SESSION);
    expect((await (await app.request(`/api/prs/${encodedKey}/chat`)).json()).busy).toBe(false);

    // Ready for the next message right away.
    const again = await send("and now?");
    expect(again.status).toBe(200);
    expect(claude.runs).toHaveLength(2);
    await again.body?.cancel();
  });

  it("keeps a completed block plus the block in progress", async () => {
    claude = fakeClaude({
      lines: [
        init,
        { type: "assistant", session_id: SESSION, message: { content: [{ type: "text", text: "First block." }] } },
        delta("Second, unfinished"),
      ],
      hang: true,
    });
    claude.install();
    const res = await send();
    const stream = await readUntil(res, (t) => t.includes("unfinished"));
    await stream.seen;
    const body = await (await stop()).json();
    expect(body.message.text).toBe("First block.\nSecond, unfinished");
    await stream.rest;
  });

  it("persists an empty interrupted reply when nothing had streamed yet", async () => {
    claude = fakeClaude({ lines: [init], hang: true });
    claude.install();
    const res = await send();
    // Nothing reaches the stream before the stop, so wait for the spawn
    // itself (the checkout resolves first), then a beat for the child to be up.
    const stream = await readUntil(res, () => false);
    for (let i = 0; i < 200 && !claude.runs.length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    const body = await (await stop()).json();
    expect(body.message).toMatchObject({ role: "assistant", text: "", interrupted: true });
    await stream.rest;
    expect(readChat(key, root).messages).toHaveLength(2);
  });

  it("marks the stop in the replayed transcript", () => {
    const replay = replayTranscript([
      { role: "user", text: "q", ts: "t1" },
      { role: "assistant", text: "half an", ts: "t2", interrupted: true },
    ]);
    expect(replay).toContain(`Assistant: half an\n${INTERRUPTED_NOTE}`);
  });
});
