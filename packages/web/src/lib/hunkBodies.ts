import { hunkBodyLines } from "./diffModel";
import type { FileEntry, Hunk } from "../api/types";

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const keyOf = (file: string, oldStart: number, oldLines: number, newStart: number, newLines: number) =>
  JSON.stringify([file, oldStart, oldLines, newStart, newLines]);

// Same path escapes as core's parse-diff. Do not interpret spaces as delimiters.
function filePath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(.)/g, (_, c: string) =>
      c === "n" ? "\n" : c === "t" ? "\t" : c);
  }
  return value.replace(/^[ab]\//, "");
}

/** Index once per response, preserving core's exact body-row index space. */
export function hunkBodies(diff: string): (hunk: Hunk) => string[] | undefined {
  const bodies = new Map<string, string[]>();
  const lines = diff.split("\n");
  let oldFile = "";
  let file = "";
  let body: string[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      file = oldFile = "";
      body = undefined;
      continue;
    }
    if (body) {
      if (/^[ +\-\\]/.test(line) || (line === "" && i < lines.length - 1)) {
        body.push(line);
        continue;
      }
      body = undefined;
    }
    if (line.startsWith("--- ")) oldFile = filePath(line.slice(4));
    else if (line.startsWith("+++ ")) {
      file = filePath(line.slice(4));
      if (file === "/dev/null") file = oldFile;
    } else {
      const h = HEADER.exec(line);
      if (h && file) {
        body = [];
        bodies.set(keyOf(file, +h[1], h[2] === undefined ? 1 : +h[2], +h[3], h[4] === undefined ? 1 : +h[4]), body);
      }
    }
  }
  return (h) => bodies.get(keyOf(h.file, h.oldStart, h.oldLines, h.newStart, h.newLines));
}

/** Detail wire shape; body fields are accepted only for older servers. */
export interface WireHunk extends Omit<Hunk, "lines"> { text?: string }
export interface WireFile extends Omit<FileEntry, "hunks"> { hunks: WireHunk[] }

export function hydrateFiles(files: WireFile[], diff: string): FileEntry[] {
  const bodyOf = hunkBodies(diff);
  return files.map((file) => adaptFile(file, bodyOf));
}

function adaptHunk(h: WireHunk, bodyOf: ReturnType<typeof hunkBodies>): Hunk {
  // core stores the body as a single newline-joined string; the renderer wants
  // one entry per line. An empty body must stay empty, not [""].
  const lines = hunkBodyLines(h.text) ?? bodyOf(h);
  return { ...h, lines,
    addedLines: lines ? lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)) : h.addedLines,
    removedLines: lines ? lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1)) : h.removedLines,
  };
}

function adaptFile(f: WireFile, bodyOf: ReturnType<typeof hunkBodies>): FileEntry {
  const hunks = f.hunks.map((h) => adaptHunk(h, bodyOf));
  // core doesn't carry per-file stats; they're a cheap fold over the hunks.
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    additions += h.addedLines?.length ?? 0;
    deletions += h.removedLines?.length ?? 0;
  }
  return {
    path: f.path,
    oldPath: f.oldPath,
    status: f.status,
    binary: f.binary,
    // Only ever present when set: an absent key keeps old fixtures/snapshots equal.
    ...(f.generated ? { generated: f.generated } : {}),
    additions,
    deletions,
    hunks,
  };
}

