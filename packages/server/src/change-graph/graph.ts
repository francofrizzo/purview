/**
 * The PR's changed functions and the calls between them, from the diff's
 * hunks and the files at the head. Pure: the caller reads the files.
 */
import {
  callsIn,
  definitionOnLine,
  extractFunctions,
  isTestPath,
  languageOf,
  stripCode,
  touchedLines,
  type FnDef,
  type Lang,
} from "./functions.js";

export interface GraphHunk {
  id: string;
  oldStart: number;
  newStart: number;
  newLines: number;
  text: string;
}

export interface GraphFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  hunks: GraphHunk[];
  /** the file at the head, as lines; null when it is not there (removed) */
  head: string[] | null;
}

export interface GraphUnit {
  id: string;
  attention?: "must-read" | "skim" | "skip";
  hunkIds: string[];
}

export type FnStatus = "added" | "changed" | "removed";

export interface ChangedFn {
  id: string;
  name: string;
  qualifier?: string;
  path: string;
  lang: Lang;
  /** first line at the head (at the base for a removed function) */
  line: number;
  /** last line at the head (same as `line` for a removed function) */
  end: number;
  status: FnStatus;
  /** lines the diff added or removed inside it */
  lines: number;
  unit?: string;
  /** an added function whose name the diff removed from another file */
  movedFrom?: string;
  /** Go: the package clause of its file, what other packages call it through */
  pkg?: string;
  /**
   * Not reachable from other files (other packages, for Go): a TS function
   * without `export`, a Go name in lower case, a Python `_name`.
   */
  local?: boolean;
}

export interface CallEdge {
  from: string;
  to: string;
  /** call sites of `to` in `from`'s body */
  calls: number;
}

export interface ChangeGraph {
  nodes: ChangedFn[];
  edges: CallEdge[];
  /** changed functions found, before the cap */
  total: number;
  /** files the diff touches in a language the extraction does not read */
  unsupportedFiles: number;
}

const ATTENTION_RANK: Record<string, number> = { "must-read": 0, skim: 1, none: 2, skip: 3 };

/**
 * Every changed function, the call edges among them and, when there are
 * more than `maxNodes`, the ones worth drawing: functions in must-read units
 * first, then by lines changed. Edges only join drawn functions.
 */
