import { memo, type ReactNode } from "react";
import type { Tok } from "../lib/highlight";
import type { CharRange, DiffRow } from "../lib/diffModel";

function inRange(pos: number, ranges: CharRange[] | undefined): boolean {
  if (!ranges) return false;
  for (const r of ranges) if (pos >= r.start && pos < r.end) return true;
  return false;
}

interface Seg {
  text: string;
  color?: string;
  hi?: boolean;
}

/** Split shiki tokens further at word-diff boundaries so both survive. */
function segments(content: string, toks: Tok[] | undefined, intra?: CharRange[]): Seg[] {
  const source: Tok[] = toks && toks.length ? toks : [{ content }];
  if (!intra || intra.length === 0) {
    return source.map((t) => ({ text: t.content, color: t.color }));
  }

  const out: Seg[] = [];
  let pos = 0;
  for (const t of source) {
    let buf = "";
    let bufHi = inRange(pos, intra);
    for (const ch of t.content) {
      const hi = inRange(pos, intra);
      if (hi !== bufHi && buf) {
        out.push({ text: buf, color: t.color, hi: bufHi });
        buf = "";
      }
      bufHi = hi;
      buf += ch;
      pos += ch.length;
    }
    if (buf) out.push({ text: buf, color: t.color, hi: bufHi });
  }
  return out;
}

function renderContent(content: string, toks: Tok[] | undefined, intra?: CharRange[]): ReactNode {
  const segs = segments(content, toks, intra);
  const out: ReactNode[] = [];
  let indentDone = false;
  segs.forEach((s, i) => {
    let text = s.text;
    if (!indentDone) {
      const m = /^[ \t]+/.exec(text);
      if (m) {
        out.push(
          <span
            key={`i${i}`}
            className={s.hi ? "diff-indent intra" : "diff-indent"}
            style={s.hi ? { background: "var(--intra-bg)" } : undefined}
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
        className={s.hi ? "intra" : undefined}
        style={{
          ...(s.color ? { color: s.color } : {}),
          ...(s.hi ? { background: "var(--intra-bg)" } : {}),
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
}

export const DiffLine = memo(function DiffLine({
  row,
  tokens,
  onComment,
  hasComment,
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
        {renderContent(row.content, tokens, row.intra)}
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
        {renderContent(row.content, tokens, row.intra)}
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
        selected={selectedRight}
        onSelectDown={onSelectDown}
        onSelectEnter={onSelectEnter}
      />
    </div>
  );
});
