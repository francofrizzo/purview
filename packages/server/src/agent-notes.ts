import type { FileDiff, Meta, PrKey } from "@reviewer/core";
import { keyToString } from "@reviewer/core";
import { anchoringHunkOf, commentEvents, pendingAgentNotes, pendingAgentWithdrawals, readComments, readDeletedComments, type AgentNoteWithdrawal, type Comment } from "./comments.js";

const languages: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "python", rb: "ruby", rs: "rust", go: "go", json: "json", css: "css", sh: "sh", md: "markdown", yml: "yaml", yaml: "yaml" };

type Anchor = Pick<Comment, "file" | "subjectType" | "line" | "startLine">;
const whereOf = (note: Anchor) => note.subjectType === "file" ? `${note.file} (file)` : `${note.file}:${note.startLine !== undefined ? `${note.startLine}-` : ""}${note.line}`;
const quote = (body: string) => body.split("\n").map((line) => `> ${line}`).join("\n");

/** A pending note for the pickup response: new, or an edit of one the agent holds (`previousBody`, what it was handed). */
export function deliveredNote(note: Comment, pending = note): Omit<Comment, "previousPickup"> & { kind: "new" | "edited"; previousBody?: string } {
  const { previousPickup: _previous, ...rest } = note;
  return pending.previousPickup ? { ...rest, kind: "edited", previousBody: pending.previousPickup.body } : { ...rest, kind: "new" };
}

/**
 * `headSha`: the revision's head commit, which the agent can find in its checkout (a revision number means nothing to it).
 * A note with `previousPickup` is an edit of one the agent holds; `withdrawn` are notes it holds that it should drop.
 */
export function formatAgentNotes(notes: Comment[], { meta, revision, headSha, files, withdrawn = [] }: {
  meta: Pick<Meta, "owner" | "repo" | "number">; revision: number; headSha?: string; files: FileDiff[]; withdrawn?: AgentNoteWithdrawal[];
}): string {
  if (!notes.length && !withdrawn.length) return "";
  const at = headSha ? `revision ${revision}, commit ${headSha.slice(0, 12)}` : `revision ${revision}`;
  const edited = notes.filter((n) => n.previousPickup).length;
  const parts = [`# Notes from the reviewer — ${meta.owner}/${meta.repo}#${meta.number} (${at})`,
    [notes.length ? `${notes.length} notes. Each one names the file and line and quotes the reviewer. Act on them in the code.` : "",
      edited ? `${edited} of them edit a note you picked up earlier: the new text replaces the old one, so act on the new one only.` : "",
      withdrawn.length ? `${withdrawn.length} withdrawn: the reviewer took back a note you picked up earlier. Ignore it, and undo what you changed for it unless the change still stands on its own.` : "",
    ].filter(Boolean).join(" ")];
  const emitted = new Set<string>();
  let number = 0;
  const render = (note: Comment, reply = false) => {
    if (emitted.has(note.id)) return;
    emitted.add(note.id);
    const where = whereOf(note);
    parts.push(reply ? "### reply" : `## ${++number}. ${where}`);
    if (!reply && note.subjectType === "line") {
      const hunk = anchoringHunkOf(files, note);
      if (!hunk) parts.push("(line no longer in current diff)");
      else {
        let line = note.side === "LEFT" ? hunk.oldStart : hunk.newStart;
        const text: string[] = [];
        for (const row of hunk.text.replace(/\n$/, "").split("\n")) {
          if (row.startsWith("\\") || (note.side === "LEFT" ? row.startsWith("+") : row.startsWith("-"))) continue;
          if (line >= (note.startLine ?? note.line!) - 2 && line <= note.line! + 2) text.push(row.slice(1));
          line++;
        }
        const fence = "`".repeat(Math.max(3, ...text.flatMap((s) => [...s.matchAll(/`+/g)].map((m) => m[0].length + 1))));
        parts.push(`${fence}${languages[note.file.split(".").pop() ?? ""] ?? ""}\n${text.join("\n")}\n${fence}`);
      }
    }
    if (note.previousPickup) {
      parts.push(`Edited: replaces the ${reply ? "reply" : "note"} on \`${where}\` you picked up earlier. It said:`, quote(note.previousPickup.body), "It now says:");
    }
    parts.push(quote(note.body));
    for (const child of notes.filter((c) => c.inReplyTo === note.id || (note.githubThreadId && c.inReplyTo === note.githubThreadId))) render(child, true);
  };
  for (const note of notes.filter((n) => !n.inReplyTo)) render(note);
  for (const note of notes) render(note, Boolean(note.inReplyTo));
  for (const note of withdrawn) {
    const where = whereOf(note);
    parts.push(`## ${++number}. Withdrawn: ${where}`,
      `Withdrawn: ignore the ${note.inReplyTo ? "reply" : "note"} on \`${where}\` you picked up earlier (${note.reason === "deleted" ? "the reviewer deleted it" : "the reviewer moved it to the GitHub review"}). It said:`,
      quote(note.body));
  }
  return parts.join("\n\n") + "\n";
}

/** Subscribe before reading; every wake rechecks the source of truth. */
export function waitForAgentNotes(key: PrKey, root: string, seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      commentEvents.off("comments", changed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(signal.reason ?? new Error("Request aborted"));
    const check = () => {
      try {
        const comments = readComments(key, root);
        if (pendingAgentNotes(comments).length || pendingAgentWithdrawals(comments, readDeletedComments(key, root)).length) finish();
      }
      catch (error) { finish(error); }
    };
    const changed = (event: { key: PrKey }) => { if (keyToString(event.key) === keyToString(key)) check(); };
    commentEvents.on("comments", changed);
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(finish, seconds * 1000);
    if (signal.aborted) aborted(); else check();
  });
}
