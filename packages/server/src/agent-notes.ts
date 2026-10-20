import type { FileDiff, Meta, PrKey } from "@reviewer/core";
import { keyToString } from "@reviewer/core";
import { anchoringHunkOf, commentEvents, pendingAgentNotes, readComments, type Comment } from "./comments.js";

const languages: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "python", rb: "ruby", rs: "rust", go: "go", json: "json", css: "css", sh: "sh", md: "markdown", yml: "yaml", yaml: "yaml" };

export function formatAgentNotes(notes: Comment[], { meta, revision, files }: {
  meta: Pick<Meta, "owner" | "repo" | "number">; revision: number; files: FileDiff[];
}): string {
  if (!notes.length) return "";
  const parts = [`# Notes from the reviewer — ${meta.owner}/${meta.repo}#${meta.number} (revision ${revision})`,
    `${notes.length} notes. Each one names the file and line and quotes the reviewer. Act on them in the code.`];
  const emitted = new Set<string>();
  let number = 0;
  const render = (note: Comment, reply = false) => {
    if (emitted.has(note.id)) return;
    emitted.add(note.id);
    const where = note.subjectType === "file" ? `${note.file} (file)` : `${note.file}:${note.startLine !== undefined ? `${note.startLine}-` : ""}${note.line}`;
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
    parts.push(note.body.split("\n").map((line) => `> ${line}`).join("\n"));
    for (const child of notes.filter((c) => c.inReplyTo === note.id || (note.githubThreadId && c.inReplyTo === note.githubThreadId))) render(child, true);
  };
  for (const note of notes.filter((n) => !n.inReplyTo)) render(note);
  for (const note of notes) render(note, Boolean(note.inReplyTo));
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
      try { if (pendingAgentNotes(readComments(key, root)).length) finish(); }
      catch (error) { finish(error); }
    };
    const changed = (event: { key: PrKey }) => { if (keyToString(event.key) === keyToString(key)) check(); };
    commentEvents.on("comments", changed);
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(finish, seconds * 1000);
    if (signal.aborted) aborted(); else check();
  });
}
