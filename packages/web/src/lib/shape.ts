/**
 * Where the change lands, as text: the PR's files as a shallow tree with the
 * analysis's one-line notes (fileNotes), keyed by a folder or a file. Pure,
 * so the drawing is the only thing the component does.
 */

import type { FileEntry, FileNotes, ReviewUnit } from "../api/types";

export interface TreeLine {
  /** the box-drawing prefix for this line: "│   ├── " and the like */
  prefix: string;
  /** a folder's name (possibly a chain `a/b/c`), or a file's (possibly `dir/file` when it is all its folder draws) */
  name: string;
  dir: boolean;
  /** the folder's path, or the file's */
  path: string;
  /** a quiet top-level folder drawn as one line: how many files it holds */
  folded?: number;
  /** a folder: the files under it that no line names */
  more?: number;
  /** files only */
  status?: FileEntry["status"];
  note?: string;
}

type TreeFile = { name: string; path: string; status?: FileEntry["status"] };

interface Dir {
  dirs: Map<string, Dir>;
  files: TreeFile[];
}

const emptyDir = (): Dir => ({ dirs: new Map(), files: [] });
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const byName = <T>(entries: [string, T][]) => entries.sort(([a], [b]) => a.localeCompare(b));

/** Every file under a directory, however deep. */
const filesUnder = (d: Dir): TreeFile[] => [...d.files, ...[...d.dirs.values()].flatMap(filesUnder)];

/**
 * The files as a shallow tree, the way a design doc shows where a change
 * lands. Drawn: folders and files with a note, and files the PR adds, deletes
 * or moves. A noted folder is one line, and its own note covers the rest of
 * it; any other folder counts the files no line names. A folder that draws a
 * single file is one line (`handlers/groups.go`); a quiet folder at the top is
 * one line with its count. Files in `aside` (tests, docs) are left to the
 * caller's foot line, unless the analysis noted one.
 */
export function fileTree(
  files: Pick<FileEntry, "path" | "status">[],
  notes: FileNotes = {},
  aside: ReadonlySet<string> = new Set(),
): TreeLine[] {
  const root = emptyDir();
  for (const f of files) {
    if (aside.has(f.path) && notes[f.path] === undefined) continue;
    const parts = f.path.split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, emptyDir());
      at = at.dirs.get(part)!;
    }
    at.files.push({ name: parts[parts.length - 1], path: f.path, status: f.status });
  }

  const notable = (f: TreeFile) => notes[f.path] !== undefined || (!!f.status && f.status !== "modified");
  const noted = (path: string) => notes[path] !== undefined;
  /** something under the folder gets a line: a notable file or a noted folder */
  const live = (d: Dir, path: string): boolean =>
    d.files.some(notable) || [...d.dirs].some(([name, sub]) => noted(join(path, name)) || live(sub, join(path, name)));
  const drawnDirs = (d: Dir, path: string) =>
    byName([...d.dirs]).filter(([name, sub]) => noted(join(path, name)) || live(sub, join(path, name)));
  /** the files under a folder that no line inside it names */
  const hidden = (d: Dir, path: string): number =>
    d.files.filter((f) => !notable(f)).length +
    [...d.dirs].reduce((n, [name, sub]) => {
      const p = join(path, name);
      return n + (noted(p) || live(sub, p) ? 0 : filesUnder(sub).length);
    }, 0);
  /** the one file a folder draws, when that is all it draws, named from the folder down */
  const lone = (d: Dir, path: string, covered: boolean): { name: string; f: TreeFile } | null => {
    if (noted(path) || (!covered && hidden(d, path) > 0)) return null;
    const own = d.files.filter(notable);
    const dirs = drawnDirs(d, path);
    if (own.length === 1 && dirs.length === 0) return { name: own[0].name, f: own[0] };
    if (own.length === 0 && dirs.length === 1) {
      const [name, sub] = dirs[0];
      const inner = lone(sub, join(path, name), covered);
      return inner ? { name: `${name}/${inner.name}`, f: inner.f } : null;
    }
    return null;
  };

  const out: TreeLine[] = [];
  const fileLine = (prefix: string, name: string, f: TreeFile): TreeLine => ({
    prefix,
    name,
    dir: false,
    path: f.path,
    status: f.status,
    note: notes[f.path],
  });
  // `covered`: inside a noted folder, whose note speaks for what is not drawn.
  const walk = (dir: Dir, path: string, indent: string, top: boolean, covered: boolean) => {
    type Item = { kind: "dir"; name: string; dir: Dir } | { kind: "file"; f: TreeFile };
    const dirs = top ? byName([...dir.dirs]) : drawnDirs(dir, path);
    const items: Item[] = [
      ...dirs.map(([name, d]) => ({ kind: "dir" as const, name, dir: d })),
      ...[...dir.files]
        .filter((f) => top || notable(f))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => ({ kind: "file" as const, f })),
    ];
    items.forEach((item, i) => {
      const last = i === items.length - 1;
      // The top level has no branch of its own: each root reads as a heading.
      const branch = top ? "" : last ? "└── " : "├── ";
      const childIndent = top ? "" : indent + (last ? "    " : "│   ");
      if (item.kind === "file") {
        out.push(fileLine(indent + branch, item.f.name, item.f));
        return;
      }
      const at = join(path, item.name);
      const single = lone(item.dir, at, covered);
      if (single) {
        out.push(fileLine(indent + branch, `${item.name}/${single.name}`, single.f));
        return;
      }
      let name = item.name;
      let p = at;
      let d = item.dir;
      while (!noted(p) && d.files.length === 0 && d.dirs.size === 1) {
        const [next, inner] = [...d.dirs.entries()][0];
        name = `${name}/${next}`;
        p = join(p, next);
        d = inner;
      }
      if (!noted(p) && !live(d, p)) {
        const under = filesUnder(d);
        out.push(
          under.length === 1
            ? fileLine(indent + branch, `${name}/${under[0].path.slice(p.length + 1)}`, under[0])
            : { prefix: indent + branch, name, dir: true, path: p, folded: under.length },
        );
        return;
      }
      const more = noted(p) || covered ? 0 : hidden(d, p);
      out.push({ prefix: indent + branch, name, dir: true, path: p, note: notes[p], ...(more ? { more } : {}) });
      walk(d, p, childIndent, false, covered || noted(p));
    });
  };
  walk(root, "", "", true, false);
  return out;
}

/**
 * The files only tests and docs units read, which the tree leaves to its
 * foot line: a file any other unit reads (or none does) is in the tree.
 */
export function asideFiles(files: Pick<FileEntry, "path" | "hunks">[], units: Pick<ReviewUnit, "kind" | "hunks">[]): Set<string> {
  const fileOf = new Map<string, string>();
  for (const f of files) for (const h of f.hunks) fileOf.set(h.id, f.path);
  const aside = new Set<string>();
  const read = new Set<string>();
  for (const u of units) {
    const into = u.kind === "tests" || u.kind === "docs" ? aside : read;
    for (const h of u.hunks) {
      const path = fileOf.get(h.id);
      if (path) into.add(path);
    }
  }
  for (const path of read) aside.delete(path);
  return aside;
}

/** A file's note, or the nearest folder's above it. */
export function noteFor(notes: FileNotes | undefined, path: string): string | undefined {
  if (!notes) return undefined;
  for (let at = path; at; at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "") {
    if (notes[at] !== undefined) return notes[at];
  }
  return undefined;
}
