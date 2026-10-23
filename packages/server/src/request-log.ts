import type { MiddlewareHandler } from "hono";
import { log } from "./log.js";

/** Only the path is logged: query strings can contain LAN tokens. */
export function requestLog(logger = log): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next(); // SSE returns its headers immediately, without awaiting the body.
    let path = c.req.path;
    try { path = decodeURIComponent(path); } catch { /* malformed URL */ }
    path = path.replace(/(\/api\/prs\/)(?:[^/]+\/)?([^/]+)\/([^/]+)\/(\d+)(?=\/|$)/, "$1$2/$3#$4");
    const status = c.res.status;
    const streaming = c.res.headers.get("content-type")?.includes("text/event-stream");
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) ? "info" : "debug";
    logger[level]("server", `${c.req.method} ${path}${streaming ? " · started" : ""}`, { status, duration: `${Math.round(performance.now() - started)}ms` });
  };
}
