import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReviewOperations } from "./operations.js";
import type { AgentAction, AgentOperationResult, AgentRunRequest } from "../types.js";

// Codex 0.163.0 silently drops schemas with draft-7 tuple items arrays.
// Publish equivalent homogeneous fixed pairs; execution uses the core schema.
function wireSchema(value: unknown): any {
  if (Array.isArray(value)) return value.map(wireSchema);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, v]) => [key, wireSchema(v)]));
  if (Array.isArray(result.items)) {
    if (result.minItems !== result.items.length || result.maxItems !== result.items.length ||
      !result.items.every(item => JSON.stringify(item) === JSON.stringify(result.items[0]))) throw new Error("Unsupported tuple schema");
    result.items = result.items[0];
  }
  return result;
}

/** A live, per-run capability, not an API on the public Purview server. */
export async function startReviewTools(request: AgentRunRequest, harness: string, onAction?: (action: AgentAction) => void,
  onResult?: (result: AgentOperationResult) => void) {
  const operations = createReviewOperations(request, harness, onAction);
  const endpoint = `/mcp/${randomBytes(32).toString("hex")}`;
  const transports = new Set<StreamableHTTPServerTransport>();
  let active = true;
  const server = createServer(async (req, res) => {
    if (!active || req.url !== endpoint || req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(404).end(); return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const mcp = new Server({ name: "purview", version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transports.add(transport);
    res.on("close", () => { transports.delete(transport); void transport.close(); void mcp.close(); });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: operations.tools.map(tool => ({
      name: tool.name, description: tool.description, inputSchema: wireSchema(toJsonSchemaCompat(tool.schema)),
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly },
    })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async call => {
      const started = performance.now();
      // An unknown tool name is model input too; do not copy it into telemetry.
      const name = operations.tools.some(tool => tool.name === call.params.name) ? call.params.name : "unknown";
      let code: string | undefined;
      try {
        const result = await operations.execute(call.params.name, call.params.arguments);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
      } catch (error) {
        const e = error as { code?: string; reviewOperation?: boolean; issues?: unknown; message?: string };
        // Validation and deliberate denials are useful to repair a payload.
        // Unexpected filesystem/transport errors must not reveal host paths.
        const detail = e.reviewOperation ? e.message : e.issues ? JSON.stringify(e.issues) : "Operation failed; do not claim it succeeded.";
        code = e.reviewOperation && e.code ? e.code : "invalid_operation";
        return { content: [{ type: "text", text: JSON.stringify({ error: code, detail }) }], isError: true };
      } finally {
        onResult?.({ name, ok: code === undefined, ...(code ? { code } : {}), durationMs: Math.round(performance.now() - started) });
      }
    });
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end(); else res.end(); }
  });
  let port = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as { port: number }).port;
  } catch (error) { operations.revoke(); server.close(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}${endpoint}`,
    names: operations.tools.map(t => t.name),
    close() {
      active = false;
      operations.revoke();
      return closing ??= (async () => {
        await operations.drain();
        await Promise.all([...transports].map(t => t.close()));
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      })();
    },
  };
}
