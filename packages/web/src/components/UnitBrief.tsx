import type { FileEntry, HeartSegment, Hunk, PrDetail, ReviewUnit } from "../api/types";
import { orderUnitHunks, skippedIds } from "../lib/diffModel";
import { useSettings } from "../lib/settings";
import { noteFor } from "../lib/shape";
import { heartOf, hunkIdsOf } from "../lib/units";
import { FileStatusBadge } from "./Chips";
import { InlineMarkdown } from "./Markdown";
import { IconCheck, IconChevron, IconHeart } from "./icons";

const added = (h: Hunk) => h.addedLines?.length ?? (h.lines ?? []).filter((l) => l.startsWith("+")).length;
const removed = (h: Hunk) => h.removedLines?.length ?? (h.lines ?? []).filter((l) => l.startsWith("-")).length;

export interface UnitFile {
  path: string;
  status?: FileEntry["status"];
  firstHunkId: string;
  /** the hunks to read: skippable ones count toward nothing */
  hunks: number;
  viewed: number;
  added: number;
  removed: number;
}

/**
 * The unit's files, in the order the pane reads them (see orderUnitHunks),
 * each with its share of the unit's hunks.
 */
export function unitFiles(detail: PrDetail, unit: ReviewUnit): UnitFile[] {
  const skip = skippedIds(unit);
  const byFile = new Map<string, { file: FileEntry; hunks: Hunk[] }>();
  for (const { hunk, file } of orderUnitHunks(detail.files.files, hunkIdsOf(unit), heartOf(unit), unit.fileOrder)) {
    const entry = byFile.get(file.path) ?? { file, hunks: [] };
    entry.hunks.push(hunk);
    byFile.set(file.path, entry);
  }
  return [...byFile.values()].map(({ file, hunks: hs }) => {
    const toRead = hs.filter((h) => !skip.has(h.id));
    return {
      path: file.path,
      status: file.status,
      firstHunkId: hs[0].id,
      hunks: toRead.length,
      viewed: toRead.filter((h) => detail.state.hunks[h.id]?.viewed).length,
      added: hs.reduce((n, h) => n + added(h), 0),
      removed: hs.reduce((n, h) => n + removed(h), 0),
    };
  });
}

/** "+34 −3", each side in its diff colour; nothing for a zero. */
export function LineDelta({ added: a, removed: r }: { added: number; removed: number }) {
  return (
    <span className="flex-none font-mono text-2xs tabular-nums">
      {a ? <span style={{ color: "var(--ok)" }}>+{a}</span> : null}
      {a && r ? " " : null}
      {r ? <span style={{ color: "var(--risk)" }}>−{r}</span> : null}
    </span>
  );
}

