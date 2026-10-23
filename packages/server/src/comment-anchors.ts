import { execFile } from "node:child_process";
import { loadState, type PrKey } from "@reviewer/core";
import { readComments, writeComments, reanchorDraftComments, type DraftCommentMove } from "./comments.js";
import { log } from "./log.js";

export type GitRunner = (repo: string, args: string[]) => Promise<string>;
export const runGit: GitRunner = (repo, args) => new Promise((resolve, reject) => {
  execFile("git", ["--literal-pathspecs", "-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Zero-context edits describe removed runs and the delta between unchanged runs. */
export function parseLineMap(diff: string): (line: number) => number | null {
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(m => ({
    old: Number(m[1]), removed: Number(m[2] ?? 1), added: Number(m[4] ?? 1),
  }));
  const deleted = /^deleted file mode /m.test(diff);
  return line => {
    if (deleted) return null;
    let delta = 0;
    for (const h of hunks) {
      if (h.removed === 0) {
        if (line <= h.old) break;
      } else {
        if (line < h.old) break;
        if (line < h.old + h.removed) return null;
      }
      delta += h.added - h.removed;
    }
    return line + delta;
  };
}

export async function mapLines(repoGitDir: string, oldSha: string, newSha: string, file: string,
  _side: "LEFT" | "RIGHT", git: GitRunner = runGit, newFile = file) {
  if (oldSha === newSha) return (line: number) => line;
  return parseLineMap(await git(repoGitDir, ["diff", "-U0", "--no-color", "--no-ext-diff", "-M", oldSha, newSha, "--", ...new Set([file, newFile])]));
}

export function parseRenames(output: string): Map<string, string> {
  const fields = output.split("\0");
  const renames = new Map<string, string>();
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    const file = fields[i++];
    if (status.startsWith("R")) renames.set(file, fields[i++]);
    else if (status.startsWith("C")) i++;
  }
  return renames;
}

/** Gather async Git results first, then reread before the synchronous write so edits made during refresh survive. */
export async function reanchorComments(key: PrKey, root: string, checkout: { path: string } | { error: string }, git: GitRunner = runGit): Promise<DraftCommentMove[]> {
  const state = loadState(key, root);
  const current = state.revisions.find(r => r.revision === state.currentRevision)!;
  const comments = readComments(key, root);
  const maps = new Map<string, Promise<(line: number) => number | null>>();
  const renames = new Map<string, Promise<Map<string, string>>>();
  const updates = new Map<string, { before: typeof comments[number]; after: typeof comments[number] }>();
  try {
    if ("error" in checkout) throw new Error(checkout.error);
    for (const c of comments) {
      if (c.revision >= state.currentRevision || c.inReplyTo || c.subjectType === "file" || c.outdated) continue;
      const old = state.revisions.find(r => r.revision === c.revision);
      if (!old) throw new Error(`Missing revision ${c.revision}`);
      const oldSha = c.side === "LEFT" ? old.mergeBase || old.baseSha : old.headSha;
      const newSha = c.side === "LEFT" ? current.mergeBase || current.baseSha : current.headSha;
      const pair = `${oldSha}:${newSha}`;
      if (!renames.has(pair)) renames.set(pair, (async () => {
        await git(checkout.path, ["cat-file", "-e", `${oldSha}^{commit}`]);
        return parseRenames(await git(checkout.path, ["diff", "--no-ext-diff", "-M", "--name-status", "-z", oldSha, newSha]));
      })());
      const file = (await renames.get(pair)!).get(c.file) ?? c.file;
      const cacheKey = `${pair}:${c.file}`;
      if (!maps.has(cacheKey)) maps.set(cacheKey, mapLines(checkout.path, oldSha, newSha, c.file, c.side!, git, file));
      const map = await maps.get(cacheKey)!;
      const line = map(c.line!);
      const startLine = c.startLine === undefined ? undefined : map(c.startLine);
      let gone = line === null || startLine === null;
      // Losing any part of a range loses its anchor, even if both ends survive.
      for (let n = c.startLine ?? c.line!; !gone && n <= c.line!; n++) gone = map(n) === null;
      const after = gone
        ? { ...c, revision: state.currentRevision, outdated: { line: c.line!, startLine: c.startLine, revision: c.revision } }
        : { ...c, revision: state.currentRevision, line: line!, startLine: startLine ?? undefined, file, outdated: undefined };
      updates.set(c.id, { before: c, after });
    }
  } catch (error) {
    log.warn("review", "Comment anchors using hunk fallback", { reason: String(error) });
    return reanchorDraftComments(key, root);
  }
  // A concurrent refresh won the race; never write an older revision over it.
  if (loadState(key, root).currentRevision !== state.currentRevision) return [];
  const moves: DraftCommentMove[] = [];
  const latest = readComments(key, root).map(c => {
    const update = updates.get(c.id);
    if (!update) return c;
    const { before, after } = update;
    if (c.revision !== before.revision || c.file !== before.file || c.line !== before.line || c.startLine !== before.startLine || c.outdated) return c;
    if (!after.outdated && (c.line !== after.line || c.file !== after.file || c.startLine !== after.startLine)) {
      moves.push({ id: c.id, file: c.file, fromLine: c.line!, toLine: after.line!, toFile: c.file !== after.file ? after.file : undefined, fromStartLine: c.startLine, toStartLine: after.startLine });
    }
    return { ...c, revision: after.revision, file: after.file, line: after.line, startLine: after.startLine, outdated: after.outdated };
  });
  if (updates.size) writeComments(key, latest, root);
  return moves;
}