export function buildChangeGraph(files: GraphFile[], units: GraphUnit[], opts: { maxNodes?: number } = {}) {
  const maxNodes = opts.maxNodes ?? 30;
  const unitOfHunk = new Map<string, GraphUnit>();
  for (const u of units) for (const h of u.hunkIds) unitOfHunk.set(h, u);

  const all: ChangedFn[] = [];
  const stripped = new Map<string, string[]>();
  const removedNames: { name: string; path: string; fn: ChangedFn }[] = [];
  let unsupportedFiles = 0;

  for (const file of files) {
    const lang = languageOf(file.path);
    if (!lang) {
      unsupportedFiles++;
      continue;
    }
    const perHunk = file.hunks.map((h) => ({ hunk: h, ...touchedLines(h) }));
    const addedSet = new Set(perHunk.flatMap((h) => h.added));
    const headNames = new Set<string>();

    if (file.head) {
      stripped.set(file.path, stripCode(file.head, lang));
      const pkg = lang === "go" ? file.head.map((l) => /^package\s+([A-Za-z_]\w*)/.exec(l)?.[1]).find(Boolean) : undefined;
      for (const def of extractFunctions(file.head, lang)) {
        headNames.add(def.name);
        const touch = new Map<string, number>();
        let lines = 0;
        for (const h of perHunk) {
          const n =
            h.added.filter((l) => l >= def.start && l <= def.end).length +
            h.deletedBefore.filter((l) => l > def.start && l <= def.end).length;
          if (n > 0) touch.set(h.hunk.id, n);
          lines += n;
        }
        if (lines === 0) continue;
        let all_added = file.status === "added";
        if (!all_added) {
          all_added = true;
          for (let l = def.start; l <= def.end; l++) if (!addedSet.has(l)) all_added = false;
        }
        all.push({
          id: fnId(file.path, def),
          name: def.name,
          ...(def.qualifier ? { qualifier: def.qualifier } : {}),
          path: file.path,
          lang,
          line: def.start,
          end: def.end,
          status: all_added ? "added" : "changed",
          lines,
          ...unitField(touch, unitOfHunk),
          ...(pkg ? { pkg } : {}),
          ...(isLocal(def, file.head[def.start - 1] ?? "", lang) ? { local: true } : {}),
        });
      }
    }

    // Removed functions: definitions on removed lines whose name the file no
    // longer defines. A removed file's definitions come from its old text.
    if (file.status === "removed" || !file.head) {
      const old = perHunk.flatMap((h) => h.removed);
      const oldLines = old.map((r) => r.text);
      for (const def of extractFunctions(oldLines, lang)) {
        const hunk = perHunk.find((h) => h.removed.some((r) => r.line === old[def.start - 1]?.line));
        removedNames.push({
          name: def.name,
          path: file.path,
          fn: removedFn(file.path, lang, def.name, def.qualifier, old[def.start - 1]?.line ?? def.start, def.end - def.start + 1, hunk?.hunk.id, unitOfHunk),
        });
      }
    } else {
      for (const h of perHunk) {
        const defs = h.removed.map((r) => definitionOnLine(r.text, lang));
        h.removed.forEach((r, j) => {
          const name = defs[j];
          if (!name || headNames.has(name)) return;
          if (removedNames.some((x) => x.path === file.path && x.name === name)) return;
          // Its size, without the old file at hand: the run of removed lines
          // from its definition to the next one, or to the run's end.
          let size = 1;
          while (j + size < h.removed.length && !defs[j + size] && h.removed[j + size].line === r.line + size) size++;
          removedNames.push({
            name,
            path: file.path,
            fn: removedFn(file.path, lang, name, undefined, r.line, size, h.hunk.id, unitOfHunk),
          });
        });
      }
    }
  }

  // A function removed from one file and added to another under the same
  // name moved: one node, the added one, saying where from.
  for (const r of removedNames) {
    const moved = all.find((f) => f.name === r.name && f.status === "added" && f.path !== r.path && !f.movedFrom);
    if (moved) moved.movedFrom = r.path;
    else all.push(r.fn);
  }

  // Calls: A's body at the head names B, another changed function (the one
  // in A's own file when names collide).
  const byName = new Map<string, ChangedFn[]>();
  for (const f of all) {
    if (f.status === "removed") continue;
    byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  }
  const edges: CallEdge[] = [];
  for (const a of all) {
    if (a.status === "removed") continue;
    const s = stripped.get(a.path);
    if (!s) continue;
    for (const [name, calls] of callsIn(s, a.line, a.end, { jsx: /x$/.test(a.path) })) {
      const candidates = (byName.get(name) ?? []).filter((b) => b.id !== a.id && sameFamily(a.lang, b.lang));
      if (candidates.length === 0) continue;
      // When names collide: the same file, then the same directory (Go's
      // package), then every candidate.
      const sameFile = candidates.filter((b) => b.path === a.path);
      const sameDir = candidates.filter((b) => dirOf(b.path) === dirOf(a.path));
      const targets = sameFile.length ? sameFile : sameDir.length ? sameDir : candidates;
      for (const b of targets) edges.push({ from: a.id, to: b.id, calls });
    }
  }

  const rank = (f: ChangedFn) => {
    const u = f.unit ? units.find((x) => x.id === f.unit) : undefined;
    return ATTENTION_RANK[u?.attention ?? "none"] ?? 2;
  };
  // Tests after the code they test, within the same attention.
  const ordered = [...all].sort((x, y) => rank(x) - rank(y) || Number(isTestPath(x.path)) - Number(isTestPath(y.path)) || y.lines - x.lines || x.path.localeCompare(y.path) || x.line - y.line);
  const kept = ordered.slice(0, maxNodes);
  const keptIds = new Set(kept.map((f) => f.id));
  // Drawn in file order, so a file's functions sit together.
  kept.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line);
  return {
    graph: {
      nodes: kept,
      edges: edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)),
      total: all.length,
      unsupportedFiles,
    } satisfies ChangeGraph,
    /** every changed function, uncapped: what blast radius greps for */
    all,
  };
}

function isLocal(def: FnDef, line: string, lang: Lang): boolean {
  if (lang === "go") return /^[a-z_]/.test(def.name);
  if (lang === "py") return def.name.startsWith("_") && !/^__\w+__$/.test(def.name);
  // A TS method is as reachable as its class; a top-level function needs `export`.
  return !def.qualifier && !/^\s*export\b/.test(line);
}

function dirOf(path: string) {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function sameFamily(a: Lang, b: Lang) {
  return a === b;
}

function fnId(path: string, def: Pick<FnDef, "name" | "qualifier" | "start">): string {
  return `${path}#${def.qualifier ? `${def.qualifier}.` : ""}${def.name}@${def.start}`;
}

function unitField(touch: Map<string, number>, unitOfHunk: Map<string, GraphUnit>): { unit?: string } {
  // The unit holding most of the function's changed lines.
  const perUnit = new Map<string, number>();
  for (const [hunk, n] of touch) {
    const u = unitOfHunk.get(hunk);
    if (u) perUnit.set(u.id, (perUnit.get(u.id) ?? 0) + n);
  }
  let best: string | undefined;
  let most = 0;
  for (const [u, n] of perUnit) if (n > most) [best, most] = [u, n];
  return best ? { unit: best } : {};
}

function removedFn(
  path: string,
  lang: Lang,
  name: string,
  qualifier: string | undefined,
  line: number,
  lines: number,
  hunkId: string | undefined,
  unitOfHunk: Map<string, GraphUnit>,
): ChangedFn {
  const unit = hunkId ? unitOfHunk.get(hunkId)?.id : undefined;
  return {
    id: `${path}#${qualifier ? `${qualifier}.` : ""}${name}@-${line}`,
    name,
    ...(qualifier ? { qualifier } : {}),
    path,
    lang,
    line,
    end: line,
    status: "removed",
    lines,
    ...(unit ? { unit } : {}),
  };
}
