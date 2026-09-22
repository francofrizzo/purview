import { keyToString, type PrKey } from "./paths.js";

/**
 * The reviewer-state CLI's side of the draft-comment commands. Comments live
 * in the PR's comments.json, which the running Purview server owns; the CLI
 * never writes that file itself (two writers would race), it asks the server
 * over loopback HTTP instead. Everything here is pure except `callServer`.
 */

/**
 * The server's default port. Mirrors `DEFAULT_PORT` in the server's app.ts
 * (core cannot import the server); a server test pins the two together.
 */
export const DEFAULT_SERVER_PORT = 4779;

/** Header the server reads the actor from (see `actorOf` in the server's app.ts). */
export const ACTOR_HEADER = "X-Purview-Actor";

/**
 * Where the running server is: PURVIEW_SERVER_URL wins outright, else loopback
 * on the port the server itself resolves (PURVIEW_PORT / REVIEWER_PORT /
 * default). The chat's child process gets PURVIEW_PORT from the server.
 */
export function serverBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PURVIEW_SERVER_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number(env.PURVIEW_PORT ?? env.REVIEWER_PORT ?? DEFAULT_SERVER_PORT);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : DEFAULT_SERVER_PORT}`;
}

/** `chat` when this CLI runs inside Purview's review chat, `you` otherwise. */
export function actorHeaderValue(env: NodeJS.ProcessEnv = process.env): "chat" | "you" {
  return env.PURVIEW_ACTOR?.trim().toLowerCase() === "chat" ? "chat" : "you";
}

export function commentsUrl(base: string, key: PrKey, rest = ""): string {
  return `${base}/api/prs/${encodeURIComponent(keyToString(key))}/comments${rest}`;
}

/** The subset of the server's comment shape the CLI prints. */
export interface ServerComment {
  id: string;
  file: string;
  subjectType: "line" | "file";
  line?: number;
  side?: "LEFT" | "RIGHT";
  body: string;
  status: "draft" | "pushed" | "submitted";
  author?: "you" | "claude";
  lastEditedBy?: "you" | "claude";
}

/** `path:line`, `path:line (old side)`, or `path (whole file)`. */
export function commentLocation(c: Pick<ServerComment, "file" | "subjectType" | "line" | "side">): string {
  if (c.subjectType === "file" || c.line === undefined) return `${c.file} (whole file)`;
  return `${c.file}:${c.line}${c.side === "LEFT" ? " (old side)" : ""}`;
}

function firstLine(body: string, max = 80): string {
  const line = body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** One line per comment: id, status, author, location, first line of the body. */
export function formatCommentList(comments: ServerComment[]): string {
  if (comments.length === 0) return "No comments on this PR.\n";
  return (
    comments
      .map((c) => {
        const author = c.author ?? "you";
        const edited = c.lastEditedBy && c.lastEditedBy !== author ? ` edited-by=${c.lastEditedBy}` : "";
        return `${c.id}  ${c.status.padEnd(9)} author=${author}${edited}  ${commentLocation(c)}  ${firstLine(c.body)}`;
      })
      .join("\n") + "\n"
  );
}

export interface NewCommentArgs {
  file: string;
  line?: string;
  side?: string;
  wholeFile?: boolean;
}

/** Validate `comment add`'s anchoring flags into the server's create body (minus `body`). */
export function newCommentPayload(args: NewCommentArgs): {
  file: string;
  subjectType: "line" | "file";
  line?: number;
  side?: "LEFT" | "RIGHT";
} {
  const file = args.file.replace(/^\.\//, "");
  if (!file) throw new Error("--file is required");
  if (args.wholeFile) {
    if (args.line !== undefined) throw new Error("Pass either --line or --whole-file, not both");
    if (args.side !== undefined) throw new Error("--side only applies to line comments");
    return { file, subjectType: "file" };
  }
  if (args.line === undefined) throw new Error("Pass --line <n> (or --whole-file for a file-level comment)");
  const line = Number(args.line);
  if (!Number.isInteger(line) || line < 1) throw new Error(`Invalid --line "${args.line}"`);
  const side = (args.side ?? "RIGHT").toUpperCase();
  if (side !== "RIGHT" && side !== "LEFT") throw new Error(`--side must be RIGHT or LEFT, not "${args.side}"`);
  return { file, subjectType: "line", line, side };
}

/** Exactly one of --body / --body-file; the body must not be blank. */
export function resolveBody(
  opts: { body?: string; bodyFile?: string },
  readFile: (file: string) => string,
): string {
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    throw new Error("Pass either --body or --body-file, not both");
  }
  const body = opts.body ?? (opts.bodyFile !== undefined ? readFile(opts.bodyFile) : undefined);
  if (body === undefined) throw new Error("Pass the comment text with --body <text> or --body-file <path|->");
  if (body.trim() === "") throw new Error("The comment body is empty");
  return body.replace(/\s+$/, "");
}

/**
 * One request to the running server. Errors come back as the server's own
 * message; an unreachable server says so plainly (it is the likely failure:
 * the CLI works without a server for everything else).
 */
export async function callServer<T>(
  method: string,
  url: string,
  body?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        [ACTOR_HEADER]: actorHeaderValue(env),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const origin = new URL(url).origin;
    throw new Error(
      `Could not reach the Purview server at ${origin} (${(err as Error).message}). ` +
        "Comment commands go through the running server; start it with `purview` " +
        "(or set PURVIEW_PORT / PURVIEW_SERVER_URL if it runs elsewhere).",
    );
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { detail: text };
  }
  if (!res.ok) {
    const e = json as { error?: string; detail?: unknown };
    const detail = typeof e.detail === "string" ? e.detail : undefined;
    throw new Error(`${detail ?? e.error ?? `HTTP ${res.status}`} (HTTP ${res.status})`);
  }
  return json as T;
}
