import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReviewOperations } from "./eval-operations.mjs";

function wireSchema(value) {
  if (Array.isArray(value)) return value.map(wireSchema);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, v]) => [key, wireSchema(v)]));
  if (Array.isArray(result.items)) {
    // Core's line ranges are fixed homogeneous pairs. Codex drops a whole
    // tool when draft-7 tuple `items` is an array. This equivalent spelling
    // works for both harnesses; execution still parses the original Zod schema.
    if (result.minItems !== result.items.length || result.maxItems !== result.items.length ||
      !result.items.every(item => JSON.stringify(item) === JSON.stringify(result.items[0]))) throw new Error("Unsupported tuple schema");
    result.items = result.items[0];
  }
  return result;
}

// Only the runner writes this context, outside the model's filesystem grants.
const contextFile = process.argv[2];
const context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
const operations = createReviewOperations({ ...context, isActive: () => fs.existsSync(contextFile) });
const server = new Server({ name: "purview-eval", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: operations.tools.map(tool => ({ name: tool.name,
    description: tool.description, inputSchema: wireSchema(toJsonSchemaCompat(tool.schema)),
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name;
  let value;
  let isError = false;
  try { value = await operations.execute(name, request.params.arguments); }
  catch (error) {
    isError = true;
    value = { error: error.code ?? "invalid_operation", detail: error.message };
  }
  // Synthetic operation data only, never model/backend/auth errors.
  fs.appendFileSync(context.auditPath, JSON.stringify({ name, ok: !isError,
    ...(isError ? { code: value.error } : {}), chars: JSON.stringify(value).length }) + "\n", { mode: 0o600 });
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
});
await server.connect(new StdioServerTransport());
