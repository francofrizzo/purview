import { gh, loadState, type PrKey } from "@reviewer/core";
import { markSubmitted, readComments, type Comment } from "./comments.js";

export interface CommentSyncResult {
  ok: boolean;
  pushed: number;
  reviewUrl?: string;
  error?: string;
}

function hostArgs(host: string): string[] {
  return host && host !== "github.com" ? ["--hostname", host] : [];
}

/**
 * Push local draft comments as a single PENDING review via `gh api` (REST:
 * POST /repos/{owner}/{repo}/pulls/{number}/reviews). Leaving `event` unset
 * creates a pending review awaiting submission on GitHub — matches the
 * SPEC's "push-only, no bidirectional thread sync" model.
 */
export function syncCommentsToGithub(key: PrKey, root?: string): CommentSyncResult {
  const drafts: Comment[] = readComments(key, root).filter((c) => c.status === "draft");
  if (drafts.length === 0) return { ok: true, pushed: 0 };

  let commitId: string | undefined;
  try {
    const state = loadState(key, root);
    commitId = state.revisions.find((r) => r.revision === state.currentRevision)?.headSha;
  } catch {
    // fall through; missing commit id will surface as a gh error below
  }
  if (!commitId) {
    return { ok: false, pushed: 0, error: "No head sha on record for the current revision" };
  }

  const body = {
    commit_id: commitId,
    comments: drafts.map((c) => ({
      path: c.file,
      line: c.line,
      side: c.side,
      body: c.body,
    })),
  };

  try {
    const raw = gh(
      [
        "api",
        "--method",
        "POST",
        ...hostArgs(key.host),
        `repos/${key.owner}/${key.repo}/pulls/${key.number}/reviews`,
        "--input",
        "-",
      ],
      JSON.stringify(body),
    );
    const parsed = JSON.parse(raw) as { html_url?: string };
    markSubmitted(
      key,
      drafts.map((c) => c.id),
      root,
    );
    return { ok: true, pushed: drafts.length, reviewUrl: parsed.html_url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, pushed: 0, error: message };
  }
}
