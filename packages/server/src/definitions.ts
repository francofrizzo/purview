import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { readMeta, type PrKey } from "@reviewer/core";
import { effectiveRepoPath } from "./repo-config.js";
import { prHead } from "./repo-path.js";
import { resolveCheckout } from "./worktree.js";

/**
 * "Go to definition" for the diff viewer.
 *
 * Two tiers, cheapest-first: a `universal-ctags` index when it is on PATH
 * (fast, syntax-aware-ish, works across languages ctags knows), falling back
 * to a heuristic `git grep` when it isn't. Neither is a real language server —
 * this is a hint for the reader, not an IDE, so both tiers are allowed to be
 * wrong or to miss a definition entirely.
 */

const SNIPPET_RADIUS = 7; // ~15 lines total, centered on the definition
const MAX_CANDIDATES = 20;
/** Above this many tags, the index costs more than it's worth — fall back to grep. */
const MAX_TAGS = 200_000;

const execFileAsync = promisify(execFile);

/**
 * Async on purpose: the ctags index of a big checkout can take seconds, and a
 * sync spawn there would stall every other request (chat streams included)
 * for the duration.
 */
async function run(cmd: string, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------- ctags --- */

/**
 * BSD ctags (macOS's built-in `/usr/bin/ctags`) answers `--version` with a
 * usage error, not a version banner, so the only reliable signal is the
 * banner's own wording — hence the substring check rather than an exit-code
 * check.
 */
let ctagsAvailableCache: boolean | null = null;

export async function isUniversalCtagsAvailable(): Promise<boolean> {
  if (ctagsAvailableCache !== null) return ctagsAvailableCache;
  const out = await run("ctags", ["--version"], process.cwd());
  ctagsAvailableCache = Boolean(out && out.includes("Universal Ctags"));
  return ctagsAvailableCache;
}

/** Test hook: forget the cached answer (PATH can change between tests). */
export function resetCtagsAvailabilityCache(): void {
  ctagsAvailableCache = null;
}

export interface CtagsEntry {
  name: string;
  /** repo-relative */
  path: string;
  /** 1-based */
  line: number;
  kind?: string;
}

/**
 * Parses `ctags --output-format=json`'s output: one JSON object per line, the
 * last of which is a summary object (`_type: "ctags"`) rather than a tag.
 * Malformed or non-tag lines are skipped rather than failing the whole parse —
 * a single odd entry in a 50k-line index must not lose the rest of it.
 */
export function parseCtagsJson(output: string): CtagsEntry[] {
  const entries: CtagsEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;
    if (o._type !== "tag") continue;
    if (typeof o.name !== "string" || typeof o.path !== "string" || typeof o.line !== "number") {
      continue;
    }
    entries.push({
      name: o.name,
      // ctags emits paths as given on the command line; `-R .` yields a
      // leading `./` we don't want to carry into the repo-relative path.
      path: o.path.replace(/^\.\//, ""),
      line: o.line,
      kind: typeof o.kind === "string" ? o.kind : undefined,
    });
  }
  return entries;
}

/** name -> every tag with that name, in the order ctags emitted them. */
export function buildTagIndex(entries: CtagsEntry[]): Map<string, CtagsEntry[]> {
  const index = new Map<string, CtagsEntry[]>();
  for (const entry of entries) {
    const list = index.get(entry.name);
    if (list) list.push(entry);
    else index.set(entry.name, [entry]);
  }
  return index;
}

const CTAGS_EXCLUDES = [".git", "node_modules", "vendor", "dist", "build"];

interface CachedIndex {
  headSha: string;
  index: Map<string, CtagsEntry[]>;
}

/**
 * Keyed by checkout dir, refreshed whenever HEAD moves. `git rev-parse HEAD`
 * is cheap enough to call on every lookup, so this stays correct without a
 * file watcher or a TTL.
 */
const indexCache = new Map<string, CachedIndex>();

async function headShaOf(checkoutDir: string): Promise<string> {
  return (await run("git", ["rev-parse", "HEAD"], checkoutDir))?.trim() ?? "";
}

/** Test hook: drop every cached index (a fresh checkout dir per test avoids
 *  needing this in practice, but it keeps suites independent regardless). */
export function clearDefinitionIndexCache(): void {
  indexCache.clear();
}

/** Builds (or reuses) the ctags index for a checkout. `null` means "give up,
 *  use the grep fallback instead" — either ctags itself failed, or the repo
 *  is too big to index defensively. */
async function ctagsIndexFor(checkoutDir: string): Promise<Map<string, CtagsEntry[]> | null> {
  const headSha = await headShaOf(checkoutDir);
  const cached = indexCache.get(checkoutDir);
  if (cached && cached.headSha === headSha) return cached.index;

  // --fields=+n is not on by default; without it the JSON output carries no
  // line number at all, which is the one field this whole index exists for.
  const args = ["--output-format=json", "--fields=+n", "-R"];
  for (const exclude of CTAGS_EXCLUDES) args.push(`--exclude=${exclude}`);
  args.push(".");
  const out = await run("ctags", args, checkoutDir);
  if (out === undefined) return null;
  const entries = parseCtagsJson(out);
  if (entries.length > MAX_TAGS) return null;
  const index = buildTagIndex(entries);
  indexCache.set(checkoutDir, { headSha, index });
  return index;
}

/* -------------------------------------------------------- grep fallback --- */

/**
 * Heuristic definition patterns, one per rough shape a definition takes in a
 * common language. This is NOT a parser — no attempt is made to be exact — it
 * exists purely so a checkout without `universal-ctags` still gets *something*.
 * `NAME` is substituted with the (regex-escaped) symbol before use.
 *
 * Notably absent: Go's `x := foo()` short variable declaration, which reads
 * exactly like a definition of `x` but almost always isn't the definition a
 * reader means when they cmd+click a call site.
 */
export const DEFINITION_GREP_PATTERNS: string[] = [
  String.raw`^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s+NAME\b`, // js/ts
  String.raw`^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+NAME\b`, // js/ts/java/c#/php
  String.raw`^\s*(export\s+)?(type|interface)\s+NAME\b`, // ts
  String.raw`^\s*(export\s+)?(const|let|var)\s+NAME\s*[:=]`, // js/ts
  String.raw`^\s*def\s+NAME\b`, // python/ruby
  String.raw`^\s*class\s+NAME\b`, // python/ruby
  String.raw`^\s*func\s*(\([^)]*\))?\s*NAME\b`, // go (incl. method receivers)
  String.raw`^\s*type\s+NAME\s`, // go
  String.raw`^\s*fn\s+NAME\b`, // rust
  String.raw`^\s*struct\s+NAME\b`, // rust/c/c++
  String.raw`^\s*enum\s+NAME\b`, // rust/java/c#/c++
  // java/c#/c++ method — the char classes are spelled out (no \w/\s inside
  // brackets) so toPosixEre() below stays a trivial substitution.
  String.raw`^\s*(public|private|protected|internal|static|final|\s)+[A-Za-z0-9_<>[\],. \t]+\bNAME\s*\(`,
];

/**
 * `git grep -E` is POSIX ERE, where `\s`/`\b`/`\w` are NOT special — on
 * macOS they match nothing at all, which silently zeroed out every fallback
 * lookup. The patterns above stay in PCRE-ish form because the tests compile
 * them as JS RegExp; this translates them right before they reach git grep.
 * `\b` only ever appears against the NAME placeholder, so the two boundary
 * substitutions below cover every use.
 */
export function toPosixEre(pattern: string): string {
  return pattern
    .replace(/NAME\\b/g, "NAME([^[:alnum:]_]|$)")
    .replace(/\\bNAME/g, "(^|[^[:alnum:]_])NAME")
    .replace(/\\s/g, "[[:space:]]")
    .replace(/\\w/g, "[[:alnum:]_]");
}

function grepPatternsFor(symbol: string): string[] {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return DEFINITION_GREP_PATTERNS.map((p) => toPosixEre(p).replace(/NAME/g, escaped));
}

export interface GrepHit {
  /** repo-relative */
  path: string;
  /** 1-based */
  line: number;
  lineText: string;
}

/**
 * Parses `git grep -n` output (`path:line:content`, one hit per line). Splits
 * on the first two colons only, so a `:` inside `content` (routes, ratios,
 * time literals) is never mistaken for a field separator.
 */
export function parseGitGrepOutput(output: string): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const raw of output.split("\n")) {
    if (!raw) continue;
    const first = raw.indexOf(":");
    if (first === -1) continue;
    const second = raw.indexOf(":", first + 1);
    if (second === -1) continue;
    const filePath = raw.slice(0, first);
    const line = Number(raw.slice(first + 1, second));
    if (!filePath || !Number.isFinite(line) || line <= 0) continue;
    hits.push({ path: filePath, line, lineText: raw.slice(second + 1) });
  }
  return hits;
}

