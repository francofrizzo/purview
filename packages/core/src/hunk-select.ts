import type { FileDiff, FilesJson, Hunk } from "./schemas.js";

/**
 * Selector matching for the `show` CLI command: pick hunks out of a revision
 * by hunk id (exact or unique prefix), exact file path, or a `*`/`**` glob
 * over file paths — the counterpart to `triage.ts`'s overview, so a headless
 * run can fetch exactly the bodies it needs in one call instead of re-slicing
 * `files.json`.
 */

export interface SelectedHunk {
  file: FileDiff;
  hunk: Hunk;
}

export interface SelectResult {
  /** Matched hunks, file-order then hunk-order, each hunk once. */
  hunks: SelectedHunk[];
  /** Selectors that matched nothing (or an ambiguous, non-unique id prefix). */
  unknown: string[];
}

const MIN_PREFIX_LEN = 6;

/** Convert a `*`/`**` glob into an anchored RegExp. `*` never crosses `/`;
 *  `**` crosses any number of segments, and `**` followed by `/` also matches
 *  zero segments, so `src/**\/*.ts` matches `src/a.ts` as well as
 *  `src/x/y/a.ts` (the shape a model reaches for first). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Every hunk of a revision, in files.json order, alongside its file. */
function flatten(filesJson: FilesJson): SelectedHunk[] {
  const out: SelectedHunk[] = [];
  for (const file of filesJson.files) {
    for (const hunk of file.hunks) out.push({ file, hunk });
  }
  return out;
}

/** Resolve `selectors` against a revision's files.json. See module doc. */
export function selectHunks(filesJson: FilesJson, selectors: string[]): SelectResult {
  const flat = flatten(filesJson);
  const byId = new Map(flat.map((sh) => [sh.hunk.id, sh]));
  const byPath = new Map<string, FileDiff>(filesJson.files.map((f) => [f.path, f]));

  const matched = new Set<SelectedHunk>();
  const unknown: string[] = [];

  for (const sel of selectors) {
    let hits = 0;

    const exact = byId.get(sel);
    if (exact) {
      matched.add(exact);
      hits++;
    } else if (sel.length >= MIN_PREFIX_LEN) {
      const candidates = flat.filter((sh) => sh.hunk.id.startsWith(sel));
      if (candidates.length === 1) {
        matched.add(candidates[0]);
        hits++;
      }
      // more than one candidate: ambiguous, falls through to "unknown" below
    }

    if (hits === 0) {
      const file = byPath.get(sel);
      if (file) {
        for (const hunk of file.hunks) matched.add(byId.get(hunk.id)!);
        hits++;
      } else if (sel.includes("*")) {
        const re = globToRegExp(sel);
        for (const file of filesJson.files) {
          if (re.test(file.path)) {
            for (const hunk of file.hunks) matched.add(byId.get(hunk.id)!);
            hits++;
          }
        }
      }
    }

    if (hits === 0) unknown.push(sel);
  }

  const ordered = flat.filter((sh) => matched.has(sh));
  return { hunks: ordered, unknown };
}

/** Every hunk of the revision, in files.json order (for `--all`). */
export function allSelectedHunks(filesJson: FilesJson): SelectedHunk[] {
  return flatten(filesJson);
}