/** "3 files +34 −3", a line that opens the unit's file list. It stays open from unit to unit. */
export function UnitFiles({
  detail,
  unit,
  onJump,
}: {
  detail: PrDetail;
  unit: ReviewUnit;
  onJump: (hunkId: string) => void;
}) {
  const { settings, update } = useSettings();
  const files = unitFiles(detail, unit);
  if (!files.length) return null;
  return (
    <div className="mt-1.5 max-w-4xl text-xs">
      <button
        type="button"
        className="flex items-center gap-1.5 text-2xs transition-colors hover:text-[var(--fg-muted)]"
        style={{ color: "var(--fg-faint)" }}
        aria-expanded={settings.unitFilesOpen}
        data-testid="unit-files-toggle"
        onClick={() => update({ unitFilesOpen: !settings.unitFilesOpen })}
      >
        <IconChevron open={settings.unitFilesOpen} width={9} height={9} />
        {files.length} {files.length === 1 ? "file" : "files"}
        <LineDelta added={files.reduce((n, f) => n + f.added, 0)} removed={files.reduce((n, f) => n + f.removed, 0)} />
      </button>
      {settings.unitFilesOpen ? (
        <ul className="-mx-1.5 mt-0.5 flex flex-col" data-testid="unit-files">
          {files.map((f) => {
            const slash = f.path.lastIndexOf("/");
            const name = f.path.slice(slash + 1);
            const dir = slash > 0 ? f.path.slice(0, slash) : "";
            const read = f.hunks > 0 && f.viewed === f.hunks;
            const note = noteFor(detail.state.fileNotes, f.path);
            return (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => onJump(f.firstHunkId)}
                  data-tip={note ? `${f.path} — ${note}` : f.path}
                  className="flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <FileStatusBadge status={f.status} />
                    <span
                      className="flex-none font-mono text-[11.5px]"
                      style={{ color: f.status === "added" ? "var(--ok)" : read ? "var(--fg-muted)" : "var(--fg)" }}
                    >
                      {name}
                    </span>
                    <span className="min-w-0 truncate font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
                      {dir}
                    </span>
                  </span>
                  <LineDelta added={f.added} removed={f.removed} />
                  {read ? (
                    <IconCheck width={11} height={11} style={{ color: "var(--ok)" }} className="flex-none self-center" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The unit's heart: where its logic lives, as places to jump to. Each place's
 * why is on its tooltip and, in full, right above those lines in the diff;
 * written out here too it only restated the summary file by file.
 */
export function UnitHeart({
  segments,
  files,
  onJump,
}: {
  segments: (HeartSegment & { id: string })[];
  files: FileEntry[];
  onJump: (hunkId: string, line?: number) => void;
}) {
  const pathOf = (hunkId: string) => files.find((f) => f.hunks.some((h) => h.id === hunkId))?.path;
  return (
    <p className="mt-1.5 flex max-w-4xl flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs" data-testid="unit-heart">
      <span className="flex items-center gap-1.5 self-center text-2xs" style={{ color: "var(--fg-faint)" }}>
        <IconHeart width={11} height={11} className="flex-none" style={{ color: "var(--heart)" }} />
        Where the logic lives
      </span>
      {segments.map((h, i) => {
        const path = pathOf(h.id);
        // A range when the heart is part of a hunk; a whole hunk is its file.
        const lines = h.lines ? `${h.lines[0]}–${h.lines[1]}` : "";
        return (
          <button
            key={`${h.id}:${i}`}
            type="button"
            data-testid={`heart-jump-${h.id}`}
            data-segment={i}
            className="rounded px-1 font-mono text-2xs transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--accent)" }}
            onClick={() => onJump(h.id, h.lines?.[0])}
            data-tip={h.why.replace(/`/g, "")}
          >
            {path ? baseName(path) : "hunk"}
            {lines ? <span style={{ opacity: 0.75 }}> {lines}</span> : null}
          </button>
        );
      })}
    </p>
  );
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * What comes after the open unit, drawn in the room the diff leaves past its
 * last hunk: mark it and move on, the next unit still to read, or the review.
 * The one next step, where the reader's eye is when the unit runs out.
 */
export function UnitEnd({
  number,
  progress,
  next,
  onMarkViewed,
  onOpenNext,
  onFinish,
}: {
  number?: number;
  progress: { viewed: number; total: number };
  /** the next unit with hunks still to read, if any */
  next: { number?: number; title: string } | null;
  onMarkViewed: () => void;
  onOpenNext: () => void;
  onFinish: () => void;
}) {
  const left = progress.total - progress.viewed;
  const label = number !== undefined ? `unit ${number}` : "this unit";
  return (
    <div className="flex flex-col items-start gap-2 px-6 pt-10 text-xs" data-testid="unit-end">
      <p style={{ color: "var(--fg-faint)" }}>
        {left > 0
          ? `End of ${label} · ${left} ${left === 1 ? "hunk" : "hunks"} not marked viewed`
          : `End of ${label} · read`}
      </p>
      {left > 0 ? (
        <button type="button" className="btn" onClick={onMarkViewed} data-tip-key="V" data-testid="unit-end-mark">
          <IconCheck width={12} height={12} />
          Mark it viewed and go on
        </button>
      ) : next ? (
        <button type="button" className="btn" onClick={onOpenNext} data-tip-key="J" data-testid="unit-end-next">
          Next: {next.number !== undefined ? `${next.number} · ` : ""}
          <span className="max-w-[28rem] truncate">
            <InlineMarkdown text={next.title} />
          </span>
        </button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={onFinish} data-tip-key="r" data-testid="unit-end-finish">
          <IconCheck width={12} height={12} />
          Every unit read · finish review
        </button>
      )}
    </div>
  );
}
