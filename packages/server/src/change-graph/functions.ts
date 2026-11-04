/**
 * Functions in source text, found by language heuristics rather than a
 * parser: Go, TypeScript/JavaScript and Python. Enough to say which
 * functions a diff touches and which of them call each other; it is not a
 * type checker, so a call is a name followed by `(`, nothing more.
 *
 * Only top-level functions and class members count (Go methods, TS class
 * methods and field arrows, Python methods). Closures and nested defs belong
 * to the function around them: as nodes of their own they would only add
 * noise to a map of what changed.
 *
 * Everything here is pure, line numbers are 1-based.
 */

export type Lang = "go" | "ts" | "py";

const EXT: Record<string, Lang> = {
  go: "go",
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "py",
};

export function languageOf(path: string): Lang | null {
  const m = /\.([A-Za-z]+)$/.exec(path);
  return m ? (EXT[m[1].toLowerCase()] ?? null) : null;
}

/** git pathspecs for the files of one language, for `git grep`. */
export function pathspecsFor(lang: Lang): string[] {
  return Object.entries(EXT)
    .filter(([, l]) => l === lang)
    .map(([ext]) => `*.${ext}`);
}

export interface FnDef {
  name: string;
  /** the class (TS, Python) or receiver type (Go) a method belongs to */
  qualifier?: string;
  start: number;
  end: number;
}

/* -------------------------------------------------------------- stripping */

type Mode = { kind: "code" } | { kind: "block" } | { kind: "str"; close: string; multi: boolean; escapes: boolean };

/**
 * The lines with comments blanked and string contents replaced by spaces,
 * each line keeping its length (so columns still line up with the source).
 * Braces, parens and names inside strings and comments stop counting.
 * Template literals are strings whole, `${}` included; regex literals are
 * not recognised.
 */
export function stripCode(lines: string[], lang: Lang): string[] {
  let mode: Mode = { kind: "code" };
  const out: string[] = [];
  const lineComment = lang === "py" ? "#" : "//";
  for (const line of lines) {
    let o = "";
    let i = 0;
    // A line that opens inside a string is all string up to its close: its
    // closing quote must not read as code at column 0 (Python's indentation).
    const continued = mode.kind === "str";
    while (i < line.length) {
      const ch = line[i];
      if (mode.kind === "block") {
        if (line.startsWith("*/", i)) {
          o += "  ";
          i += 2;
          mode = { kind: "code" };
        } else {
          o += " ";
          i++;
        }
        continue;
      }
      if (mode.kind === "str") {
        if (mode.escapes && ch === "\\") {
          o += i + 1 < line.length ? "  " : " ";
          i += 2;
          continue;
        }
        if (line.startsWith(mode.close, i)) {
          o += continued && o.trim() === "" ? " ".repeat(mode.close.length) : mode.close;
          i += mode.close.length;
          mode = { kind: "code" };
          continue;
        }
        o += " ";
        i++;
        continue;
      }
      if (line.startsWith(lineComment, i)) {
        o += " ".repeat(line.length - i);
        break;
      }
      if (lang !== "py" && line.startsWith("/*", i)) {
        o += "  ";
        i += 2;
        mode = { kind: "block" };
        continue;
      }
      if (lang === "py" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        const q = line.slice(i, i + 3);
        o += q;
        i += 3;
        mode = { kind: "str", close: q, multi: true, escapes: true };
        continue;
      }
      if (ch === '"' || ch === "'") {
        o += ch;
        i++;
        mode = { kind: "str", close: ch, multi: false, escapes: true };
        continue;
      }
      if (ch === "`" && lang !== "py") {
        o += ch;
        i++;
        // Go's raw strings have no escapes; TS template literals do.
        mode = { kind: "str", close: "`", multi: true, escapes: lang === "ts" };
        continue;
      }
      o += ch;
      i++;
    }
    out.push(o);
    if (mode.kind === "str" && !mode.multi) mode = { kind: "code" };
  }
  return out;
}

/* --------------------------------------------------------- brace matching */

interface Pos {
  line: number; // 0-based index into the stripped lines
  col: number;
}

