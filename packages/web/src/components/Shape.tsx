import { useMemo } from "react";
import type { FileEntry, FileNotes, ReviewUnit } from "../api/types";
import { asideFiles, fileTree, type TreeLine } from "../lib/shape";
import { InlineMarkdown } from "./Markdown";

/** Past this, a chain of folders keeps its first and last two names (`internal/…/skills/SKILL.md`); the full path is on hover. */
const NAME_MAX = 44;

function shortName(name: string): string {
  if (name.length <= NAME_MAX) return name;
  const parts = name.split("/");
  let short = name;
  if (parts.length >= 3) {
    const tail = parts.length > 3 ? parts.slice(-2) : parts.slice(-1);
    short = `${parts[0]}/…/${tail.join("/")}`;
    if (short.length > NAME_MAX) short = `${parts[0]}/…/${parts[parts.length - 1]}`;
  }
  // Still too long (a migration's timestamped name): keep its start and its end.
  return short.length <= NAME_MAX ? short : `${short.slice(0, 16)}…${short.slice(short.length - (NAME_MAX - 17))}`;
}

/**
 * Where the change lands: the PR's files as a shallow tree, each noted folder
 * or file with the analysis's line beside it, the way a design doc shows it.
 * New files carry a `+` and the add tint, deleted ones a `−` and the del
 * tint (the names stay in plain ink); a file opens in the Files view. Tests,
 * docs and generated files are counted at the foot.
 */
export function FileShape({
  files,
  units,
  notes = {},
  onOpenFile,
}: {
  files: FileEntry[];
  units: ReviewUnit[];
  notes?: FileNotes;
  onOpenFile?: (path: string) => void;
}) {
  const own = useMemo(() => files.filter((f) => !f.generated), [files]);
  const aside = useMemo(() => asideFiles(own, units), [own, units]);
  const lines = useMemo(() => fileTree(own, notes, aside), [own, notes, aside]);
  const generated = files.length - own.length;
  const asideCount = own.filter((f) => aside.has(f.path) && notes[f.path] === undefined).length;
  const shown = (l: TreeLine) => shortName(l.name) + (l.dir ? "/" : "");
  // Notes start at one column, like comments in a listing: past the longest
  // noted line, but never so far out that short names float alone.
  const width = (l: TreeLine) => l.prefix.length + shown(l).length;
  const noted = lines.filter((l) => l.note);
  const column = Math.min(52, Math.max(0, ...noted.map(width)) + 3);
  const foot = [
    asideCount ? `${asideCount} test and doc ${asideCount === 1 ? "file" : "files"}` : null,
    generated ? `${generated} generated` : null,
  ].filter(Boolean);

  return (
    <div
      className="overflow-x-auto rounded-lg border py-2 font-mono text-[12px] leading-[20px]"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
      data-testid="file-shape"
    >
      {lines.map((l, i) => {
        const added = l.status === "added";
        const removed = l.status === "removed";
        return (
          <div
            key={`${i}:${l.path}`}
            className="flex items-start whitespace-pre pr-4"
            style={added ? { background: "var(--add-bg)" } : removed ? { background: "var(--del-bg)" } : undefined}
          >
            <span className="w-6 flex-none text-center" style={{ color: added ? "var(--ok)" : "var(--risk)" }}>
              {added ? "+" : removed ? "−" : " "}
            </span>
            <span className="flex-none" style={{ color: "var(--fg-faint)" }}>{l.prefix}</span>
            {l.dir ? (
              <span className="flex-none" style={{ color: "var(--fg-muted)" }} data-tip={l.path} data-testid={`file-shape-dir-${l.path}`}>
                {shown(l)}
                {l.folded ? <span style={{ color: "var(--fg-faint)" }}>{` · ${l.folded} files`}</span> : null}
                {l.more ? <span style={{ color: "var(--fg-faint)" }}>{` · ${l.more} more`}</span> : null}
              </span>
            ) : (
              <button
                type="button"
                className="flex-none hover:underline"
                style={{ color: "var(--fg)", textDecoration: removed ? "line-through" : undefined }}
                onClick={() => onOpenFile?.(l.path)}
                data-tip={l.path}
                data-testid={`file-shape-${l.path}`}
              >
                {shown(l)}
              </button>
            )}
            {l.note ? (
              // Only the note wraps, inside its own column, so a long one
              // never pushes its line's name off it.
              <span
                className="min-w-0 whitespace-normal"
                style={{ color: "var(--fg-faint)", marginLeft: `${Math.max(2, column - width(l))}ch` }}
              >
                # <InlineMarkdown text={l.note} />
              </span>
            ) : null}
          </div>
        );
      })}
      {foot.length ? (
        <div className="flex whitespace-pre" style={{ color: "var(--fg-faint)" }} data-testid="file-shape-foot">
          <span className="w-6 flex-none" />
          {`Not drawn: ${foot.join(", ")}`}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The tree's key, as counts: what the marks mean and how much of each there
 * is. Each mark is drawn the way its rows are; unmarked rows are changed.
 */
export function FileLegend({ files }: { files: FileEntry[] }) {
  const own = files.filter((f) => !f.generated);
  const added = own.filter((f) => f.status === "added").length;
  const removed = own.filter((f) => f.status === "removed").length;
  const changed = own.length - added - removed;
  const mark = (glyph: string, bg: string, ink: string) => (
    <span className="rounded px-1 font-mono" style={{ background: bg, color: ink }}>
      {glyph}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="file-legend">
      {added ? (
        <span className="flex items-center gap-1">
          {mark("+", "var(--add-bg)", "var(--ok)")} {added} new
        </span>
      ) : null}
      {removed ? (
        <span className="flex items-center gap-1">
          {mark("−", "var(--del-bg)", "var(--risk)")} {removed} deleted
        </span>
      ) : null}
      {changed ? <span>{changed} changed</span> : null}
    </div>
  );
}
