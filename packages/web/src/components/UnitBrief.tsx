import { type ReactNode } from "react";
import type { FileEntry, HeartSegment, Hunk, PrDetail, ReviewUnit } from "../api/types";
import { isGeneratedUnit } from "../api/types";
import { orderUnitHunks, skippedIds } from "../lib/diffModel";
import { useSettings } from "../lib/settings";
import { noteFor } from "../lib/shape";
import { heartOf, heartSegments, hunkIdsOf } from "../lib/units";
import { UnitMix } from "./ChangeMix";
import { attentionColor, AttentionIcon, FileStatusBadge } from "./Chips";
import { UnitFindings } from "./Findings";
import { InlineMarkdown } from "./Markdown";
import { UnitChangelog } from "./UnitChangelog";
import { IconCheck, IconChevron, IconEyeOff, IconFile, IconHeart, IconQuote } from "./icons";

const ATTENTION_WORD: Record<ReviewUnit["attention"], string> = {
  "must-read": "Must read.",
  skim: "Skim.",
  skip: "Skip.",
};

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
    <div>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded hover:!text-[var(--fg)]"
        style={{ color: "var(--fg-muted)" }}
        aria-expanded={settings.unitFilesOpen}
        data-testid="unit-files-toggle"
        onClick={() => update({ unitFilesOpen: !settings.unitFilesOpen })}
      >
        <IconFile width={12} height={12} className="flex-none" />
        {files.length} {files.length === 1 ? "file" : "files"}
        <LineDelta added={files.reduce((n, f) => n + f.added, 0)} removed={files.reduce((n, f) => n + f.removed, 0)} />
        <IconChevron open={settings.unitFilesOpen} width={10} height={10} className="flex-none" />
      </button>
      {settings.unitFilesOpen ? (
        <ul className="-mr-1.5 mt-1 flex flex-col pl-3" data-testid="unit-files">
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
 * The guide's text for the open unit, under its row in the sidebar.
 *
 * One container only: the row's tint says this belongs to that unit, and
 * nothing in here draws a box or a rule of its own. Everything aligns to the
 * title's text column. The prose leads (what the unit does, why it matters);
 * under it, every other fact is one row of the same shape: an icon, a label,
 * its value, and a chevron where the row opens. Revisions are one of those
 * rows, the highlight in the diff included.
 */
export function UnitBrief({
  detail,
  unit,
  onJumpHunk,
  onCite,
  onMove,
  changelog,
  extra,
  highlight,
}: {
  detail: PrDetail;
  unit: ReviewUnit;
  /** `line`: a heart segment's first line, to land on it rather than the hunk's top */
  onJumpHunk: (hunkId: string, line?: number) => void;
  /** add this unit to the chat's next message */
  onCite?: () => void;
  /** a correction of the analysis: the unit belongs in another group */
  onMove?: (attention: ReviewUnit["attention"]) => void;
  changelog?: { activeRevisions: readonly number[]; onSelectRevision: (r: number) => void };
  /** under the summary: the generated file list */
  extra?: ReactNode;
  /** what the revision highlight marks, with the way out */
  highlight?: ReactNode;
}) {
  const { settings, update } = useSettings();
  const generated = isGeneratedUnit(unit);
  const skipped = skippedIds(unit).size;

  return (
    <div className="flex flex-col gap-3 pb-3 pl-[34px] pr-4 text-xs leading-5" data-testid="unit-brief">
      <div className="flex flex-col gap-2">
        {unit.summary ? (
          <p className="text-[13px] leading-[20px]" style={{ color: "var(--fg)" }}>
            <InlineMarkdown text={unit.summary} />
          </p>
        ) : null}
        {extra}
        {unit.attentionWhy ? (
          <p data-testid="unit-why" style={{ color: "var(--fg-muted)" }}>
            <span className="font-medium" style={{ color: attentionColor(unit.attention) }}>
              {ATTENTION_WORD[unit.attention]}
            </span>{" "}
            <InlineMarkdown text={unit.attentionWhy} />
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        {heartOf(unit).length ? (
          <UnitHeart segments={heartSegments(unit)} files={detail.files.files} onJump={onJumpHunk} />
        ) : null}
        {generated ? null : <UnitFiles detail={detail} unit={unit} onJump={onJumpHunk} />}
        {generated ? null : <UnitMix files={detail.files.files} hunkIds={hunkIdsOf(unit)} />}
        {skipped > 0 ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 self-start rounded text-xs tabular-nums hover:!text-[var(--fg)]"
            style={{ color: "var(--fg-muted)" }}
            data-testid="unit-skipped-count"
            data-folded={settings.foldSkippableHunks ? "true" : "false"}
            data-tip={
              settings.foldSkippableHunks
                ? "Skippable hunks are folded shut; click or Z shows them muted instead"
                : "Hunks the analysis says you can skip; shown muted, they count toward nothing. Click or Z folds them shut"
            }
            data-tip-key="Z"
            onClick={() => update({ foldSkippableHunks: !settings.foldSkippableHunks })}
          >
            <IconEyeOff width={12} height={12} className="flex-none" />
            {/* One text run, so the dot sits a space from the count, not a gap. */}
            <span>
              {skipped} skippable
              {settings.foldSkippableHunks ? <span style={{ color: "var(--fg-faint)" }}> · folded</span> : null}
            </span>
          </button>
        ) : null}
        <UnitFindings unitId={unit.id} findings={unit.findings} />
        <UnitChangelog
          className=""
          changelog={unit.changelog}
          currentRevision={detail.state.revision}
          activeRevisions={changelog?.activeRevisions}
          onSelectRevision={changelog?.onSelectRevision}
        />
        {highlight ? <div className="pl-[18px]">{highlight}</div> : null}
      </div>

      {/* The open unit's two actions, as words rather than a menu on every
          row. Moving is a correction the analysis learns from. */}
      {!generated && (onCite || onMove) ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
          {onCite ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 self-center hover:!text-[var(--fg)]"
              style={{ color: "var(--fg-muted)" }}
              onClick={onCite}
              data-tip="Cite this unit in the chat"
              data-testid={`cite-unit-${unit.id}`}
            >
              <IconQuote width={11} height={11} />
              cite in chat
            </button>
          ) : null}
          {onMove ? (
            <span className="flex items-center gap-2" data-tip="Corrections are logged for the analysis to learn from">
              move to:
              {(["must-read", "skim", "skip"] as const)
                .filter((a) => a !== unit.attention)
                .map((a) => (
                  <button
                    key={a}
                    type="button"
                    data-testid={`move-unit-${a}`}
                    className="inline-flex items-center gap-1 hover:!text-[var(--fg)]"
                    style={{ color: "var(--fg-muted)" }}
                    onClick={() => onMove(a)}
                  >
                    <AttentionIcon attention={a} />
                    {ATTENTION_WORD[a].replace(".", "").toLowerCase()}
                  </button>
                ))}
            </span>
          ) : null}
        </p>
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
    <div className="text-xs" data-testid="unit-heart">
      <span className="flex items-center gap-1.5" style={{ color: "var(--fg-muted)" }}>
        <IconHeart width={12} height={12} className="flex-none" style={{ color: "var(--heart)" }} />
        Where the logic lives
      </span>
      <span className="-ml-1 mt-0.5 flex flex-wrap gap-x-1 pl-[18px]">
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
      </span>
    </div>
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
