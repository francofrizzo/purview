import type { FileDiff, FileStatus, Hunk } from "./schemas.js";
import { computeHunkId, disambiguate } from "./hunk-id.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Git quotes paths containing odd characters: "a/we\"ird". */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  return inner.replace(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return c;
    }
  });
}

/** Strip the `a/` / `b/` prefix that git adds (unless the path is /dev/null). */
function stripPrefix(p: string): string {
  const s = unquote(p.trim());
  if (s === "/dev/null") return s;
  if (s.startsWith("a/") || s.startsWith("b/")) return s.slice(2);
  return s;
}

/** Split `diff --git a/x b/y` into its two paths. */
function splitGitHeaderPaths(rest: string): [string, string] | null {
  // Quoted form first.
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) return [stripPrefix(quoted[1]), stripPrefix(quoted[2])];
  // Unquoted paths may contain spaces; the split point is where " b/" starts
  // such that both halves are equal-ish. Try every candidate.
  const idxs: number[] = [];
  for (let i = 0; i < rest.length - 2; i++) {
    if (rest.startsWith(" b/", i)) idxs.push(i);
  }
  for (const i of idxs) {
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if (left.startsWith("a/")) return [stripPrefix(left), stripPrefix(right)];
  }
  return null;
}

interface PendingFile {
  oldPath?: string;
  newPath?: string;
  headerOld?: string;
  headerNew?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: RawHunk[];
}

interface RawHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  bodyLines: string[];
}

function emptyPending(): PendingFile {
  return {
    isNew: false,
    isDeleted: false,
    isRename: false,
    binary: false,
    hunks: [],
  };
}

function finalize(p: PendingFile): FileDiff | null {
  const oldPath =
    p.headerOld && p.headerOld !== "/dev/null" ? p.headerOld : p.oldPath;
  const newPath =
    p.headerNew && p.headerNew !== "/dev/null" ? p.headerNew : p.newPath;

  const deleted = p.isDeleted || p.headerNew === "/dev/null";
  const added = p.isNew || p.headerOld === "/dev/null";

  const path = deleted ? oldPath : newPath;
  if (!path) return null;

  let status: FileStatus = "modified";
  if (added) status = "added";
  else if (deleted) status = "removed";
  else if (p.isRename || (oldPath && newPath && oldPath !== newPath))
    status = "renamed";

  const seen = new Map<string, number>();
  const hunks: Hunk[] = p.hunks.map((h) => {
    const addedLines: string[] = [];
    const removedLines: string[] = [];
    for (const line of h.bodyLines) {
      if (line.startsWith("+")) addedLines.push(line.slice(1));
      else if (line.startsWith("-")) removedLines.push(line.slice(1));
    }
    const id = disambiguate(
      computeHunkId(path, addedLines, removedLines),
      seen,
    );
    return {
      id,
      file: path,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      header: h.header,
      addedLines,
      removedLines,
      text: h.bodyLines.join("\n"),
    };
  });

  return {
    path,
    oldPath: status === "renamed" ? oldPath : status === "removed" ? undefined : oldPath && oldPath !== path ? oldPath : undefined,
    status,
    binary: p.binary,
    oldMode: p.oldMode,
    newMode: p.newMode,
    similarity: p.similarity,
    // Binary files carry no reviewable hunks.
    hunks: p.binary ? [] : hunks,
  };
}

/**
 * Parse a GitHub `application/vnd.github.v3.diff` payload into files -> hunks.
 * Handles renames, deletions, additions, mode changes; binary files are kept
 * as entries with `binary: true` and zero hunks.
 */
export function parseDiff(patch: string): FileDiff[] {
  const lines = patch.split("\n");
  const files: FileDiff[] = [];
  let cur: PendingFile | null = null;
  let curHunk: RawHunk | null = null;

  const flushFile = () => {
    if (cur) {
      const f = finalize(cur);
      if (f) files.push(f);
    }
    cur = null;
    curHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      flushFile();
      cur = emptyPending();
      const paths = splitGitHeaderPaths(line.slice("diff --git ".length));
      if (paths) {
        cur.oldPath = paths[0];
        cur.newPath = paths[1];
      }
      continue;
    }
    if (!cur) continue;

    if (curHunk) {
      if (
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith("\\") ||
        line === ""
      ) {
        // A trailing empty line at EOF is an artifact of split("\n"), not a
        // context line.
        const isTrailingArtifact = line === "" && i === lines.length - 1;
        if (!isTrailingArtifact) {
          curHunk.bodyLines.push(line);
          continue;
        }
      }
      curHunk = null;
      // fall through: this line starts something new
    }

    const hm = line.match(HUNK_HEADER);
    if (hm) {
      curHunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        header: hm[5].trim(),
        bodyLines: [],
      };
      cur.hunks.push(curHunk);
      continue;
    }

    if (line.startsWith("--- ")) {
      cur.headerOld = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      cur.headerNew = stripPrefix(line.slice(4));
    } else if (line.startsWith("new file mode ")) {
      cur.isNew = true;
      cur.newMode = line.slice("new file mode ".length).trim();
    } else if (line.startsWith("deleted file mode ")) {
      cur.isDeleted = true;
      cur.oldMode = line.slice("deleted file mode ".length).trim();
    } else if (line.startsWith("old mode ")) {
      cur.oldMode = line.slice("old mode ".length).trim();
    } else if (line.startsWith("new mode ")) {
      cur.newMode = line.slice("new mode ".length).trim();
    } else if (line.startsWith("rename from ")) {
      cur.isRename = true;
      cur.oldPath = stripPrefix(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      cur.isRename = true;
      cur.newPath = stripPrefix(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      cur.oldPath = stripPrefix(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      cur.newPath = stripPrefix(line.slice("copy to ".length));
    } else if (line.startsWith("similarity index ")) {
      cur.similarity = Number(
        line.slice("similarity index ".length).replace("%", "").trim(),
      );
    } else if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      cur.binary = true;
    } else if (line.startsWith("index ")) {
      const m = line.match(/^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/);
      if (m) {
        cur.oldMode ??= m[1];
        cur.newMode ??= m[1];
      }
    }
  }

  flushFile();
  return files;
}

/** Flatten a parsed diff to its hunks, in file order. */
export function allHunks(files: FileDiff[]): Hunk[] {
  return files.flatMap((f) => f.hunks);
}
