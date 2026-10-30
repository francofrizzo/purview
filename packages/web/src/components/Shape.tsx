import { useMemo, type CSSProperties } from "react";
import type { FileEntry, FileNotes, ReviewUnit } from "../api/types";
import { asideFiles, fileTree } from "../lib/shape";
import { FileStatusBadge } from "./Chips";
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
  const foot = [
    asideCount ? `${asideCount} test and doc ${asideCount === 1 ? "file" : "files"}` : null,
    generated ? `${generated} generated` : null,
  ].filter(Boolean);

  return (
    <div data-testid="file-shape">
      {/* Notes start at one column, as wide as the longest name needs; on a
          phone they go under their line. */}
      <div className="grid sm:grid-cols-[fit-content(45%)_minmax(0,1fr)] sm:gap-x-6">
        {lines.map((l, i) => (
          <div
            key={`${i}:${l.path}`}
            className="col-span-full grid py-[3px] sm:[grid-template-columns:subgrid]"
            style={{ "--indent": `${l.depth * INDENT_PX}px` } as CSSProperties}
          >
            <div className="flex min-w-0 items-start gap-1.5 pl-[var(--indent)] font-mono text-[12px] leading-5">
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
            </div>
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

/** The tree's key, as counts: each badge the way the rows show it. */
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
