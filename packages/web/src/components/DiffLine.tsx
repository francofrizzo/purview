import { memo, type ReactNode } from "react";
import type { Tok } from "../lib/highlight";
import type { CharRange, DiffRow } from "../lib/diffModel";

function inRange(pos: number, ranges: CharRange[] | undefined): boolean {
  if (!ranges) return false;
  for (const r of ranges) if (pos >= r.start && pos < r.end) return true;
  return false;
}

/** Search hits on one rendered row, and which of them is the current one. */
export interface LineMarks {
  ranges: CharRange[];
  active?: CharRange;
}

const INTRA = 1;
const MATCH = 2;
const ACTIVE = 4;

interface Seg {
  text: string;
  color?: string;
  /** bitmask of the overlays covering this run */
  mask: number;
}

/**
 * Split shiki tokens further at word-diff and search-match boundaries, so all
 * three layers survive: color comes from the token, background from whichever
 * overlay wins (active match > other match > word diff).
 */
function segments(
  content: string,
  toks: Tok[] | undefined,
  intra?: CharRange[],
  marks?: LineMarks,
): Seg[] {
  const source: Tok[] = toks && toks.length ? toks : [{ content }];
  const hasIntra = Boolean(intra && intra.length);
  const hasMarks = Boolean(marks && marks.ranges.length);
  if (!hasIntra && !hasMarks) {
    return source.map((t) => ({ text: t.content, color: t.color, mask: 0 }));
  }

  const maskAt = (pos: number) =>
    (hasIntra && inRange(pos, intra) ? INTRA : 0) |
    (hasMarks && inRange(pos, marks!.ranges) ? MATCH : 0) |
    (marks?.active && pos >= marks.active.start && pos < marks.active.end ? ACTIVE : 0);

  const out: Seg[] = [];
  let pos = 0;
  for (const t of source) {
    let buf = "";
    let bufMask = maskAt(pos);
    for (const ch of t.content) {
      const mask = maskAt(pos);
      if (mask !== bufMask && buf) {
        out.push({ text: buf, color: t.color, mask: bufMask });
        buf = "";
      }
      bufMask = mask;
      buf += ch;
      pos += ch.length;
    }
    if (buf) out.push({ text: buf, color: t.color, mask: bufMask });
  }
  return out;
}

/** Backgrounds stack, so only the winning overlay paints. */
function overlayBg(mask: number): string | undefined {
  if (mask & ACTIVE) return "var(--search-active)";
  if (mask & MATCH) return "var(--search-match)";
  if (mask & INTRA) return "var(--intra-bg)";
  return undefined;
}

function overlayClass(mask: number): string | undefined {
  if (mask & ACTIVE) return "search-mark search-mark-active";
  if (mask & MATCH) return "search-mark";
  if (mask & INTRA) return "intra";
  return undefined;
}

function renderContent(
  content: string,
  toks: Tok[] | undefined,
  intra?: CharRange[],
  marks?: LineMarks,
): ReactNode {
  const segs = segments(content, toks, intra, marks);
  const out: ReactNode[] = [];
  let indentDone = false;
  segs.forEach((s, i) => {
    let text = s.text;
    const bg = overlayBg(s.mask);
    const cls = overlayClass(s.mask);
    if (!indentDone) {
      const m = /^[ \t]+/.exec(text);
      if (m) {
        out.push(
          <span
            key={`i${i}`}
            className={cls ? `diff-indent ${cls}` : "diff-indent"}
            style={bg ? { background: bg } : undefined}
          >
            {m[0]}
          </span>,
        );
        text = text.slice(m[0].length);
      }
      if (text) indentDone = true;
    }
    if (!text) return;
    out.push(
      <span
        key={i}
        className={cls}
        style={{
          ...(s.color ? { color: s.color } : {}),
          ...(bg ? { background: bg } : {}),
        }}
      >
        {text}
      </span>,
    );
  });
  return out;
}