/** The 0-based line holding the `}` that closes the `{` at `open`; the last line when unmatched. */
function matchBrace(s: string[], open: Pos): number {
  let depth = 0;
  for (let l = open.line; l < s.length; l++) {
    const text = s[l];
    for (let c = l === open.line ? open.col : 0; c < text.length; c++) {
      if (text[c] === "{") depth++;
      else if (text[c] === "}") {
        depth--;
        if (depth === 0) return l;
      }
    }
  }
  return s.length - 1;
}

/** The position after the matching close of the `{` at `open`. */
function afterBrace(s: string[], open: Pos): Pos {
  let depth = 0;
  for (let l = open.line; l < s.length; l++) {
    const text = s[l];
    for (let c = l === open.line ? open.col : 0; c < text.length; c++) {
      if (text[c] === "{") depth++;
      else if (text[c] === "}") {
        depth--;
        if (depth === 0) return { line: l, col: c + 1 };
      }
    }
  }
  return { line: s.length, col: 0 };
}

/** The last non-space character before `p` on the signature, or "" */
function prevChar(s: string[], p: Pos, from: Pos): string {
  for (let l = p.line; l >= from.line; l--) {
    const text = s[l];
    for (let c = l === p.line ? p.col - 1 : text.length - 1; c >= (l === from.line ? from.col : 0); c--) {
      if (!/\s/.test(text[c])) return text[c];
    }
  }
  return "";
}

const SIGNATURE_LINES = 30;

/**
 * The `{` that opens a function's body, scanning from just after its name:
 * past the parameter list and any return type. A `;` before it (an overload,
 * an interface method, an abstract method) means there is no body. Go skips
 * `struct{…}`/`interface{…}` in signatures; TS skips object types after `:`.
 */
function findBodyOpen(s: string[], from: Pos, lang: Lang): Pos | null {
  let paren = 0;
  let seenParams = false;
  for (let l = from.line; l < Math.min(s.length, from.line + SIGNATURE_LINES); l++) {
    const text = s[l];
    for (let c = l === from.line ? from.col : 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === "(" || ch === "[") paren++;
      else if (ch === ")" || ch === "]") {
        paren--;
        if (paren === 0 && ch === ")") seenParams = true;
      } else if (ch === ";" && paren === 0) return null;
      else if (ch === "=" && text[c + 1] === ">" && paren === 0 && lang === "ts") return null;
      else if (ch === "{" && paren === 0) {
        const here = { line: l, col: c };
        let isType = false;
        if (lang === "go") isType = /(?:struct|interface)\s*$/.test(text.slice(0, c));
        else isType = !seenParams || /[:|&<,(=]/.test(prevChar(s, here, from));
        if (!isType) return here;
        const after = afterBrace(s, here);
        if (after.line >= s.length) return null;
        // Resume after the type literal.
        l = after.line;
        c = after.col - 1;
        continue;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------- TS / JavaScript */

const TS_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "with", "else", "do", "try",
  "new", "typeof", "await", "yield", "delete", "void", "throw", "case", "super", "import", "export",
]);
const ID = "[A-Za-z_$][\\w$]*";
const TS_FUNCTION = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`);
const TS_CONST = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*`);
const TS_CLASS = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`);
const TS_MODIFIERS = "(?:(?:public|private|protected|static|async|override|abstract|readonly|declare|get|set)\\s+)*";
const TS_METHOD = new RegExp(`^\\s*${TS_MODIFIERS}\\*?\\s*(#?${ID})\\s*\\??\\s*(?:<[^>]*>)?\\s*\\(`);
const TS_FIELD = new RegExp(`^\\s*${TS_MODIFIERS}(#?${ID})\\s*(?::[^=]+)?=\\s*`);

/**
 * From just after `=` (an initializer), the arrow's `=>` or a `function`
 * keyword: the position to look for the body from, or null when the value
 * is not a function.
 */
function functionValue(s: string[], from: Pos): { body: Pos; arrow: boolean } | null {
  const rest = s[from.line].slice(from.col);
  const fn = /^\s*(?:async\s+)?function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?/.exec(rest);
  if (fn) return { body: { line: from.line, col: from.col + fn[0].length }, arrow: false };
  const bare = /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.exec(rest);
  if (bare) return { body: { line: from.line, col: from.col + bare[0].length }, arrow: true };
  const head = /^\s*(?:async\s+)?(?:<[^>]*>\s*)?\(/.exec(rest);
  if (!head) return null;
  // Balanced parameter list, then an optional return type, then `=>`.
  let depth = 0;
  let closed = false;
  for (let l = from.line; l < Math.min(s.length, from.line + SIGNATURE_LINES); l++) {
    const text = s[l];
    for (let c = l === from.line ? from.col + head[0].length - 1 : 0; c < text.length; c++) {
      const ch = text[c];
      if (!closed) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) closed = true;
        }
        continue;
      }
      if (ch === "=" && text[c + 1] === ">" && depth === 0) return { body: { line: l, col: c + 2 }, arrow: true };
      if (/\s/.test(ch)) continue;
      if (depth === 0 && (ch === ";" || ch === "," || (ch === "=" && text[c + 1] !== ">"))) return null;
      if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
      else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
      else if (depth === 0 && ch !== ":" && !/[\w$.|&?]/.test(ch)) return null;
    }
  }
  return null;
}

