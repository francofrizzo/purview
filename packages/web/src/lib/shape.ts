/**
 * The text views of a change's shape: the PR's files as a tree with the
 * analysis's one-line notes (fileNotes), and a flow's steps laid out in rows
 * with its phase bands between them. Pure, so the drawing is the only thing
 * the components do.
 */

import type { FileEntry, FileNotes, Flow } from "../api/types";

export interface TreeLine {
  /** the box-drawing prefix for this line: "│   ├── " and the like */
  prefix: string;
  /** a file's name, or a directory's (possibly a compressed chain `a/b/c`) */
  name: string;
  dir: boolean;
  /** a quiet directory drawn as one line: how many files it holds */
  folded?: number;
  /** files only */
  path?: string;
  status?: FileEntry["status"];
  note?: string;
}

interface Dir {
  dirs: Map<string, Dir>;
  files: { name: string; path: string; status?: FileEntry["status"] }[];
}

const emptyDir = (): Dir => ({ dirs: new Map(), files: [] });

/** Every file under a directory, however deep. */
const filesUnder = (d: Dir): Dir["files"] => [...d.files, ...[...d.dirs.values()].flatMap(filesUnder)];

/**
 * The files as a tree, directories first, then files, each alphabetically.
 * A directory holding nothing but one directory folds into it
 * (`src/effects/services`), so deep paths don't eat the page; a quiet one
 * (nothing new, gone, moved or noted in it, two files or more) is one line
 * with its count, so the tree shows where the change lands, not every file
 * it brushes.
 */
export function fileTree(files: Pick<FileEntry, "path" | "status">[], notes: FileNotes = {}): TreeLine[] {
  const root = emptyDir();
  for (const f of files) {
    const parts = f.path.split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, emptyDir());
      at = at.dirs.get(part)!;
    }
    at.files.push({ name: parts[parts.length - 1], path: f.path, status: f.status });
  }

  const out: TreeLine[] = [];
  const walk = (dir: Dir, indent: string, top: boolean) => {
    const dirs = [...dir.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    const items: ({ kind: "dir"; name: string; dir: Dir } | { kind: "file"; f: Dir["files"][number] })[] = [
      ...dirs.map(([name, d]) => ({ kind: "dir" as const, name, dir: d })),
      ...[...dir.files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ kind: "file" as const, f })),
    ];
    items.forEach((item, i) => {
      const last = i === items.length - 1;
      // The top level has no branch of its own: each root reads as a heading.
      const branch = top ? "" : last ? "└── " : "├── ";
      const childIndent = top ? "" : indent + (last ? "    " : "│   ");
      if (item.kind === "dir") {
        let name = item.name;
        let d = item.dir;
        while (d.files.length === 0 && d.dirs.size === 1) {
          const [next, inner] = [...d.dirs.entries()][0];
          name = `${name}/${next}`;
          d = inner;
        }
        const under = filesUnder(d);
        const quiet = under.every((f) => !notes[f.path] && (!f.status || f.status === "modified"));
        if (quiet && under.length > 1) {
          out.push({ prefix: indent + branch, name, dir: true, folded: under.length });
        } else {
          out.push({ prefix: indent + branch, name, dir: true });
          walk(d, childIndent, false);
        }
      } else {
        out.push({
          prefix: indent + branch,
          name: item.f.name,
          dir: false,
          path: item.f.path,
          status: item.f.status,
          note: notes[item.f.path],
        });
      }
    });
  };
  walk(root, "", true);
  return out;
}

export type FlowRow = { kind: "phase"; label: string } | { kind: "step"; index: number };

/** The flow's steps in order, a phase band before the step each phase starts at. */
export function flowRows(flow: Pick<Flow, "steps" | "phases">): FlowRow[] {
  const startsAt = new Map<number, string>();
  for (const p of flow.phases ?? []) if (p.at < flow.steps.length) startsAt.set(p.at, p.label);
  const rows: FlowRow[] = [];
  flow.steps.forEach((_, i) => {
    const phase = startsAt.get(i);
    if (phase) rows.push({ kind: "phase", label: phase });
    rows.push({ kind: "step", index: i });
  });
  return rows;
}