/** Exported for tests: the e2e coverage must exercise this engine even on a
 *  machine that has universal-ctags installed. */
export async function grepFallback(checkoutDir: string, symbol: string): Promise<GrepHit[]> {
  const args = ["grep", "-n", "-E", "--no-color"];
  for (const pattern of grepPatternsFor(symbol)) args.push("-e", pattern);
  const out = await run("git", args, checkoutDir);
  if (out === undefined) return [];
  return parseGitGrepOutput(out);
}

/* ------------------------------------------------------------- snippets --- */

export interface DefinitionSnippet {
  /** 1-based */
  startLine: number;
  lines: string[];
}

/** ~15 lines of context around `centerLine`, clamped to the file's bounds. */
function readSnippet(absPath: string, centerLine: number): DefinitionSnippet | null {
  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n");
  const startLine = Math.max(1, centerLine - SNIPPET_RADIUS);
  const endLine = Math.min(lines.length, centerLine + SNIPPET_RADIUS);
  return { startLine, lines: lines.slice(startLine - 1, endLine) };
}

/* -------------------------------------------------------------- lookup --- */

export interface DefinitionCandidate {
  /** repo-relative */
  path: string;
  absPath: string;
  /** 1-based */
  line: number;
  kind?: string;
  /** one-line signature/source text at the definition, when known */
  signature?: string;
  snippet: DefinitionSnippet;
}