/** The last line of an arrow function, body braced or not. */
function arrowEnd(s: string[], body: Pos, startIndent: number): number {
  let l = body.line;
  let c = body.col;
  while (l < s.length) {
    const rest = s[l].slice(c);
    const m = /\S/.exec(rest);
    if (m) {
      if (rest[m.index] === "{") return matchBrace(s, { line: l, col: c + m.index });
      break;
    }
    l++;
    c = 0;
  }
  // An expression body: ends where the brackets balance and the statement does.
  let depth = 0;
  for (let k = body.line; k < s.length; k++) {
    const text = s[k];
    for (let x = k === body.line ? body.col : 0; x < text.length; x++) {
      const ch = text[x];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0) {
      const trimmed = text.trimEnd();
      if (trimmed.endsWith(";") || trimmed.endsWith(",")) return k;
      const next = s.slice(k + 1).find((t) => t.trim() !== "");
      if (next === undefined || indentOf(next) <= startIndent) return k;
    }
  }
  return s.length - 1;
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

function tsFunctions(s: string[]): FnDef[] {
  // Brace depth at the start of each line.
  const depth: number[] = [];
  let d = 0;
  for (const text of s) {
    depth.push(d);
    for (const ch of text) {
      if (ch === "{") d++;
      else if (ch === "}") d--;
    }
  }
  // Class bodies: [open line, close line, depth inside, name].
  const classes: { from: number; to: number; inner: number; name: string }[] = [];
  for (let i = 0; i < s.length; i++) {
    const m = TS_CLASS.exec(s[i]);
    if (!m) continue;
    const open = findClassOpen(s, i);
    if (!open) continue;
    classes.push({ from: open.line, to: matchBrace(s, open), inner: depthAt(s, depth, open) + 1, name: m[1] });
  }
  const classAt = (i: number) =>
    classes.find((k) => i > k.from && i <= k.to && depth[i] === k.inner && !/^\s*}/.test(s[i]));

  const out: FnDef[] = [];
  for (let i = 0; i < s.length; i++) {
    const text = s[i];
    const indent = indentOf(text);
    const owner = classAt(i);
    if (depth[i] === 0) {
      const fn = TS_FUNCTION.exec(text);
      if (fn) {
        const open = findBodyOpen(s, { line: i, col: fn[0].length }, "ts");
        if (open) {
          const end = matchBrace(s, open);
          out.push({ name: fn[1], start: i + 1, end: end + 1 });
          i = end;
        }
        continue;
      }
      const cst = TS_CONST.exec(text);
      if (cst) {
        const value = functionValue(s, { line: i, col: cst[0].length });
        if (value) {
          const end = value.arrow ? arrowEnd(s, value.body, indent) : matchOrNull(s, value.body);
          if (end !== null) {
            out.push({ name: cst[1], start: i + 1, end: end + 1 });
            i = end;
          }
        }
        continue;
      }
    }
    if (owner) {
      const field = TS_FIELD.exec(text);
      if (field && !TS_KEYWORDS.has(field[1])) {
        const value = functionValue(s, { line: i, col: field[0].length });
        if (value) {
          const end = value.arrow ? arrowEnd(s, value.body, indent) : matchOrNull(s, value.body);
          if (end !== null) {
            out.push({ name: field[1], qualifier: owner.name, start: i + 1, end: end + 1 });
            i = end;
          }
          continue;
        }
      }
      const method = TS_METHOD.exec(text);
      if (method && !TS_KEYWORDS.has(method[1])) {
        const open = findBodyOpen(s, { line: i, col: method[0].length - 1 }, "ts");
        if (open) {
          const end = matchBrace(s, open);
          out.push({ name: method[1], qualifier: owner.name, start: i + 1, end: end + 1 });
          i = end;
        }
        continue;
      }
    } else if (depth[i] > 0) {
      // An object-literal method (`name(args) {` on one line): a call can
      // never be followed by a block, so this shape is a definition.
      const method = TS_METHOD.exec(text);
      if (method && !TS_KEYWORDS.has(method[1]) && /\)\s*(?::[^=;]*)?\{\s*$/.test(text) && !text.includes("=>") && depth[i] === 1) {
        const open = findBodyOpen(s, { line: i, col: method[0].length - 1 }, "ts");
        if (open && open.line === i) {
          const end = matchBrace(s, open);
          out.push({ name: method[1], start: i + 1, end: end + 1 });
          i = end;
        }
      }
    }
  }
  return out;
}

