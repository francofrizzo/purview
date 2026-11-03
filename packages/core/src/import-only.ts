import type { FileDiff, Hunk, HunkEntry } from "./schemas.js";

/**
 * Whether a hunk changes nothing but imports: the one skip that is a
 * mechanical fact, so Purview marks it rather than leaving it to the
 * analysis (which misses about a third of them). Language-aware for Go,
 * TS/JS and Python; any other file is never claimed.
 *
 * Precision first: a wrong skip hides code, a missed one costs a glance. So
 * every changed line has to sit inside an import statement, read from the
 * hunk itself: its context lines, and its header, where git names the
 * enclosing column-0 line (`import (`, `import {`, `from x import (`) when a
 * hunk starts inside a long one. A line that does not have an import's shape
 * ends the statement, so a stale header never vouches for code. Left to the
 * analysis even so: an import run for its side effect (Go `_`/`.`, a bare JS
 * `import "x"`, `from __future__`), and a removed re-export (the module's
 * public API shrinks).
 */

type Mark = "import" | "reexport" | "side" | "blank" | "other";
type Lang = "go" | "js" | "py";

const LANG_BY_EXT: Record<string, Lang> = {
  go: "go",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
};

export function importLanguage(path: string): Lang | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") ? (LANG_BY_EXT[ext] ?? null) : null;
}

/* ------------------------------------------------------------------ Go */

const GO_SPEC = /^(?:([\w.]+)\s+)?"[^"]*"\s*(?:\/\/.*)?$/;
const GO_SINGLE = /^import\s+(?:([\w.]+)\s+)?"[^"]*"\s*(?:\/\/.*)?$/;
const GO_OPEN = /^import\s*\(\s*$/;

function goMarks(lines: string[], header: string): Mark[] {
  let inBlock = GO_OPEN.test(header.trim());
  return lines.map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t === "") return "blank";
      if (t === ")") {
        inBlock = false;
        return "import";
      }
      if (t.startsWith("//")) return "import";
      const spec = GO_SPEC.exec(t);
      if (spec) return spec[1] === "_" || spec[1] === "." ? "side" : "import";
      inBlock = false;
      return "other";
    }
    if (t === "") return "blank";
    if (GO_OPEN.test(t)) {
      inBlock = true;
      return "import";
    }
    const single = GO_SINGLE.exec(t);
    if (single) return single[1] === "_" || single[1] === "." ? "side" : "import";
    return "other";
  });
}

/* --------------------------------------------------------------- TS/JS */

const QUOTED = `(?:"[^"]*"|'[^']*'|\`[^\`]*\`)`;
const JS_FROM = new RegExp(`\\bfrom\\s*${QUOTED}\\s*;?\\s*(?://.*)?$`);
const JS_IMPORT_ONE = new RegExp(`^import\\s+(?:type\\s+)?[^"'\`]+\\s+from\\s*${QUOTED}\\s*;?\\s*(?://.*)?$`);
const JS_SIDE = new RegExp(`^import\\s*${QUOTED}\\s*;?\\s*(?://.*)?$`);
const JS_REEXPORT_ONE = new RegExp(`^export\\s+(?:type\\s+)?(?:\\*(?:\\s+as\\s+[\\w$]+)?|\\{[^}]*\\})\\s*from\\s*${QUOTED}\\s*;?\\s*(?://.*)?$`);
const JS_REQUIRE = new RegExp(`^(?:const|let|var)\\s+[\\w$\\s{},:]+=\\s*require\\(\\s*${QUOTED}\\s*\\)\\s*;?\\s*$`);
/** `import {` / `import type {` / `import Foo, {` left open on its line. */
const JS_IMPORT_OPEN = /^import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*$/;
const JS_EXPORT_OPEN = /^export\s+(?:type\s+)?\{[^}]*$/;
const JS_NAME = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*(?:\/\/.*)?$/;
const JS_CLOSE = /^\}\s*/;

function jsMarks(lines: string[], header: string): Mark[] {
  const marks: Mark[] = [];
  // An open import braces list; an open `export {` waits for its `from` to
  // know whether it is a re-export (else a local export list: not ours).
  let open: "import" | "export" | null = null;
  let pending: number[] = [];
  const h = header.trim();
  if (JS_IMPORT_OPEN.test(h)) open = "import";
  else if (JS_EXPORT_OPEN.test(h)) open = "export";
  const settle = (as: Mark) => {
    for (const i of pending) marks[i] = as;
    pending = [];
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (open) {
      if (t === "" || t.startsWith("//")) {
        marks.push(t === "" ? "blank" : open === "import" ? "import" : "other");
        if (open === "export") pending.push(i);
        return;
      }
      if (JS_NAME.test(t)) {
        marks.push(open === "import" ? "import" : "other");
        if (open === "export") pending.push(i);
        return;
      }
      if (JS_CLOSE.test(t)) {
        const from = JS_FROM.test(t);
        const kind = open;
        open = null;
        if (kind === "import") {
          marks.push(from ? "import" : "other");
          return;
        }
        marks.push(from ? "reexport" : "other");
        pending.push(i);
        settle(from ? "reexport" : "other");
        return;
      }
      // Not an import's shape: the statement is over (or never was).
      settle("other");
      open = null;
    }
    if (t === "") return void marks.push("blank");
    if (JS_SIDE.test(t)) return void marks.push("side");
    if (JS_IMPORT_ONE.test(t) || JS_REQUIRE.test(t)) return void marks.push("import");
    if (JS_REEXPORT_ONE.test(t)) return void marks.push("reexport");
    if (JS_IMPORT_OPEN.test(t)) {
      open = "import";
      return void marks.push("import");
    }
    if (JS_EXPORT_OPEN.test(t)) {
      open = "export";
      pending = [i];
      return void marks.push("other");
    }
    marks.push("other");
  });
  // An `export {` still open at the hunk's end never showed its `from`.
  settle("other");
  return marks;
}