export type DefinitionResult =
  | { checkout: false; reason: string }
  | { checkout: true; engine: "ctags" | "grep"; candidates: DefinitionCandidate[] };

/**
 * Resolve candidate definitions for `symbol` in the PR's local checkout. The
 * checkout's HEAD may not be the PR's exact head commit — see worktree.ts —
 * so this is a hint, not a precise IDE-grade lookup: we never check out the
 * PR's commit to make it exact.
 */
export async function resolveDefinition(
  key: PrKey,
  symbol: string,
  root: string,
): Promise<DefinitionResult> {
  const meta = readMeta(key, root);
  const checkout = resolveCheckout(effectiveRepoPath(key, root, { meta }), prHead(key, root));
  if (!checkout.path) {
    return {
      checkout: false,
      reason: checkout.error ?? "No local checkout configured for this repo.",
    };
  }
  const checkoutDir = checkout.path;

  let hits: { path: string; line: number; kind?: string; signature?: string }[];
  const useCtags = await isUniversalCtagsAvailable();
  const index = useCtags ? await ctagsIndexFor(checkoutDir) : null;
  if (index) {
    hits = (index.get(symbol) ?? []).map((e) => ({ path: e.path, line: e.line, kind: e.kind }));
  } else {
    hits = (await grepFallback(checkoutDir, symbol)).map((h) => ({
      path: h.path,
      line: h.line,
      signature: h.lineText.trim(),
    }));
  }

  const candidates: DefinitionCandidate[] = [];
  for (const hit of hits) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const absPath = path.join(checkoutDir, hit.path);
    const snippet = readSnippet(absPath, hit.line);
    if (!snippet) continue; // the file ctags/grep saw is gone or unreadable now
    candidates.push({
      path: hit.path,
      absPath,
      line: hit.line,
      kind: hit.kind,
      signature: hit.signature ?? snippet.lines[hit.line - snippet.startLine]?.trim(),
      snippet,
    });
  }
  return { checkout: true, engine: index ? "ctags" : "grep", candidates };
}
