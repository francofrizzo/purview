import { useMemo, type CSSProperties } from "react";
import type { FileEntry, FileNotes, ReviewUnit } from "../api/types";
import { asideFiles, fileTree, type TreeLine } from "../lib/shape";
import { FileStatusBadge } from "./Chips";
import { TreeLines } from "./TreeLines";
import { InlineMarkdown } from "./Markdown";
import { IconFile, IconFolder } from "./icons";

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

/** One level in: a child's icon sits under its parent's name. */
const INDENT_PX = 20;
/** The icon's center, across and down: where a row's lines meet it. */
const ICON_X = 7;
const ICON_Y = 13;
/** Lines stop this short of an icon, so they lead to it without touching it. */
const LINE_GAP = 3;

const STATUS_COUNTS: [NonNullable<FileEntry["status"]>, string][] = [
  ["added", "new"],
  ["modified", "changed"],
  ["renamed", "renamed"],
  ["removed", "deleted"],
];

/**
 * Where the change lands: the PR's files as a shallow tree, each noted folder
 * or file with the analysis's line beside it. A file carries the same badge
 * as in the Files view, and opens there. Tests, docs and generated files are
 * counted at the foot.
 */
export function FileShape({
  files,
  units,
  notes = {},
  onOpenFile,
  counts = false,
}: {
  files: FileEntry[];
  units: ReviewUnit[];
  notes?: FileNotes;
  onOpenFile?: (path: string) => void;
  /** each row's lines added and removed, in a column of their own */
  counts?: boolean;
}) {
  const own = useMemo(() => files.filter((f) => !f.generated), [files]);
  const aside = useMemo(() => asideFiles(own, units), [own, units]);
  const lines = useMemo(() => fileTree(own, notes, aside), [own, notes, aside]);
  // Lines added and removed on each line, every changed line counted once: a
  // file's own on its row, and on a folder's row only those of the files it
  // hides ("3 files", "12 more"). The numbers on screen add up to the total.
  const size = useMemo(() => {
    const shownFiles = new Set(lines.filter((l) => !l.dir).map((l) => l.path));
    const dirs = lines.filter((l) => l.dir).map((l) => l.path);
    const totals = new Map<string, { added: number; removed: number; files: number }>();
    for (const f of own) {
      const added = f.additions ?? f.hunks.reduce((n, h) => n + (h.addedLines?.length ?? 0), 0);
      const removed = f.deletions ?? f.hunks.reduce((n, h) => n + (h.removedLines?.length ?? 0), 0);
      // its own row, else the deepest folder row it sits under
      const at = shownFiles.has(f.path)
        ? f.path
        : dirs.filter((d) => f.path.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
      if (at === undefined) continue;
      const t = totals.get(at) ?? { added: 0, removed: 0, files: 0 };
      totals.set(at, { added: t.added + added, removed: t.removed + removed, files: t.files + 1 });
    }
    return (path: string) => totals.get(path) ?? { added: 0, removed: 0, files: 0 };
  }, [own, lines]);
  const generated = files.length - own.length;
  const asideCount = own.filter((f) => aside.has(f.path) && notes[f.path] === undefined).length;
  const foot = [
    asideCount ? `${asideCount} test and doc ${asideCount === 1 ? "file" : "files"}` : null,
    generated ? `${generated} generated` : null,
  ].filter(Boolean);

  return (
    <div data-testid="file-shape">
      {/* Names, then the line counts (added right-aligned, removed left, so
          the numbers meet at one seam), then the notes; on a phone the counts
          sit after the name and the note goes under its line. */}
      <div
        className={`grid ${counts ? "sm:grid-cols-[fit-content(45%)_auto_auto_minmax(0,1fr)]" : "sm:grid-cols-[fit-content(45%)_minmax(0,1fr)]"}`}
      >
        {lines.map((l, i) => (
          <div
            key={`${i}:${l.path}`}
            className="relative col-span-full grid py-[3px] sm:[grid-template-columns:subgrid]"
            style={{ "--indent": `${l.depth * INDENT_PX}px` } as CSSProperties}
          >
            <TreeLines
              depth={l.depth}
              guides={l.guides}
              last={l.last}
              indent={INDENT_PX}
              lineAt={ICON_X}
              elbowY={ICON_Y}
              elbowWidth={INDENT_PX - ICON_X - LINE_GAP}
              stemFrom={l.open ? ICON_Y + 6 + LINE_GAP : undefined}
            />
            <div className="flex min-w-0 items-start gap-1.5 pl-[var(--indent)] font-mono text-[12px] leading-5 sm:pr-4">
              <span className="flex h-5 w-3.5 flex-none items-center justify-center" style={{ color: "var(--fg-faint)" }}>
                {l.dir ? (
                  <IconFolder width={12} height={12} />
                ) : l.status ? (
                  <FileStatusBadge status={l.status} />
                ) : (
                  <IconFile width={12} height={12} />
                )}
              </span>
              {l.dir ? (
                <span className="min-w-0" style={{ color: "var(--fg-muted)" }} data-tip={l.path} data-testid={`file-shape-dir-${l.path}`}>
                  {shortName(l.name)}/
                  {l.folded || l.more ? (
                    <span className="ml-1.5 font-sans text-2xs" style={{ color: "var(--fg-faint)" }}>
                      {l.folded ? `${l.folded} files` : `${l.more} more`}
                    </span>
                  ) : null}
                </span>
              ) : (
                <button
                  type="button"
                  className="min-w-0 text-left hover:underline"
                  style={{ color: "var(--fg)", textDecoration: l.status === "removed" ? "line-through" : undefined }}
                  onClick={() => onOpenFile?.(l.path)}
                  data-tip={l.path}
                  data-testid={`file-shape-${l.path}`}
                >
                  {shortName(l.name)}
                </button>
              )}
              {counts ? (
                <span className="sm:hidden">
                  <LineCounts {...size(l.path)} hidden={hiddenTip(l, size(l.path).files)} />
                </span>
              ) : null}
            </div>
            {counts ? <LineCounts {...size(l.path)} hidden={hiddenTip(l, size(l.path).files)} columns /> : null}
            {l.note ? (
              <div className="min-w-0 pl-[calc(var(--indent)+1.25rem)] text-xs leading-5 sm:pl-0" style={{ color: "var(--fg-muted)" }}>
                <InlineMarkdown text={l.note} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {foot.length ? (
        <p className="mt-2 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="file-shape-foot">
          Not listed: {foot.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/** What a folder row's numbers count: only the files it hides, never the rows under it. */
function hiddenTip(l: TreeLine, files: number): string | undefined {
  if (!l.dir || !files) return undefined;
  const n = `${files} ${files === 1 ? "file" : "files"}`;
  return l.folded ? `Lines in its ${n}` : `Lines in the ${n} not listed under it`;
}

/** The tree's key, as counts: each badge the way the rows show it. */
/** `+12 −3`, quiet: the size of what sits there. As `columns`, two grid
 *  cells (always there, so the note keeps its column), shown from `sm` up. */
function LineCounts({
  added,
  removed,
  hidden,
  columns,
}: {
  added: number;
  removed: number;
  /** on a folder's row, which files the numbers are of */
  hidden?: string;
  columns?: boolean;
}) {
  const tip = hidden && (added || removed) ? hidden : undefined;
  if (columns) {
    const cell = "hidden whitespace-nowrap font-sans text-[10px] leading-5 tabular-nums sm:block";
    return (
      <>
        <span className={`${cell} text-right`} style={{ color: "var(--ok)" }} data-tip={tip} data-testid="file-shape-counts">
          {added ? `+${added}` : null}
        </span>
        <span className={`${cell} pl-1.5 pr-6`} style={{ color: "var(--risk)" }} data-tip={tip}>
          {removed ? `−${removed}` : null}
        </span>
      </>
    );
  }
  if (!added && !removed) return null;
  return (
    <span className="flex-none whitespace-nowrap font-sans text-[10px] tabular-nums" data-tip={tip} data-testid="file-shape-counts">
      {added ? <span style={{ color: "var(--ok)" }}>+{added}</span> : null}
      {added && removed ? " " : null}
      {removed ? <span style={{ color: "var(--risk)" }}>−{removed}</span> : null}
    </span>
  );
}

export function FileLegend({ files }: { files: FileEntry[] }) {
  const own = files.filter((f) => !f.generated);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="file-legend">
      {STATUS_COUNTS.map(([status, word]) => {
        const count = own.filter((f) => (f.status ?? "modified") === status).length;
        return count ? (
          <span key={status} className="flex items-center gap-1">
            <FileStatusBadge status={status} /> {count} {word}
          </span>
        ) : null;
      })}
    </div>
  );
}