/* -------------------------------------------------------------- Python */

const PY_IMPORT = /^import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*\s*(?:#.*)?$/;
const PY_FROM_ONE = /^from\s+([\w.]+)\s+import\s+[\w*]+(?:\s+as\s+\w+)?(?:\s*,\s*\w+(?:\s+as\s+\w+)?)*\s*(?:#.*)?$/;
const PY_FROM_OPEN = /^from\s+([\w.]+)\s+import\s*\(\s*(?:#.*)?$/;
const PY_NAME = /^\w+(?:\s+as\s+\w+)?\s*,?\s*(?:#.*)?$/;

function pyMarks(lines: string[], header: string): Mark[] {
  const opened = PY_FROM_OPEN.exec(header.trim());
  let inParens = !!opened && opened[1] !== "__future__";
  return lines.map((line) => {
    const t = line.trim();
    if (inParens) {
      if (t === "") return "blank";
      if (t.startsWith("#") || PY_NAME.test(t)) return "import";
      if (/^\)\s*(?:#.*)?$/.test(t)) {
        inParens = false;
        return "import";
      }
      inParens = false;
      return "other";
    }
    if (t === "") return "blank";
    if (PY_IMPORT.test(t)) return /\b__future__\b/.test(t) ? "side" : "import";
    const one = PY_FROM_ONE.exec(t);
    if (one) return one[1] === "__future__" ? "side" : "import";
    const open = PY_FROM_OPEN.exec(t);
    if (open) {
      if (open[1] === "__future__") return "side";
      inParens = true;
      return "import";
    }
    return "other";
  });
}

/* ---------------------------------------------------------------- hunk */

const MARKERS: Record<Lang, (lines: string[], header: string) => Mark[]> = { go: goMarks, js: jsMarks, py: pyMarks };

/**
 * The hunk's lines as each side of the diff reads them (context plus that
 * side's changes), with which of them changed.
 */
function sides(text: string): { lines: string[]; changed: boolean[] }[] {
  const before = { lines: [] as string[], changed: [] as boolean[] };
  const after = { lines: [] as string[], changed: [] as boolean[] };
  for (const raw of text.split("\n")) {
    const sign = raw[0];
    const body = raw.slice(1);
    // A blank context line can come with its leading space trimmed.
    if (sign === " " || raw === "") {
      before.lines.push(body), before.changed.push(false);
      after.lines.push(body), after.changed.push(false);
    } else if (sign === "-") {
      before.lines.push(body), before.changed.push(true);
    } else if (sign === "+") {
      after.lines.push(body), after.changed.push(true);
    }
    // "\ No newline at end of file" and anything else: not a line of code.
  }
  return [before, after];
}

export function isImportOnlyHunk(path: string, hunk: Pick<Hunk, "header" | "text">): boolean {
  const lang = importLanguage(path);
  if (!lang) return false;
  let substance = 0;
  const [before, after] = sides(hunk.text);
  for (const [side, removed] of [
    [before, true],
    [after, false],
  ] as const) {
    const marks = MARKERS[lang](side.lines, hunk.header);
    for (let i = 0; i < side.lines.length; i++) {
      if (!side.changed[i]) continue;
      const mark = marks[i];
      if (mark === "blank") continue;
      if (mark === "import" || (mark === "reexport" && !removed)) {
        substance++;
        continue;
      }
      return false;
    }
  }
  return substance > 0;
}

/** The label an import hunk gets when the analysis gave it none. */
export const IMPORT_SKIP_LABEL = "only imports";

/** The ids of a revision's import-only hunks. */
export function importOnlyHunkIds(files: FileDiff[]): Set<string> {
  const ids = new Set<string>();
  for (const f of files) for (const h of f.hunks) if (isImportOnlyHunk(f.path, h)) ids.add(h.id);
  return ids;
}

/**
 * A must-read or skim unit's entries with its import-only hunks skipped, as
 * the analysis would have been told to: a heart or a risk on one is the
 * analysis saying it matters, and stays as it is; its own label stays.
 */
export function withImportSkips(entries: HunkEntry[], importOnly: Set<string>): HunkEntry[] {
  return entries.map((e) =>
    e.skip || e.heart || e.risks || !importOnly.has(e.id) ? e : { ...e, skip: true, label: e.label ?? IMPORT_SKIP_LABEL },
  );
}
