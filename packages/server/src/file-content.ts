import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { fetchFileAtSha, loadState, prCheckoutPath, type PrKey } from "@reviewer/core";

const execFileAsync = promisify(execFile);

/**
 * Whole files at the PR head, for "expand context" around hunks: lines the
 * diff does not carry. The managed checkout answers when it has the commit
 * (fast, offline); the contents API otherwise. A commit's files never change,
 * so answers are cached by sha for the life of the process (bounded).
 */
const CACHE_LIMIT = 200;
const cache = new Map<string, string[] | null>();

function remember(k: string, v: string[] | null) {
  cache.set(k, v);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Text -> lines, without the phantom empty line after a trailing newline. */
export function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

async function fromCheckout(key: PrKey, sha: string, filePath: string, root: string): Promise<string | null | undefined> {
  const dir = prCheckoutPath(key, root);
  if (!fs.existsSync(dir)) return undefined;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "show", `${sha}:${filePath}`], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // Commit not fetched into the checkout, or no such path: let the API decide.
    return undefined;
  }
}

/** The file at the current revision's head, or `null` when it does not exist there. */
export async function fileLinesAtHead(
  key: PrKey,
  filePath: string,
  root: string,
): Promise<{ sha: string; lines: string[] | null }> {
  const state = loadState(key, root);
  const sha = state.revisions.find((r) => r.revision === state.currentRevision)?.headSha;
  if (!sha) throw new Error(`No head commit recorded for revision ${state.currentRevision}`);
  const k = `${root}|${key.host}/${key.owner}/${key.repo}|${sha}|${filePath}`;
  if (cache.has(k)) return { sha, lines: cache.get(k)! };
  const local = await fromCheckout(key, sha, filePath, root);
  const text = local !== undefined ? local : await fetchFileAtSha(key, sha, filePath);
  const lines = text === null ? null : toLines(text);
  remember(k, lines);
  return { sha, lines };
}
