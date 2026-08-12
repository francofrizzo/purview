import { describe, expect, it } from "vitest";
import { createSseParser, frameJson, readSseStream } from "./sse";
import { decodeChatFrame } from "../api/client";

const encode = (s: string) => new TextEncoder().encode(s);

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encode(c));
      controller.close();
    },
  });
}

describe("createSseParser", () => {
  it("emits a frame per blank-line-terminated block", () => {
    const parser = createSseParser();
    const frames = parser.push('event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n');
    expect(frames.map((f) => f.event)).toEqual(["delta", "done"]);
    expect(frames[0].data).toBe('{"text":"hi"}');
  });

  it("holds an incomplete frame until the rest arrives", () => {
    const parser = createSseParser();
    expect(parser.push("event: del")).toEqual([]);
    expect(parser.push("ta\ndata: {\"text\":\"a")).toEqual([]);
    const frames = parser.push('"}\n\n');
    expect(frames).toEqual([{ event: "delta", data: '{"text":"a"}' }]);
  });

  it("survives a CRLF split across two chunks", () => {
    const parser = createSseParser();
    expect(parser.push("data: one\r")).toEqual([]);
    const frames = parser.push("\n\r\n");
    expect(frames).toEqual([{ event: "message", data: "one" }]);
  });

  it("joins repeated data fields with newlines and defaults the event name", () => {
    const parser = createSseParser();
    const [frame] = parser.push("data: line one\ndata: line two\n\n");
    expect(frame).toEqual({ event: "message", data: "line one\nline two" });
  });

  it("ignores comment lines and keeps the frame that follows", () => {
    const parser = createSseParser();
    const frames = parser.push(": keep-alive\n\nevent: tool\ndata: {}\n\n");
    expect(frames.map((f) => f.event)).toEqual(["tool"]);
  });

  it("strips exactly one leading space after the colon", () => {
    const parser = createSseParser();
    const [a] = parser.push("data:  two spaces\n\n");
    expect(a.data).toBe(" two spaces");
    const [b] = parser.push("data:none\n\n");
    expect(b.data).toBe("none");
  });

  it("carries an id field", () => {
    const parser = createSseParser();
    const [frame] = parser.push("id: 7\nevent: delta\ndata: x\n\n");
    expect(frame.id).toBe("7");
  });

  it("flushes a frame the stream never terminated", () => {
    const parser = createSseParser();
    expect(parser.push("event: delta\ndata: tail")).toEqual([]);
    expect(parser.flush()).toEqual([{ event: "delta", data: "tail" }]);
  });

  it("flushes nothing when there is nothing pending", () => {
    const parser = createSseParser();
    parser.push("data: x\n\n");
    expect(parser.flush()).toEqual([]);
  });
});

describe("readSseStream", () => {
  it("decodes frames split at arbitrary byte boundaries", async () => {
    const wire = 'event: delta\ndata: {"text":"he"}\n\nevent: delta\ndata: {"text":"llo"}\n\n';
    const chunks: string[] = [];
    for (let i = 0; i < wire.length; i += 7) chunks.push(wire.slice(i, i + 7));

    const out: string[] = [];
    for await (const frame of readSseStream(streamOf(chunks))) {
      out.push(frameJson<{ text: string }>(frame)!.text);
    }
    expect(out.join("")).toBe("hello");
  });

  it("stops once the signal aborts", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const stream = streamOf(["data: a\n\n", "data: b\n\n"]);
    for await (const frame of readSseStream(stream, controller.signal)) {
      seen.push(frame.data);
      controller.abort();
    }
    expect(seen).toEqual(["a"]);
  });
});

describe("frameJson", () => {
  it("returns null for malformed or empty payloads instead of throwing", () => {
    expect(frameJson({ event: "delta", data: "{oops" })).toBeNull();
    expect(frameJson({ event: "delta", data: "" })).toBeNull();
  });
});

describe("decodeChatFrame", () => {
  it("maps each wire event onto the chat union", () => {
    expect(decodeChatFrame("delta", '{"text":"abc"}')).toEqual({ type: "delta", text: "abc" });
    expect(decodeChatFrame("tool", '{"name":"read","detail":"a.go"}')).toEqual({
      type: "tool",
      name: "read",
      detail: "a.go",
    });
    expect(decodeChatFrame("error", '{"error":"boom"}')).toEqual({ type: "error", error: "boom" });
  });

  it("keeps a done frame's message and defaults its role", () => {
    const event = decodeChatFrame("done", '{"message":{"text":"final","ts":"t"}}');
    expect(event).toEqual({
      type: "done",
      message: { text: "final", ts: "t", role: "assistant" },
    });
  });

  it("drops frames that are unknown or missing their payload", () => {
    expect(decodeChatFrame("delta", "{}")).toBeNull();
    expect(decodeChatFrame("tool", '{"detail":"no name"}')).toBeNull();
    expect(decodeChatFrame("done", "{}")).toBeNull();
    expect(decodeChatFrame("heartbeat", "{}")).toBeNull();
  });

  it("falls back to a generic message for an error frame with no text", () => {
    expect(decodeChatFrame("error", "{}")).toEqual({
      type: "error",
      error: "The chat stream failed",
    });
  });
});
