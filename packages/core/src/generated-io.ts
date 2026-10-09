import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  MARKER_LINES,
  annotateGenerated,
  classifyGenerated,
  generatedFilesOf,
  markerCandidates,
  markerIn,
  markersFromHunks,
  sameGeneratedFiles,
  withGeneratedOverride,
  type GeneratedFacts,
} from "./generated.js";
import { fetchFileHeads, fetchGitattributes } from "./github.js";
import { prCheckoutPath, repoKeyOf, stateRoot, type PrKey, type RepoKey } from "./paths.js";
import {
  appendEvent,
  listPrs,
  loadState,
  readFilesJson,
  readGeneratedFacts,
  readMeta,
  readRepoConfig,
  rewriteFilesJson,
  writeGeneratedFacts,
  writeRepoConfig,
} from "./store.js";
import type { FileDiff, GeneratedFile, State } from "./schemas.js";

/**
 * The I/O half of generated-file detection (see generated.ts): reading the
 * facts once per revision, and re-classifying a recorded revision when the
 * repo settings change.
 */

/** Never read more than this many files' heads for one revision. */
const MAX_MARKER_READS = 400;

/** `git cat-file --batch` over `<sha>:<path>` names; missing objects are absent. */
function catFiles(dir: string, sha: string, paths: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (paths.length === 0) return out;
  const buf = execFileSync("git", ["-C", dir, "cat-file", "--batch"], {
    input: paths.map((p) => `${sha}:${p}`).join("\n") + "\n",
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: 512 * 1024 * 1024,
  });
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "<name> missing" / "ambiguous"
    const size = Number(m[2]);
    if (m[1] === "blob") out.set(p, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return out;
}

/** A local repo (managed checkout, the PR's or the repo's path) that has `sha`. */
function localRepoWith(key: PrKey, sha: string, root: string): string | undefined {
  const dirs: (string | null | undefined)[] = [prCheckoutPath(key, root)];
  try {
    dirs.push(readMeta(key, root).repoPath);
  } catch {
    /* no meta yet */
  }
  dirs.push(readRepoConfig(repoKeyOf(key), root).repoPath);
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      execFileSync("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
      return dir;
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

function headLines(buf: Buffer): string[] | undefined {
  // A NUL in the first 8KB is git's own binary heuristic.
  if (buf.subarray(0, 8000).includes(0)) return undefined;
  return buf.subarray(0, 64 * 1024).toString("utf8").split("\n").slice(0, MARKER_LINES);
}

/**
 * Everything a revision's classification needs beyond files.json: the root
 * `.gitattributes` at `headSha` and the marker lines of files whose hunks
 * don't show their top. Read from a local checkout that has the commit, else
 * from GitHub (one contents call, batched GraphQL for heads). Failures only
 * mean "no signal" (and `partial`, so the next refresh reads again).
 * `network: false` skips every read and keeps only what the hunks show.
 */
export function gatherGeneratedFacts(
  key: PrKey,
  files: FileDiff[],
  headSha: string | undefined,
  root = stateRoot(),
  opts: { network?: boolean } = {},
): GeneratedFacts {
  const facts: GeneratedFacts = {
    headSha,
    fetchedAt: new Date().toISOString(),
    gitattributes: null,
    markers: markersFromHunks(files),
    partial: false,
  };
  if (opts.network === false || !headSha) {
    facts.partial = true;
    return facts;
  }
  const local = localRepoWith(key, headSha, root);
  if (local) {
    try {
      const attrs = catFiles(local, headSha, [".gitattributes"]).get(".gitattributes");
      facts.gitattributes = attrs ? attrs.toString("utf8") : null;
      const candidates = markerCandidates(files, facts.gitattributes).map((f) => f.path);
      for (const [p, buf] of catFiles(local, headSha, candidates)) {
        const m = buf.length <= 2 * 1024 * 1024 ? markerIn(headLines(buf) ?? []) : undefined;
        if (m) facts.markers[p] = m;
      }
      return facts;
    } catch {
      // fall through to GitHub
    }
  }
  const attrs = fetchGitattributes(key, headSha);
  facts.gitattributes = attrs.text;
  if (!attrs.ok) facts.partial = true;
  const candidates = markerCandidates(files, facts.gitattributes).map((f) => f.path);
  if (candidates.length > MAX_MARKER_READS) facts.partial = true;
  const heads = fetchFileHeads(key, headSha, candidates.slice(0, MAX_MARKER_READS), MARKER_LINES);
  if (!heads.ok) facts.partial = true;
  for (const [p, lines] of heads.heads) {
    const m = markerIn(lines);
    if (m) facts.markers[p] = m;
  }
  return facts;
}

/** `files` classified against `facts` and the repo's current settings. */
export function classifyFiles(key: PrKey, files: FileDiff[], facts: GeneratedFacts, root = stateRoot()): FileDiff[] {
  const patterns = readRepoConfig(repoKeyOf(key), root).generated;
  return annotateGenerated(files, classifyGenerated(files, facts, patterns));
}

export interface ReclassifyResult {
  state: State;
  /** the current revision's generated paths after the call */
  generated: string[];
  /** a `generated-classified` event was appended */
  changed: boolean;
}

/**
 * Classify the current revision again — after a settings change, a discard,
 * or to backfill a revision recorded before classification existed — and, if
 * the result differs from what the state holds, rewrite files.json and append
 * `generated-classified` (the reducer rebuilds the unit from it).
 *
 * Facts come from the revision's cache. Without one (or with a partial one),
 * `fetch: true` reads them; `fetch: false` leaves a never-classified revision
 * alone rather than classify it on half the signals.
 */
export function reclassifyGenerated(
  key: PrKey,
  root = stateRoot(),
  opts: { fetch?: boolean } = {},
): ReclassifyResult {
  const state = loadState(key, root);
  const revision = state.currentRevision;
  const current = (s: State) => s.generated.map((g) => g.path);
  let filesJson;
  try {
    filesJson = readFilesJson(key, revision, root);
  } catch {
    return { state, generated: current(state), changed: false };
  }
  let facts = readGeneratedFacts(key, revision, root);
  if (opts.fetch && (!facts || facts.partial)) {
    const headSha = filesJson.headSha ?? state.revisions.find((r) => r.revision === revision)?.headSha;
    facts = gatherGeneratedFacts(key, filesJson.files, headSha, root);
    writeGeneratedFacts(key, revision, facts, root);
  }
  if (!facts) return { state, generated: current(state), changed: false };

  const files = classifyFiles(key, filesJson.files, facts, root);
  const next: GeneratedFile[] = generatedFilesOf(files);
  const fileChanged = files.some(
    (f, i) => JSON.stringify(f.generated ?? null) !== JSON.stringify(filesJson.files[i].generated ?? null),
  );
  if (fileChanged) rewriteFilesJson(key, { ...filesJson, files }, root);
  // An old revision-added carries no classification at all; an empty one
  // still has to be recorded so the state says "classified, none".
  if (state.generatedRevision === revision && sameGeneratedFiles(state.generated, next)) {
    return { state, generated: current(state), changed: false };
  }
  const after = appendEvent(key, { type: "generated-classified", revision, files: next }, root);
  return { state: after, generated: current(after), changed: true };
}

/**
 * Re-classify every tracked PR of `pr`'s repo after its generated-file
 * settings changed, from cached facts only (a PR without them catches up on
 * its next refresh). One PR failing never stops the others.
 */
export function reclassifyRepo(repo: RepoKey, root = stateRoot(), skip?: PrKey): void {
  for (const key of listPrs(root)) {
    if (key.host !== repo.host || key.owner !== repo.owner || key.repo !== repo.repo) continue;
    if (skip && key.number === skip.number) continue;
    try {
      reclassifyGenerated(key, root, { fetch: false });
    } catch {
      /* next refresh */
    }
  }
}

/**
 * The reader's "Not generated" / "Treat as generated" on one file of `key`'s
 * current revision: remembered for the whole repo (repo.json), then the PR
 * is re-classified (reading facts if it has none) and so is every other
 * tracked PR of the repo. Throws on a path the revision does not have.
 */
export function setGeneratedOverride(
  key: PrKey,
  filePath: string,
  generated: boolean,
  root = stateRoot(),
): ReclassifyResult {
  const state = loadState(key, root);
  const file = readFilesJson(key, state.currentRevision, root).files.find((f) => f.path === filePath);
  if (!file) throw new Error(`${filePath} is not a file of revision ${state.currentRevision}`);
  if (file.binary && generated) throw new Error(`${filePath} is binary; binary files are never treated as generated`);
  const repo = repoKeyOf(key);
  const patterns = readRepoConfig(repo, root).generated;
  writeRepoConfig(repo, { generated: withGeneratedOverride(patterns, filePath, generated) }, root);
  const res = reclassifyGenerated(key, root, { fetch: true });
  reclassifyRepo(repo, root, key);
  return res;
}
