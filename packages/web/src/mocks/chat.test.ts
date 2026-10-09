/**
 * The mock backend's edit/rewind endpoints have to keep `chats[key]` (its
 * in-memory chat.json stand-in) consistent the same way the server does:
 * rewind truncates in place, edit truncates then resends. Exercised directly
 * against `mockApi` rather than through a component, same as models.test.ts.
 *
 * A full canned-reply stream plays out chunk-by-chunk with simulated typing
 * delay, so each `streamChat`/`streamEditChat` drain takes real seconds —
 * tests that need more than one are given a longer timeout.
 */
import { describe, expect, it } from "vitest";
import { decodeChatFrame } from "../api/client";
import { readSseStream } from "../lib/sse";
import { mockApi } from "./server";
import type { ChatStreamEvent } from "../api/types";

/** The mock's `chats` store is module-level; each test gets its own PR key so they can't see each other's history. */
let n = 0;
const nextKey = () => `github.com/acme/widgets/${++n}`;

async function drain(stream: ReadableStream<Uint8Array>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const frame of readSseStream(stream)) {
    const event = decodeChatFrame(frame.event, frame.data);
    if (event) events.push(event);
  }
  return events;
}

describe("mock chat rewind", () => {
  it(
    "truncates the transcript and reports how many messages it removed",
    async () => {
      const key = nextKey();
      await drain(mockApi.streamChat(key, { text: "one" }));
      await drain(mockApi.streamChat(key, { text: "two" }));
      const before = (await mockApi.getChat(key)).messages;
      expect(before).toHaveLength(4); // 2 user + 2 assistant

      const result = await mockApi.rewindChat(key, 1);
      expect(result.sessionId).toBeNull();
      expect(result.removed).toBe(3);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({ role: "user", text: "one" });

      const after = await mockApi.getChat(key);
      expect(after.messages).toHaveLength(1);
    },
    20_000,
  );

  it("rejects an out-of-range index", async () => {
    const key = nextKey();
    await drain(mockApi.streamChat(key, { text: "hello" }));
    await expect(mockApi.rewindChat(key, 99)).rejects.toThrow();
  }, 20_000);
});

describe("mock chat edit", () => {
  it(
    "truncates to the edited message and resends it, keeping earlier history",
    async () => {
      const key = nextKey();
      await drain(mockApi.streamChat(key, { text: "first" }));
      await drain(mockApi.streamChat(key, { text: "second" }));
      const seeded = (await mockApi.getChat(key)).messages;
      expect(seeded).toHaveLength(4);

      const events = await drain(mockApi.streamEditChat(key, { index: 2, text: "second, edited" }));
      expect(events.some((e) => e.type === "done")).toBe(true);

      const after = await mockApi.getChat(key);
      expect(after.messages).toHaveLength(4); // first, reply, second-edited, reply
      expect(after.messages[0]).toMatchObject({ role: "user", text: "first" });
      expect(after.messages[2]).toMatchObject({ role: "user", text: "second, edited" });
    },
    30_000,
  );

  it("rejects editing a non-user message", () => {
    const key = nextKey();
    expect(() => mockApi.streamEditChat(key, { index: 999, text: "x" })).toThrow();
  });
});

describe("mock chat stop", () => {
  it("ends the stream with an interrupted `done` carrying the text so far, and persists it", async () => {
    const key = nextKey();
    const stream = mockApi.streamChat(key, { text: "hello" });
    const drained = drain(stream);
    await new Promise((r) => setTimeout(r, 1400));
    const result = await mockApi.stopChat(key);
    expect(result.message.interrupted).toBe(true);
    const events = await drained;
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" && done.message.interrupted).toBe(true);
    const text = events.filter((e) => e.type === "delta").map((e) => (e.type === "delta" ? e.text : "")).join("");
    expect(done && done.type === "done" ? done.message.text : "").toBe(text);
    const after = await mockApi.getChat(key);
    expect(after.messages).toHaveLength(2);
    expect(after.messages[1]).toMatchObject({ role: "assistant", interrupted: true });
  }, 20_000);

  it("409s chat_idle when nothing is streaming", async () => {
    await expect(mockApi.stopChat(nextKey())).rejects.toMatchObject({ status: 409 });
  });
});
