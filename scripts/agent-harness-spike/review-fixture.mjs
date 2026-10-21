import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// A disposable stand-in for the proposed Purview authorization boundary, NOT
// the production services. Both real harnesses use this very same MCP server.
const statePath = process.argv[2];
const server = new McpServer({ name: "purview-spike", version: "0.0.0" });
const result = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }], isError,
});

server.registerTool("read_review", {
  description: "Read the review bound to this run",
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => {
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (!state.active) return result({ error: "revoked" }, true);
  return result({ pr: state.pr, revision: state.revision });
});

server.registerTool("edit_draft", {
  description: "Edit a draft in the review bound to this run",
  inputSchema: { commentId: z.string(), revision: z.number().int(), body: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ commentId, revision, body }) => {
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const comment = state.comments[commentId];
  let error;
  if (!state.active) error = "revoked";
  else if (state.task !== "chat") error = "operation_not_granted";
  else if (revision !== state.revision) error = "stale_revision";
  else if (!comment || comment.pr !== state.pr) error = "outside_review";
  else if (comment.status !== "draft") error = "not_draft";
  if (error) return result({ error }, true);
  comment.body = body;
  await fs.writeFile(statePath, JSON.stringify(state));
  return result({ updated: commentId, body });
});

await server.connect(new StdioServerTransport());
