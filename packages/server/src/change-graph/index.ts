/**
 * The change map and blast radius experiments: the PR's changed functions,
 * the calls between them, and the code outside the diff that calls them.
 * No model involved: function spans come from language heuristics
 * (functions.ts) over the files at the head, callers from `git grep` in a
 * clone that has the head commit.
 *
 * Answers are cached by head sha (and the units, which the analysis can
 * rewrite without a new commit) for the life of the process.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { isRemovedUnit, loadState, prCheckoutPath, readFilesJson, readMeta, type PrKey } from "@reviewer/core";
import { fileLinesAtHead, toLines } from "../file-content.js";
import { effectiveRepoPath } from "../repo-config.js";
import { callForms, extractFunctions, importsName, isTestPath, moduleName, touchedLines, definitionOnLine, languageOf, pathspecsFor, ungreppable, type Lang } from "./functions.js";
import { buildChangeGraph, type CallEdge, type ChangedFn, type GraphFile, type GraphUnit } from "./graph.js";

export type { CallEdge, ChangedFn } from "./graph.js";

/** Files read at the head at most; a PR beyond that is drawn from its first files. */
const MAX_FILES = 150;
const MAX_NODES = 30;
const SITES_PER_FUNCTION = 15;
const MAX_SITES = 150;
const MAX_GREPPED = 40;

export type Unavailable = { available: false; reason: string };

export type ChangeMapNode = Omit<ChangedFn, "lang" | "end" | "pkg" | "local">;

export type ChangeMap =
  | Unavailable
  | {
      available: true;
      sha: string;
      nodes: ChangeMapNode[];
      edges: CallEdge[];
      /** changed functions found; `total - nodes.length` were left out */
      total: number;
      /** changed files in a language the map cannot read */
      unsupportedFiles: number;
      /** changed files not read at all because the PR has too many */
      unreadFiles: number;
    };

export interface CallSite {
  path: string;
  line: number;
  text: string;
  /** the function the call sits in, when there is one */
  enclosing?: string;
  url: string;
}

export interface CalledFunction {
  id: string;
  name: string;
  qualifier?: string;
  path: string;
  line: number;
  unit?: string;
  /** call sites outside the diff; `sites` holds the first of them */
  total: number;
  sites: CallSite[];
  /**
   * Other changed methods with the same name (on other types): a call
   * `x.name(` cannot say which one it reaches, so they share these sites.
   */
  sameName?: string[];
}

export type BlastRadius =
  | Unavailable
  | {
      available: true;
      sha: string;
      functions: CalledFunction[];
      /** changed functions whose name is too short or too common to grep */
      skipped: { name: string; reason: "too short" | "too common" }[];
      /** changed functions with no caller outside the diff */
      uncalled: number;
      /** changed functions not grepped, past the cap */
      notSearched: number;
      /** changed functions in test files, not searched */
      tests: number;
    };

/* ------------------------------------------------------------ extraction */

interface Extraction {
  sha: string;
  graph: ReturnType<typeof buildChangeGraph>;
  unreadFiles: number;
  /** head lines each changed file added, for leaving the diff's own lines out of callers */
  added: Map<string, Set<number>>;
}

const cache = new Map<string, Promise<Extraction | Unavailable>>();
const CACHE_LIMIT = 30;

function remember<T>(map: Map<string, T>, k: string, v: T) {
  map.set(k, v);
  if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value!);
}

