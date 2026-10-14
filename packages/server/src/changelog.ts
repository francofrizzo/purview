import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./skill-paths.js";

/**
 * Purview's version is whatever CHANGELOG.md says it is: each `## <version>`
 * heading (`2026.10.14.1` — the day, then a counter within it) is one shipped
 * change, and the newest heading is the running version. So the version only
 * moves when there is something to tell the reader, and "what's new since you
 * last looked" is exactly the headings above the one they last saw.
 */
export interface ChangelogEntry {
  version: string;
  /** ISO date derived from the version, for display */
  date: string;
  /** one bullet each; inline markdown */
  items: string[];
}

const VERSION_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d+)$/;

export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const h = /^##\s+(\S+)\s*$/.exec(line);
    if (h) {
      const m = VERSION_RE.exec(h[1]);
      if (!m) {
        current = null;
        continue;
      }
      const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      current = { version: h[1], date, items: [] };
      entries.push(current);
      continue;
    }
    const b = /^[-*]\s+(.+)$/.exec(line);
    if (b && current) current.items.push(b[1].trim());
    else if (current && /^\s+\S/.test(raw) && current.items.length) {
      // a wrapped bullet continues the previous one
      current.items[current.items.length - 1] += " " + line.trim();
    }
  }
  return entries;
}

/** Numeric, segment by segment: 2026.10.14.2 > 2026.10.14.1 > 2026.10.9.3. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * What to show after an update. A reader who has never been shown anything
 * (`lastSeen` null) gets only the newest entry, not the whole history.
 */
export function entriesSince(entries: ChangelogEntry[], lastSeen: string | null): ChangelogEntry[] {
  if (!entries.length) return [];
  if (lastSeen === null) return [entries[0]];
  return entries.filter((e) => compareVersions(e.version, lastSeen) > 0);
}

function changelogPath(): string | null {
  // Dev layout: <root>/CHANGELOG.md; packaged: next to the server module.
  for (const p of [path.join(repoRoot(), "CHANGELOG.md"), path.join(path.dirname(new URL(import.meta.url).pathname), "CHANGELOG.md")]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let cached: { mtime: number; entries: ChangelogEntry[] } | null = null;

export function readChangelog(): ChangelogEntry[] {
  const p = changelogPath();
  if (!p) return [];
  const mtime = fs.statSync(p).mtimeMs;
  if (cached && cached.mtime === mtime) return cached.entries;
  cached = { mtime, entries: parseChangelog(fs.readFileSync(p, "utf8")) };
  return cached.entries;
}

let sha: string | null | undefined;

/** The running checkout's short commit, for the About line; null outside a git checkout. */
export function headSha(): string | null {
  if (sha !== undefined) return sha;
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot(), stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    sha = null;
  }
  return sha;
}