function bgFor(type: DiffRow["type"]) {
  return type === "add" ? "var(--add-bg)" : type === "del" ? "var(--del-bg)" : "transparent";
}
function gutterBgFor(type: DiffRow["type"]) {
  return type === "add"
    ? "var(--add-gutter)"
    : type === "del"
      ? "var(--del-gutter)"
      : "transparent";
}
function markerColor(type: DiffRow["type"]) {
  return type === "add" ? "var(--ok)" : type === "del" ? "var(--risk)" : "var(--fg-faint)";
}

function CommentButton({ onComment, hasComment }: { onComment?: () => void; hasComment?: boolean }) {
  if (!onComment) return <span className="w-[15px] flex-none" />;
  return (
    <button
      type="button"
      onClick={onComment}
      title="Draft a comment on this line"
      className="mx-0.5 my-[3px] h-[14px] w-[14px] flex-none rounded text-[10px] leading-[13px] opacity-0 transition-opacity group-hover:opacity-100"
      style={{
        background: hasComment ? "var(--accent)" : "var(--bg-hover)",
        color: hasComment ? "var(--bg)" : "var(--fg-muted)",
        opacity: hasComment ? 1 : undefined,
      }}
    >
      +
    </button>
  );
}

export type LineSide = "old" | "new";

/**
 * Line-number gutters double as the handle for selecting a range to quote:
 * mouse down starts (or, with shift, extends) a selection, and dragging over
 * further numbers grows it. The cursor only changes when a handler is wired,
 * so nothing looks clickable where a range would be meaningless.
 */
export interface GutterSelectProps {
  onSelectDown?: (side: LineSide, line: number, shiftKey: boolean) => void;
  onSelectEnter?: (side: LineSide, line: number) => void;
  selectedOld?: boolean;
  selectedNew?: boolean;
}

function Gutter({
  number,
  side,
  background,
  selected,
  onSelectDown,
  onSelectEnter,
}: {
  number?: number;
  side: LineSide;
  background: string;
  selected?: boolean;
} & Pick<GutterSelectProps, "onSelectDown" | "onSelectEnter">) {
  const interactive = Boolean(onSelectDown && number !== undefined);
  return (
    <span
      className={`diff-gutter${interactive ? " cursor-pointer select-none" : ""}`}
      style={{
        background: selected ? "var(--accent-soft)" : background,
        color: selected ? "var(--accent)" : undefined,
        boxShadow: selected ? "inset -2px 0 0 var(--accent)" : undefined,
      }}
      onMouseDown={
        interactive
          ? (e) => {
              e.preventDefault();
              onSelectDown!(side, number!, e.shiftKey);
            }
          : undefined
      }
      onMouseEnter={
        interactive && onSelectEnter ? () => onSelectEnter(side, number!) : undefined
      }
    >
      {number ?? ""}
    </span>
  );
}

export interface DiffLineProps extends GutterSelectProps {
  row: DiffRow;
  tokens?: Tok[];
  onComment?: () => void;
  hasComment?: boolean;
  /** search hits on this row, if a search is running */
  marks?: LineMarks;
}

export const DiffLine = memo(function DiffLine({
  row,
  tokens,
  onComment,
  hasComment,
  marks,
  onSelectDown,
  onSelectEnter,
  selectedOld,
  selectedNew,
}: DiffLineProps) {
  const intraBg = row.type === "add" ? "var(--add-bg-strong)" : "var(--del-bg-strong)";
  const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  const gutterBg = gutterBgFor(row.type);
  const selected = Boolean(selectedOld || selectedNew);

  return (
    <div
      className="diff-line group relative"
      data-type={row.type}
      data-selected={selected ? "true" : undefined}
      style={{
        background: bgFor(row.type),
        ["--intra-bg" as string]: intraBg,
        boxShadow: selected ? "inset 0 0 0 9999px var(--accent-soft)" : undefined,
      }}
    >
      <span className="diff-fixed">
        <Gutter
          number={row.oldNumber}
          side="old"
          background={gutterBg}
          selected={selectedOld}
          onSelectDown={onSelectDown}
          onSelectEnter={onSelectEnter}
        />
        <Gutter
          number={row.newNumber}
          side="new"
          background={gutterBg}
          selected={selectedNew}
          onSelectDown={onSelectDown}
          onSelectEnter={onSelectEnter}
        />
        <CommentButton onComment={onComment} hasComment={hasComment} />
        <span className="diff-marker" style={{ color: markerColor(row.type) }}>
          {marker}
        </span>
      </span>
      <span className="diff-code min-w-0 flex-1 pr-4">
        {renderContent(row.content, tokens, row.intra, marks)}
      </span>
    </div>
  );
});

