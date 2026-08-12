/**
 * A minimal `text/event-stream` reader.
 *
 * The browser's own EventSource cannot be used for the chat endpoint (that is a
 * POST with a JSON body), so the frames are parsed here instead. The parser is
 * deliberately incremental and independent of the transport: it takes whatever
 * text arrived and returns the frames that are *complete*, holding the rest —
 * a chunk boundary can fall anywhere, including inside a field name or between
 * the \r and the \n of a CRLF line ending.
 */

export interface SseFrame {
  /** the `event:` field, defaulting to "message" as the spec requires */
  event: string;
  /** `data:` lines, newline-joined (each frame's trailing newline dropped) */
  data: string;
  id?: string;
}

export interface SseParser {
  /** Feed decoded text; returns every frame that completed with this chunk. */
  push(chunk: string): SseFrame[];
  /** Flush a frame left unterminated by a stream that ended without a blank line. */
  flush(): SseFrame[];
}

export function createSseParser(): SseParser {
  // Buffer of not-yet-complete input, plus the fields of the frame in progress.
  let buffer = "";
  let event: string | null = null;
  let id: string | undefined;
  let data: string[] = [];
  let sawField = false;

  const takeFrame = (): SseFrame | null => {
    if (!sawField) return null;
    const frame: SseFrame = { event: event ?? "message", data: data.join("\n"), ...(id ? { id } : {}) };
    event = null;
    id = undefined;
    data = [];
    sawField = false;
    return frame;
  };

  const handleLine = (line: string, out: SseFrame[]) => {
    if (line === "") {
      const frame = takeFrame();
      if (frame) out.push(frame);
      return;
    }
    // A leading colon marks a comment (servers send them as keep-alives).
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Exactly one optional leading space after the colon is part of the syntax.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") {
      data.push(value);
      sawField = true;
    } else if (field === "event") {
      event = value;
      sawField = true;
    } else if (field === "id") {
      id = value;
      sawField = true;
    }
    // `retry` and unknown fields are irrelevant here.
  };

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const out: SseFrame[] = [];
      // Split on any of \r\n, \n, \r — but never consume a trailing lone \r,
      // which may be the first half of a CRLF split across two chunks.
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        handleLine(buffer.slice(0, match.index), out);
        buffer = buffer.slice(match.index + match[0].length);
      }
      return out;
    },
    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (buffer) {
        handleLine(buffer, out);
        buffer = "";
      }
      const frame = takeFrame();
      if (frame) out.push(frame);
      return out;
    },
  };
}

/** Read a byte stream as SSE frames. */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame;
      if (signal?.aborted) return;
    }
    for (const frame of parser.push(decoder.decode())) yield frame;
    for (const frame of parser.flush()) yield frame;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
}

/** `JSON.parse` that never throws — a malformed frame is skipped, not fatal. */
export function frameJson<T>(frame: SseFrame): T | null {
  if (!frame.data) return null;
  try {
    return JSON.parse(frame.data) as T;
  } catch {
    return null;
  }
}
