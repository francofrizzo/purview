import { useState, type ReactNode } from "react";
import type { FileEntry, HeartSegment, Hunk, PrDetail, ReviewUnit } from "../api/types";
import { isGeneratedUnit } from "../api/types";
import { orderUnitHunks, shownFindings, skippedIds } from "../lib/diffModel";
import { changelogView } from "../lib/changelog";
import { changeMix, formatShare } from "../lib/changeMix";
import { useSettings, type UnitDetail } from "../lib/settings";
import { noteFor } from "../lib/shape";
import { heartOf, heartSegments, hunkIdsOf } from "../lib/units";
import { CHANGE_LOOK, ChangeBar } from "./ChangeMix";
import { AttentionIcon, FileStatusBadge } from "./Chips";
import { FindingList } from "./Findings";
import { InlineMarkdown } from "./Markdown";
import { OverflowMenu } from "./OverflowMenu";
import { UnitChangelog } from "./UnitChangelog";
import { IconCheck, IconClose, IconEyeOff, IconFile, IconHeart, IconHistory, IconQuote, IconWarning } from "./icons";

const ATTENTION_WORD: Record<ReviewUnit["attention"], string> = {
  "must-read": "must read",
  skim: "skim",
  skip: "skip",
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

/** The unit's files, each a jump to its first hunk, with its note and size. */
export function UnitFileList({
  detail,
  unit,
  onJump,
}: {
  detail: PrDetail;
  unit: ReviewUnit;
  onJump: (hunkId: string) => void;
}) {
  const files = unitFiles(detail, unit);
  return (
    <ul className="-ml-1.5 -mr-1.5 flex flex-col" data-testid="unit-files">
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
                {/* The name gives way last: the folder truncates first, then the
                    name, so neither runs into the counts. */}
                <span
                  className="min-w-0 shrink truncate font-mono text-[11.5px]"
                  style={{ color: f.status === "added" ? "var(--ok)" : read ? "var(--fg-muted)" : "var(--fg)" }}
                >
                  {name}
                </span>
                <span className="min-w-0 shrink-[1000] truncate font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
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
  );
}

/**
 * The guide's text for the open unit, under its row in the sidebar.
 *
 * One container only: the row's tint says this belongs to that unit, and
 * nothing in here draws a box or a rule of its own. Everything aligns to the
 * title's text column. The prose leads (what the unit does, why it matters);
 * under it, one line of counts (the heart, the files and their mix, the
 * findings, the skippable hunks) with the unit's two actions at its end. A
 * count opens its list under the line, one at a time. The unit's history is
 * a line of its own below.
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
  /** the revision highlight in the diff, while one is on: the history count shows it and clears it */
  highlight?: { label: string; tip: string; error: boolean; onClear: () => void };
}) {
  const { settings, update } = useSettings();
  const generated = isGeneratedUnit(unit);
  const skipped = skippedIds(unit).size;
  const heart = heartOf(unit).length ? heartSegments(unit) : [];
  const files = generated ? [] : unitFiles(detail, unit);
  const mix = generated ? null : changeMix(detail.files.files, new Set(hunkIdsOf(unit)));
  const warnings = shownFindings(unit.findings).length;
  // Entries are written by refreshes (r2 on): each says what that revision changed here.
  const revisions = changelogView(unit.changelog);
  const revisionCount = revisions ? 1 + revisions.earlier.length : 0;
  const currentRevision = detail.state.currentRevision ?? detail.state.revision;
  const available: Record<UnitDetail, boolean> = {
    heart: heart.length > 0,
    files: files.length > 0,
    findings: warnings > 0,
  };
  const open = settings.unitDetail && available[settings.unitDetail] ? settings.unitDetail : null;
  const toggle = (d: UnitDetail) => update({ unitDetail: open === d ? null : d });
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3 pb-3 pl-[34px] pr-4 text-xs leading-5" data-testid="unit-brief">
      <div className="flex flex-col gap-2">
        {unit.summary ? (
          <p className="text-[13px] leading-[20px]" style={{ color: "var(--fg)" }}>
            <InlineMarkdown text={unit.summary} />
          </p>
        ) : null}
        {extra}
        {/* The group it sits under already names the attention: only the why. */}
        {unit.attentionWhy ? (
          <p data-testid="unit-why" style={{ color: "var(--fg-muted)" }}>
            <InlineMarkdown text={unit.attentionWhy} />
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="-ml-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 tabular-nums" data-testid="unit-counts">
          {available.heart ? (
            <Count
              open={open === "heart"}
              onClick={() => toggle("heart")}
              testId="unit-heart-toggle"
              tip="Where the logic lives: the places the diff marks with a heart"
            >
              <IconHeart width={12} height={12} className="flex-none" style={{ color: "var(--heart)" }} />
              {heart.length}
            </Count>
          ) : null}
          {available.files ? (
            <Count
              open={open === "files"}
              onClick={() => toggle("files")}
              testId="unit-files-toggle"
              tip={[
                `${files.length} ${files.length === 1 ? "file" : "files"}`,
                ...(mix?.rows ?? []).map((r) => `${formatShare(r.percent)} ${CHANGE_LOOK[r.kind].label}`),
              ].join(" · ")}
            >
              <IconFile width={12} height={12} className="flex-none" />
              {files.length}
              {mix && mix.rows.length > 1 ? <ChangeBar mix={mix} className="h-1 w-8" /> : null}
            </Count>
          ) : null}
          {available.findings ? (
            <Count
              open={open === "findings"}
              onClick={() => toggle("findings")}
              testId="findings-toggle"
              tip={`${warnings} warning${warnings === 1 ? "" : "s"}`}
            >
              <IconWarning width={12} height={12} className="flex-none" style={{ color: "var(--warn)" }} />
              {warnings}
            </Count>
          ) : null}
          {skipped > 0 ? (
            <Count
              open={settings.foldSkippableHunks}
              onClick={() => update({ foldSkippableHunks: !settings.foldSkippableHunks })}
              testId="unit-skipped-count"
              tipKey="Z"
              tip={
                settings.foldSkippableHunks
                  ? `${skipped} skippable, folded shut; click or Z shows them muted`
                  : `${skipped} skippable: shown muted, they count toward nothing. Click or Z folds them shut`
              }
            >
              <IconEyeOff width={12} height={12} className="flex-none" />
              {skipped}
            </Count>
          ) : null}
        </div>
        {open === "heart" ? <UnitHeart segments={heart} files={detail.files.files} onJump={onJumpHunk} /> : null}
        {open === "files" ? (
          <div className="flex flex-col gap-1">
            {mix && mix.rows.length > 1 ? (
              <p className="text-2xs tabular-nums" style={{ color: "var(--fg-muted)" }} data-testid="unit-mix">
                {mix.rows.map((r) => `${formatShare(r.percent)} ${CHANGE_LOOK[r.kind].short}`).join(" · ")}
              </p>
            ) : null}
            <UnitFileList detail={detail} unit={unit} onJump={onJumpHunk} />
          </div>
        ) : null}
        {open === "findings" ? <FindingList findings={unit.findings ?? []} /> : null}
      </div>

      {/* The last row: the unit's history on the left, the unit's two
          actions always at the bottom right. History is one control: it
          opens what each revision changed here (above it, so the row stays
          last), each a toggle for the diff's highlight; while a highlight is
          on, it names it, with its way out. */}
      {historyOpen && revisionCount ? (
        <UnitChangelog
          listOnly
          className="-mt-1"
          changelog={unit.changelog}
          activeRevisions={changelog?.activeRevisions}
          onSelectRevision={changelog?.onSelectRevision}
        />
      ) : null}
      {revisionCount || highlight || (!generated && (onCite || onMove)) ? (
        // A little closer than the brief's sections: it reads with the counts.
        <div className="-mt-1 flex items-center gap-1">
          {revisionCount || highlight ? (
          <span
            className="-ml-1 inline-flex items-center rounded tabular-nums"
            style={highlight ? { background: "var(--bg-hover)" } : undefined}
            data-testid={highlight ? "highlight-summary" : undefined}
          >
            <Count
              open={historyOpen}
              onClick={() => (revisionCount ? setHistoryOpen((v) => !v) : undefined)}
              testId="changelog-toggle"
              tip={
                highlight?.tip ??
                `What changed here, in ${revisionCount} revision${revisionCount === 1 ? "" : "s"}${
                  revisions && revisions.latest.revision === currentRevision ? `; updated in r${currentRevision}` : ""
                }`
              }
            >
              {highlight ? (
                <span
                  aria-hidden
                  className="h-2.5 w-[3px] flex-none rounded-full"
                  style={{ background: "var(--changed-in-bar)" }}
                />
              ) : null}
              <IconHistory
                width={12}
                height={12}
                className="flex-none"
                style={
                  !highlight && revisions && revisions.latest.revision === currentRevision
                    ? { color: "var(--accent)" }
                    : undefined
                }
              />
              {highlight ? (
                <span style={highlight.error ? { color: "var(--risk)" } : undefined}>{highlight.label}</span>
              ) : (
                `${revisionCount} ${revisionCount === 1 ? "revision" : "revisions"}`
              )}
            </Count>
            {highlight ? (
              <button
                type="button"
                data-testid="highlight-clear"
                className="rounded py-1 pl-0.5 pr-1.5 hover:!text-[var(--fg)]"
                style={{ color: "var(--fg-muted)" }}
                data-tip="Clear the highlight"
                data-tip-key="esc"
                aria-label="Clear the highlight"
                onClick={highlight.onClear}
              >
                <IconClose width={10} height={10} />
              </button>
            ) : null}
          </span>
          ) : null}
          {!generated && (onCite || onMove) ? (
            <span className="ml-auto flex items-center">
              {onCite ? (
                <button
                  type="button"
                  className="rounded p-1 hover:bg-[var(--bg-hover)] hover:!text-[var(--fg)]"
                  style={{ color: "var(--fg-faint)" }}
                  onClick={onCite}
                  data-tip="Cite this unit in the chat"
                  aria-label="Cite this unit in the chat"
                  data-testid={`cite-unit-${unit.id}`}
                >
                  <IconQuote width={12} height={12} />
                </button>
              ) : null}
              {/* Moving is a correction the analysis learns from: rare, so a menu. */}
              {onMove ? (
                <OverflowMenu
                  fixed
                  testId="move-unit"
                  label="Move to another group"
                  buttonClassName="rounded p-1 hover:bg-[var(--bg-hover)] hover:!text-[var(--fg)]"
                  buttonStyle={{ color: "var(--fg-faint)" }}
                  items={(["must-read", "skim", "skip"] as const)
                    .filter((a) => a !== unit.attention)
                    .map((a) => ({
                      label: `Move to ${ATTENTION_WORD[a]}`,
                      icon: <AttentionIcon attention={a} />,
                      hint: "Corrections are logged for the analysis to learn from",
                      testId: `move-unit-${a}`,
                      onClick: () => onMove(a),
                    }))}
                />
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One count on the open unit's line: an icon and a number, a pill while its list is open. */
function Count({
  open,
  onClick,
  testId,
  tip,
  tipKey,
  children,
}: {
  open: boolean;
  onClick: () => void;
  testId: string;
  tip?: string;
  tipKey?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      data-testid={testId}
      data-tip={tip}
      data-tip-key={tipKey}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded px-1 transition-colors hover:!text-[var(--fg)]"
      style={open ? { background: "var(--bg-hover)", color: "var(--fg)" } : { color: "var(--fg-muted)" }}
    >
      {children}
    </button>
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
    <div className="-ml-1 flex flex-wrap gap-x-1" data-testid="unit-heart">
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
