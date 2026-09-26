import { describe, expect, it } from "vitest";
import { actorHeaders, formatCommentList, type ServerComment } from "../src/comment-client.js";

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
  const base: ServerComment = { id: "c1", file: "a.ts", subjectType: "line", line: 3, body: "hi", status: "draft" };

  it("shows any agent as author=agent, whatever its harness", () => {
    expect(formatCommentList([{ ...base, author: { agent: "claude-code" } }])).toBe(
      "c1  draft     author=agent  a.ts:3  hi\n",
    );
    expect(
      formatCommentList([{ ...base, author: "you", lastEditedBy: { agent: "other" } }]),
    ).toBe("c1  draft     author=you edited-by=agent  a.ts:3  hi\n");
    // Same actor twice is not an edit worth mentioning.
    expect(
      formatCommentList([{ ...base, author: { agent: "a" }, lastEditedBy: { agent: "a" } }]),
    ).toBe("c1  draft     author=agent  a.ts:3  hi\n");
  });
});