function depthAt(s: string[], depth: number[], p: Pos): number {
  let d = depth[p.line];
  for (let c = 0; c < p.col; c++) {
    if (s[p.line][c] === "{") d++;
    else if (s[p.line][c] === "}") d--;
  }
  return d;
}

function findClassOpen(s: string[], line: number): Pos | null {
  for (let l = line; l < Math.min(s.length, line + SIGNATURE_LINES); l++) {
    const c = s[l].indexOf("{");
    if (c >= 0) return { line: l, col: c };
    if (s[l].includes(";")) return null;
  }
  return null;
}

function matchOrNull(s: string[], from: Pos): number | null {
  const open = findBodyOpen(s, from, "ts");
  return open ? matchBrace(s, open) : null;
}

/* --------------------------------------------------------------------- Go */

const GO_FUNC = /^func\s*(?:\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*(?=[[(])/;

function goFunctions(s: string[]): FnDef[] {
  const out: FnDef[] = [];
  for (let i = 0; i < s.length; i++) {
    const m = GO_FUNC.exec(s[i]);
    if (!m) continue;
    const open = findBodyOpen(s, { line: i, col: m[0].length }, "go");
    if (!open) continue;
    const end = matchBrace(s, open);
    out.push({ name: m[2], ...(m[1] ? { qualifier: m[1] } : {}), start: i + 1, end: end + 1 });
    i = end;
  }
  return out;
}

/* ----------------------------------------------------------------- Python */

const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;

function pyFunctions(s: string[]): FnDef[] {
  const out: FnDef[] = [];
  const blank = (t: string) => t.trim() === "";
  for (let i = 0; i < s.length; i++) {
    const m = PY_DEF.exec(s[i]);
    if (!m) continue;
    const indent = m[1].length;
    let qualifier: string | undefined;
    if (indent > 0) {
      // The block it sits in: the nearest earlier line indented less.
      let k = i - 1;
      while (k >= 0 && (blank(s[k]) || indentOf(s[k]) >= indent)) k--;
      const cls = k >= 0 ? PY_CLASS.exec(s[k]) : null;
      if (!cls) continue; // a nested def belongs to its function
      qualifier = cls[2];
    }
    // The signature may span lines; it ends at the `:` with the parens closed.
    let depth = 0;
    let sigEnd = i;
    let inline = false;
    outer: for (let l = i; l < Math.min(s.length, i + SIGNATURE_LINES); l++) {
      const text = s[l];
      for (let c = l === i ? m[0].length - 1 : 0; c < text.length; c++) {
        const ch = text[c];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === ":" && depth === 0) {
          sigEnd = l;
          inline = text.slice(c + 1).trim() !== "";
          break outer;
        }
      }
    }
    let end = sigEnd;
    if (!inline) {
      for (let l = sigEnd + 1; l < s.length; l++) {
        if (blank(s[l])) continue;
        if (indentOf(s[l]) <= indent) break;
        end = l;
      }
    }
    out.push({ name: m[2], ...(qualifier ? { qualifier } : {}), start: i + 1, end: end + 1 });
    i = end;
  }
  return out;
}

/* ------------------------------------------------------------------ entry */

/** The top-level functions and methods in a file, with their spans. */
export function extractFunctions(lines: string[], lang: Lang): FnDef[] {
  const s = stripCode(lines, lang);
  if (lang === "go") return goFunctions(s);
  if (lang === "py") return pyFunctions(s);
  return tsFunctions(s);
}

/**
 * The name a single line defines, if it reads like a function definition on
 * its own: what a removed line of a diff can tell without its file around it.
 */
export function definitionOnLine(line: string, lang: Lang): string | null {
  const s = stripCode([line], lang)[0];
  if (lang === "go") return GO_FUNC.exec(s)?.[2] ?? null;
  if (lang === "py") return PY_DEF.exec(s)?.[2] ?? null;
  const fn = TS_FUNCTION.exec(s);
  if (fn) return fn[1];
  const cst = TS_CONST.exec(s);
  if (cst && /^\s*(?:async\s+)?(?:function\b|[A-Za-z_$][\w$]*\s*=>|(?:<[^>]*>\s*)?\([^)]*\)\s*(?::[^=]+)?=>)/.test(s.slice(cst[0].length))) return cst[1];
  const method = TS_METHOD.exec(s);
  if (method && !TS_KEYWORDS.has(method[1]) && /^\s+/.test(s) && /\)\s*(?::[^=;]*)?\{\s*$/.test(s) && !s.includes("=>")) return method[1];
  return null;
}

const CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:<[\w$.,\s[\]]*>|\[[\w$.,\s*]*\])?\s*\(/g;

const JSX = /<([A-Z][\w$]*)(?=[\s/>]|$)/g;

/**
 * Every name called in the stripped lines `from..to` (1-based, inclusive),
 * with how many times: `name(`, `.name(`, `name<T>(` and Go's `name[T](`;
 * with `jsx`, a component rendered as `<Name` counts as a call too.
 */
export function callsIn(stripped: string[], from: number, to: number, opts: { jsx?: boolean } = {}): Map<string, number> {
  const out = new Map<string, number>();
  for (let l = from - 1; l < Math.min(to, stripped.length); l++) {
    for (const m of stripped[l].matchAll(CALL)) out.set(m[1], (out.get(m[1]) ?? 0) + 1);
    if (opts.jsx) for (const m of stripped[l].matchAll(JSX)) out.set(m[1], (out.get(m[1]) ?? 0) + 1);
  }
  return out;
}

/** Whether a path holds tests, by the usual names. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^/]*\.py$/.test(path);
}

/**
 * Each call of `name` on one source line (comments and strings ignored),
 * with what it is called on: `null` for a bare `name(`, the identifier
 * before the dot for `x.name(`, "" for a longer expression (`a().name(`).
 */
export function callForms(line: string, name: string, lang: Lang, opts: { jsx?: boolean } = {}): { receiver: string | null }[] {
  const s = stripCode([line], lang)[0];
  const out: { receiver: string | null }[] = [];
  for (const m of s.matchAll(CALL)) {
    if (m[1] !== name) continue;
    const before = s.slice(0, m.index).trimEnd();
    if (!before.endsWith(".") || before.endsWith("..")) out.push({ receiver: null });
    else out.push({ receiver: /([A-Za-z_$][\w$]*)\s*\.$/.exec(before)?.[1] ?? "" });
  }
  if (opts.jsx) for (const m of s.matchAll(JSX)) if (m[1] === name) out.push({ receiver: null });
  return out;
}

/** Whether one source line calls `name` (comments and strings ignored). */
export function lineCalls(line: string, name: string, lang: Lang, opts: { jsx?: boolean } = {}): boolean {
  return callForms(line, name, lang, opts).length > 0;
}

/**
 * Whether a line found by grepping for `name` is part of an import of it:
 * `import { name } from "./module"`, `from pkg.module import name`, or a lone
 * `name,` inside a multi-line import list. With `module` (the defining
 * file's name without extension), an import line must name that module, so
 * `import { describe } from "vitest"` does not count for a local `describe`.
 */
export function importsName(line: string, name: string, module?: string): boolean {
  const t = line.trim();
  if (/^(?:import\b|from\b|export\s*[{*])|\brequire\(/.test(t)) {
    if (!module) return true;
    const from = /(?:from|require\(|import)\s*['"]([^'"]+)['"]/.exec(t)?.[1] ?? /^from\s+([\w.]+)\s+import\b/.exec(t)?.[1];
    if (!from) return true;
    const last = from.split(/[/.]/).filter(Boolean).pop() ?? "";
    return last === module || from.endsWith(`/${module}`);
  }
  return new RegExp(`^(?:type\\s+)?${name.replace(/\$/g, "\\$")}(?:\\s+as\\s+[\\w$]+)?\\s*,?$`).test(t);
}

/** What an import of a file names it by: its name without extension, or its directory for an index file. */
export function moduleName(path: string): string {
  const parts = path.split("/");
  const base = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  return (base === "index" || base === "__init__") && parts.length > 1 ? parts[parts.length - 2] : base;
}

/* ------------------------------------------------------------------ hunks */

/** What a hunk did at the head: lines it added, and where it deleted lines (before head line n). */
export function touchedLines(hunk: { newStart: number; newLines: number; oldStart: number; text: string }): {
  added: number[];
  deletedBefore: number[];
  /** each removed line's text with its line number in the old file */
  removed: { line: number; text: string }[];
} {
  let n = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  let o = hunk.oldStart === 0 ? 1 : hunk.oldStart;
  const added: number[] = [];
  const deletedBefore: number[] = [];
  const removed: { line: number; text: string }[] = [];
  const body = hunk.text.replace(/^@@[^\n]*\n/, "");
  for (const raw of body.split("\n")) {
    if (raw === "" || raw.startsWith("\\")) continue;
    const mark = raw[0];
    if (mark === "+") {
      added.push(n);
      n++;
    } else if (mark === "-") {
      deletedBefore.push(n);
      removed.push({ line: o, text: raw.slice(1) });
      o++;
    } else {
      n++;
      o++;
    }
  }
  return { added, deletedBefore, removed };
}

/* -------------------------------------------------------- generic names */

/**
 * Names too short or too common to grep for: every file has a `get(` or a
 * `String(`, so their callers would be noise.
 */
const COMMON = new Set(
  [
    "new", "get", "set", "init", "main", "run", "close", "open", "read", "write", "call", "apply", "bind",
    "then", "catch", "push", "pop", "map", "filter", "reduce", "forEach", "find", "some", "every", "join",
    "split", "slice", "toString", "valueOf", "toJSON", "render", "update", "delete", "remove", "create",
    "handle", "handler", "start", "stop", "reset", "load", "save", "parse", "format", "print", "log",
    "test", "setup", "teardown", "next", "done", "emit", "send", "fetch", "process", "execute",
    "validate", "build", "make", "clone", "copy", "equals", "hash", "keys", "values", "items", "size",
    "length", "default", "value", "error", "string", "constructor", "Error", "String", "Close", "Read",
    "Write", "Run", "Get", "Set", "Init", "Start", "Stop", "Len", "Less", "Swap", "New", "Reset",
    "Handle", "ServeHTTP", "Validate", "Name", "Type", "Equal", "Unwrap", "Is", "As",
    "SetupTest", "SetupSuite", "TearDownTest", "TearDownSuite", "SetupSubTest", "setUp", "tearDown",
  ].map((n) => n.toLowerCase()),
);

/** Why a name is not worth grepping for, or null when it is. */
export function ungreppable(name: string): "too short" | "too common" | null {
  const bare = name.replace(/^#/, "");
  if (/^__\w+__$/.test(bare)) return "too common";
  if (bare.length < 4) return "too short";
  if (COMMON.has(bare.toLowerCase())) return "too common";
  return null;
}