function extract(key: PrKey, root: string): Promise<Extraction | Unavailable> {
  const state = loadState(key, root);
  const sha = state.revisions.find((r) => r.revision === state.currentRevision)?.headSha;
  if (!sha) return Promise.resolve({ available: false, reason: "No head commit is recorded for this revision." });
  const units: GraphUnit[] = state.units
    .filter((u) => u.origin !== "generated" && !isRemovedUnit(u))
    .map((u) => ({ id: u.id, attention: u.attention, hunkIds: u.hunks.map((h) => h.id) }));
  const k = `${root}|${key.host}/${key.owner}/${key.repo}/${key.number}|${sha}|${JSON.stringify(units)}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const p = (async (): Promise<Extraction | Unavailable> => {
    const all = readFilesJson(key, state.currentRevision, root).files.filter((f) => !f.generated && !f.binary);
    const readable = all.filter((f) => languageOf(f.path));
    const toRead = readable.slice(0, MAX_FILES);
    const files: GraphFile[] = [];
    let failed = 0;
    for (const f of toRead) {
      let head: string[] | null = null;
      if (f.status !== "removed") {
        try {
          head = (await fileLinesAtHead(key, f.path, root)).lines;
        } catch {
          failed++;
          continue;
        }
      }
      files.push({ path: f.path, status: f.status, hunks: f.hunks, head });
    }
    if (toRead.length > 0 && failed === toRead.length) {
      return { available: false, reason: "The files at the head could not be read: no checkout has the commit and GitHub did not answer." };
    }
    const graph = buildChangeGraph(
      [...files, ...all.filter((f) => !languageOf(f.path)).map((f) => ({ path: f.path, status: f.status, hunks: [], head: null }))],
      units,
      { maxNodes: MAX_NODES },
    );
    const added = new Map<string, Set<number>>();
    for (const f of all) added.set(f.path, new Set(f.hunks.flatMap((h) => touchedLines(h).added)));
    return { sha, graph, unreadFiles: readable.length - toRead.length + failed, added };
  })();
  remember(cache, k, p);
  // A failure is not remembered: the next request tries again.
  p.then((r) => {
    if (!("graph" in r)) cache.delete(k);
  }, () => cache.delete(k));
  return p;
}

export async function changeMap(key: PrKey, root: string): Promise<ChangeMap> {
  const x = await extract(key, root);
  if (!("graph" in x)) return x;
  const { graph } = x.graph;
  return {
    available: true,
    sha: x.sha,
    nodes: graph.nodes.map(({ lang: _lang, end: _end, pkg: _pkg, local: _local, ...n }) => n),
    edges: graph.edges,
    total: graph.total,
    unsupportedFiles: graph.unsupportedFiles,
    unreadFiles: x.unreadFiles,
  };
}

/* ----------------------------------------------------------- blast radius */

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => {
        // `git grep` exits 1 when nothing matches: an answer, not a failure.
        if (err && (err as { code?: number }).code !== 1) resolve(null);
        else resolve(stdout ?? "");
      },
    );
  });
}

/** A clone that has the head commit: the managed checkout, else the configured repo. */
async function repoWithCommit(key: PrKey, root: string, sha: string): Promise<string | null> {
  const meta = (() => {
    try {
      return readMeta(key, root);
    } catch {
      return null;
    }
  })();
  const candidates = [prCheckoutPath(key, root), effectiveRepoPath(key, root, { meta })].filter(
    (d): d is string => typeof d === "string" && fs.existsSync(d),
  );
  for (const dir of candidates) {
    if ((await git(["cat-file", "-e", `${sha}^{commit}`], dir)) !== null) return dir;
  }
  return null;
}

const grepCache = new Map<string, Promise<{ path: string; line: number; text: string }[] | null>>();

function grep(dir: string, sha: string, name: string, lang: Lang) {
  const k = `${dir}|${sha}|${lang}|${name}`;
  const hit = grepCache.get(k);
  if (hit) return hit;
  const p = git(["grep", "-n", "-z", "-w", "-I", "-F", "-e", name.replace(/^#/, ""), sha, "--", ...pathspecsFor(lang)], dir).then((out) => {
    if (out === null) return null;
    const prefix = `${sha}:`;
    const rows: { path: string; line: number; text: string }[] = [];
    for (const row of out.split("\n")) {
      const [file, line, ...rest] = row.split("\0");
      if (!file || !line) continue;
      rows.push({ path: file.startsWith(prefix) ? file.slice(prefix.length) : file, line: Number(line), text: rest.join("\0") });
    }
    return rows;
  });
  remember(grepCache, k, p);
  return p;
}

/** Up to `limit` items at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function githubBlobUrl(key: PrKey, sha: string, path: string, line: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://${key.host}/${key.owner}/${key.repo}/blob/${sha}/${encoded}#L${line}`;
}

export async function blastRadius(key: PrKey, root: string): Promise<BlastRadius> {
  const x = await extract(key, root);
  if (!("graph" in x)) return x;
  const dir = await repoWithCommit(key, root, x.sha);
  if (!dir) {
    return { available: false, reason: "No local clone has the PR's head commit; set the repo path or run an analysis to make a checkout." };
  }
  return callersOutsideDiff(key, dir, { sha: x.sha, changed: x.graph.all, added: x.added });
}

/**
 * Call sites of the changed (not added, not removed) functions at `sha` in
 * the clone at `dir`, leaving out the diff's own lines and each function's
 * own body.
 */
