import { describe, expect, it } from "vitest";
import { actorHeaders, formatCommentList, newCommentPayload, parseAudience, type ServerComment } from "../src/comment-client.js";

describe("actorHeaders", () => {
  it("names the chat's harness only when the CLI runs as the chat", () => {
    expect(actorHeaders({ PURVIEW_ACTOR: "chat", PURVIEW_AGENT: "claude-code" })).toEqual({
      "X-Purview-Actor": "chat",
      "X-Purview-Agent": "claude-code",
    });
    expect(actorHeaders({ PURVIEW_ACTOR: "chat" })).toEqual({ "X-Purview-Actor": "chat" });
    expect(actorHeaders({ PURVIEW_AGENT: "claude-code" })).toEqual({ "X-Purview-Actor": "you" });
  });
});

describe("formatCommentList", () => {
  const base: ServerComment = { id: "c1", file: "a.ts", subjectType: "line", line: 3, body: "hi", status: "draft", audience: "github" };

  it("shows any agent as author=agent, whatever its harness", () => {
    expect(formatCommentList([{ ...base, author: { agent: "claude-code" } }])).toBe(
      "c1  draft     for=github author=agent  a.ts:3  hi\n",
    );
    expect(
      formatCommentList([{ ...base, author: "you", lastEditedBy: { agent: "other" } }]),
    ).toBe("c1  draft     for=github author=you edited-by=agent  a.ts:3  hi\n");
    // Same actor twice is not an edit worth mentioning.
    expect(
      formatCommentList([{ ...base, author: { agent: "a" }, lastEditedBy: { agent: "a" } }]),
    ).toBe("c1  draft     for=github author=agent  a.ts:3  hi\n");
  });
});

describe("multi-line comments", () => {
  it("prints the range as path:start–line", async () => {
    const { commentLocation, newCommentPayload } = await import("../src/comment-client.js");
    expect(commentLocation({ file: "a.ts", subjectType: "line", line: 18, startLine: 12 })).toBe("a.ts:12–18");
    expect(commentLocation({ file: "a.ts", subjectType: "line", line: 18, startLine: 12, side: "LEFT" })).toBe(
      "a.ts:12–18 (old side)",
    );
    expect(commentLocation({ file: "a.ts", subjectType: "line", line: 18 })).toBe("a.ts:18");
    expect(newCommentPayload({ file: "a.ts", line: "18", startLine: "12" })).toEqual({
      file: "a.ts",
      subjectType: "line",
      line: 18,
      side: "RIGHT",
      startLine: 12,
    });
    // A one-line range is a line comment.
    expect(newCommentPayload({ file: "a.ts", line: "18", startLine: "18" })).toEqual({
      file: "a.ts",
      subjectType: "line",
      line: 18,
      side: "RIGHT",
    });
    expect(() => newCommentPayload({ file: "a.ts", line: "18", startLine: "20" })).toThrow(/must not come after/);
    expect(() => newCommentPayload({ file: "a.ts", wholeFile: true, startLine: "2" })).toThrow(/--start-line/);
  });
});

describe("audience (--for)", () => {
  const base: ServerComment = { id: "c1", file: "a.ts", subjectType: "line", line: 3, body: "hi", status: "draft", audience: "github" };
  it("prints who a comment is for, and an older server's comments as github", () => {
    expect(formatCommentList([{ ...base, audience: "agent" }])).toBe("c1  draft     for=agent  author=you  a.ts:3  hi\n");
    expect(formatCommentList([{ ...base, audience: undefined as unknown as "github" }])).toContain("for=github");
  });

  it("validates --for into the payload's audience", () => {
    expect(parseAudience(undefined)).toBeUndefined();
    expect(parseAudience(" Agent ")).toBe("agent");
    expect(() => parseAudience("me")).toThrow(/github or agent/);
    expect(newCommentPayload({ file: "a.ts", line: "3" })).not.toHaveProperty("audience");
    expect(newCommentPayload({ file: "a.ts", line: "3", for: "agent" })).toMatchObject({ audience: "agent" });
    expect(newCommentPayload({ file: "a.ts", wholeFile: true, for: "github" })).toEqual({ file: "a.ts", subjectType: "file", audience: "github" });
  });
});