export interface SplitHalfProps {
  row: DiffRow | null;
  /** which gutter number this side shows */
  side: LineSide;
  tokens?: Tok[];
  onComment?: () => void;
  hasComment?: boolean;
  marks?: LineMarks;
  selected?: boolean;
  onSelectDown?: GutterSelectProps["onSelectDown"];
  onSelectEnter?: GutterSelectProps["onSelectEnter"];
}

/** One side of a side-by-side row; `row === null` renders an empty filler. */
function SplitHalf({
  row,
  side,
  tokens,
  onComment,
  hasComment,
  marks,
  selected,
  onSelectDown,
  onSelectEnter,
}: SplitHalfProps) {
  if (!row) {
    return (
      <div className="diff-half" data-type="none" style={{ background: "var(--bg-inset)" }}>
        <span className="diff-fixed">
          <span className="diff-gutter" />
          <span className="w-[15px] flex-none" />
          <span className="diff-marker" />
        </span>
        <span className="diff-code min-w-0 flex-1" />
      </div>
    );
  }
  const intraBg = row.type === "add" ? "var(--add-bg-strong)" : "var(--del-bg-strong)";
  const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  return (
    <div
      className="diff-half group/half"
      data-type={row.type}
      data-selected={selected ? "true" : undefined}
      style={{
        background: bgFor(row.type),
        ["--intra-bg" as string]: intraBg,
        boxShadow: selected ? "inset 0 0 0 9999px var(--accent-soft)" : undefined,
      }}
    >
      <span className="diff-fixed">
        <Gutter
          number={side === "old" ? row.oldNumber : row.newNumber}
          side={side}
          background={gutterBgFor(row.type)}
          selected={selected}
          onSelectDown={onSelectDown}
          onSelectEnter={onSelectEnter}
        />
        <CommentButton onComment={onComment} hasComment={hasComment} />
        <span className="diff-marker" style={{ color: markerColor(row.type) }}>
          {marker}
        </span>
      </span>
      <span className="diff-code min-w-0 flex-1 pr-3">
        {renderContent(row.content, tokens, row.intra, marks)}
      </span>
    </div>
  );
}

export interface SplitDiffLineProps {
  left: DiffRow | null;
  right: DiffRow | null;
  leftTokens?: Tok[];
  rightTokens?: Tok[];
  onCommentLeft?: () => void;
  onCommentRight?: () => void;
  hasCommentLeft?: boolean;
  hasCommentRight?: boolean;
  marksLeft?: LineMarks;
  marksRight?: LineMarks;
  selectedLeft?: boolean;
  selectedRight?: boolean;
  onSelectDown?: GutterSelectProps["onSelectDown"];
  onSelectEnter?: GutterSelectProps["onSelectEnter"];
}

export const SplitDiffLine = memo(function SplitDiffLine({
  left,
  right,
  leftTokens,
  rightTokens,
  onCommentLeft,
  onCommentRight,
  hasCommentLeft,
  hasCommentRight,
  marksLeft,
  marksRight,
  selectedLeft,
  selectedRight,
  onSelectDown,
  onSelectEnter,
}: SplitDiffLineProps) {
  return (
    <div className="diff-split group flex">
      <SplitHalf
        row={left}
        side="old"
        tokens={leftTokens}
        onComment={onCommentLeft}
        hasComment={hasCommentLeft}
        marks={marksLeft}
        selected={selectedLeft}
        onSelectDown={onSelectDown}
        onSelectEnter={onSelectEnter}
      />
      <div className="diff-split-divider" />
      <SplitHalf
        row={right}
        side="new"
        tokens={rightTokens}
        onComment={onCommentRight}
        hasComment={hasCommentRight}
        marks={marksRight}
        selected={selectedRight}
        onSelectDown={onSelectDown}
        onSelectEnter={onSelectEnter}
      />
    </div>
  );
});