export async function callersOutsideDiff(
  key: PrKey,
  dir: string,
  x: { sha: string; changed: ChangedFn[]; added: Map<string, Set<number>> },
): Promise<Extract<BlastRadius, { available: true }>> {
  const changed = x.changed.filter((f) => f.status === "changed");
  const tests = changed.filter((f) => isTestPath(f.path)).length;
  const skipped: { name: string; reason: "too short" | "too common" }[] = [];
  // Methods of one name are one search: `x.name(` cannot tell their types apart.
  const groups = new Map<string, ChangedFn[]>();
  for (const f of changed) {
    if (isTestPath(f.path)) continue;
    const why = ungreppable(f.name);
    if (why) {
      if (!skipped.some((s) => s.name === f.name)) skipped.push({ name: f.name, reason: why });
      continue;
    }
    const k = f.qualifier ? `${f.lang}|method|${f.name}` : `${f.lang}|${f.path}|${f.name}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const searchable = [...groups.values()];
  const grepped = searchable.slice(0, MAX_GREPPED);

  const enclosingCache = new Map<string, Promise<{ name: string; qualifier?: string; start: number; end: number }[]>>();
  const functionsIn = (path: string, lang: Lang) => {
    let p = enclosingCache.get(path);
    if (!p) {
      p = git(["show", `${x.sha}:${path}`], dir).then((text) => (text === null ? [] : extractFunctions(toLines(text), lang)));
      enclosingCache.set(path, p);
    }
    return p;
  };

  const found = await mapLimit(grepped, 4, async (group) => {
    const f = group[0];
    const rows = (await grep(dir, x.sha, f.name, f.lang)) ?? [];
    // Files that import the name: where a bare call in another file can reach it.
    const importers = new Set(rows.filter((r) => importsName(r.text, f.name, moduleName(f.path))).map((r) => r.path));
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
    const sites = rows.filter((r) => {
      if (languageOf(r.path) !== f.lang) return false;
      if (group.some((g) => r.path === g.path && r.line >= g.line && r.line <= g.end)) return false;
      if (x.added.get(r.path)?.has(r.line)) return false;
      if (definitionOnLine(r.text, f.lang) === f.name) return false;
      const forms = callForms(r.text, f.name, f.lang, { jsx: /x$/.test(r.path) });
      return forms.some(({ receiver }) => {
        // A method is called on something: `x.name(`, `this.name(`, `self.name(`.
        if (f.qualifier) return receiver !== null;
        if (f.local) return f.lang === "go" ? dirOf(r.path) === dirOf(f.path) && receiver === null : r.path === f.path && receiver === null;
        if (f.lang === "go") {
          return dirOf(r.path) === dirOf(f.path) ? receiver === null : receiver === f.pkg;
        }
        // TS and Python: its own file, or a file that imports it.
        if (r.path === f.path) return receiver === null;
        return importers.has(r.path);
      });
    });
    // Callers in code before callers in tests.
    sites.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)));
    return { group, sites };
  });

  let budget = MAX_SITES;
  const functions: CalledFunction[] = [];
  const withCallers = found.filter((r) => r.sites.length > 0).sort((a, b) => b.sites.length - a.sites.length);
  for (const { group, sites } of withCallers) {
    const f = group[0];
    const shown = sites.slice(0, Math.min(SITES_PER_FUNCTION, Math.max(budget, 0)));
    budget -= shown.length;
    const withEnclosing = await Promise.all(
      shown.map(async (s): Promise<CallSite> => {
        const defs = await functionsIn(s.path, f.lang);
        const around = defs.find((d) => s.line >= d.start && s.line <= d.end);
        return {
          path: s.path,
          line: s.line,
          text: s.text.trim().slice(0, 240),
          ...(around ? { enclosing: around.qualifier ? `${around.qualifier}.${around.name}` : around.name } : {}),
          url: githubBlobUrl(key, x.sha, s.path, s.line),
        };
      }),
    );
    functions.push({
      id: f.id,
      name: f.name,
      ...(f.qualifier ? { qualifier: f.qualifier } : {}),
      path: f.path,
      line: f.line,
      ...(f.unit ? { unit: f.unit } : {}),
      total: sites.length,
      sites: withEnclosing,
      ...(group.length > 1 ? { sameName: group.slice(1).map((g) => (g.qualifier ? `${g.qualifier}.${g.name}` : g.name)) } : {}),
    });
  }
  return {
    available: true,
    sha: x.sha,
    functions,
    skipped,
    uncalled: found.length - withCallers.length,
    notSearched: searchable.length - grepped.length,
    tests,
  };
}
