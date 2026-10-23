import { type ReactNode } from "react";
import type { FileEntry, HeartSegment, Hunk, PrDetail, ReviewUnit } from "../api/types";
import { isGeneratedUnit } from "../api/types";
import { useChatAgentName } from "../lib/chat";
import { orderUnitHunks, skippedIds } from "../lib/diffModel";
import { useSettings } from "../lib/settings";
import { heartOf, heartSegments, hunkIdsOf } from "../lib/units";
import { attentionColor } from "./Chips";
import { UnitFindings } from "./Findings";
import { InlineMarkdown } from "./Markdown";
import { UnitChangelog } from "./UnitChangelog";
import { IconCheck, IconChevron, IconHeart } from "./icons";
import { noteFor } from "../lib/shape";

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

/**
 * The guide's text for the open unit, under its row in the sidebar.
 *
 * One container only: the row's tint says this belongs to that unit, and
 * nothing in here draws a box or a rule of its own. Everything aligns to the
 * title's text column. What every review needs (the summary, why it matters,
 * where the logic lives) is open; what only some reviews need (the files,
 * findings, revisions) is one line that opens. Nothing here says what another
 * part already says: the heart's whys are on the lines they explain.
 */
export function UnitBrief({
  detail,
  unit,
  onJumpHunk,
  onAsk,
  onMove,
  changelog,
  extra,
}: {
  detail: PrDetail;
  unit: ReviewUnit;
  /** `line`: a heart segment's first line, to land on it rather than the hunk's top */
  onJumpHunk: (hunkId: string, line?: number) => void;
  /** attach this unit to the chat and open it */
  onAsk?: () => void;
  /** a correction of the analysis: the unit belongs in another group */
  onMove?: (attention: ReviewUnit["attention"]) => void;
  changelog?: { activeRevisions: readonly number[]; onSelectRevision: (r: number) => void };
  /** under the summary: the generated file list, the highlight summary */
  extra?: ReactNode;
}) {
  const agentName = useChatAgentName();
  const { settings, update } = useSettings();
  const generated = isGeneratedUnit(unit);
  const files = unitFiles(detail, unit);
  const skipped = skippedIds(unit).size;

  return (
    <div className="flex flex-col gap-3 pb-3 pl-[34px] pr-4 text-xs leading-5" data-testid="unit-brief">
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

      {heartOf(unit).length ? (
        <UnitHeart segments={heartSegments(unit)} files={detail.files.files} onJump={onJumpHunk} />
      ) : null}

      {files.length && !generated ? (
        <div>
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
          <ul className="-mx-1.5 flex flex-col" data-testid="unit-files">
            {files.map((f) => {
              const slash = f.path.lastIndexOf("/");
              const name = f.path.slice(slash + 1);
              const dir = slash > 0 ? f.path.slice(0, slash) : "";
              const read = f.hunks > 0 && f.viewed === f.hunks;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => onJumpHunk(f.firstHunkId)}
                    data-tip={noteFor(detail.state.fileNotes, f.path) ? `${f.path} — ${noteFor(detail.state.fileNotes, f.path)}` : f.path}
                    className="flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
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
      ) : null}

      {skipped > 0 ? (
        <button
          type="button"
          className="self-start text-2xs tabular-nums hover:!text-[var(--fg-muted)]"
          style={{
            color: "var(--fg-faint)",
            textDecoration: settings.foldSkippableHunks ? "line-through" : undefined,
          }}
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
          {skipped} skippable
        </button>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <UnitFindings unitId={unit.id} findings={unit.findings} />
        <UnitChangelog
          className=""
          changelog={unit.changelog}
          currentRevision={detail.state.revision}
          activeRevisions={changelog?.activeRevisions}
          onSelectRevision={changelog?.onSelectRevision}
        />
      </div>

      {/* The open unit's two actions, as words where they apply rather than
          a menu on every row. Moving is a correction the analysis learns from. */}
      {!generated && (onAsk || onMove) ? (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
          {onAsk ? (
            <button type="button" className="hover:!text-[var(--fg)]" style={{ color: "var(--fg-muted)" }} onClick={onAsk} data-testid={`ask-agent-${unit.id}`}>
              Ask {agentName} about it
            </button>
          ) : null}
          {onMove ? (
            <span className="flex items-baseline gap-1.5" data-tip="The analysis learns from the move">
              Move to
              {(["must-read", "skim", "skip"] as const)
                .filter((a) => a !== unit.attention)
                .map((a) => (
                  <button
                    key={a}
                    type="button"
                    data-testid={`move-unit-${a}`}
                    className="hover:!text-[var(--fg)]"
                    style={{ color: "var(--fg-muted)" }}
                    onClick={() => onMove(a)}
                  >
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
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs" data-testid="unit-heart">
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
