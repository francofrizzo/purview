import { memo, type MouseEvent, type ReactNode } from "react";
import type { DraftComment } from "../api/types";
import type { Tok } from "../lib/highlight";
import type { CharRange, DiffRow } from "../lib/diffModel";
import { identifierAtPoint } from "../lib/identifierAt";
import { CommentBubble } from "./InlineComments";

/**
 * Cmd/ctrl+click "go to definition": resolve the identifier under the click
 * point (see lib/identifierAt.ts) and hand it up. A plain click, a cmd+click
 * that misses an identifier, or a cmd+click on one with no definition in this
 * diff (see `IsDefinedInDiff`) is left alone — this must never interfere with
 * normal text selection or the comment affordances.
 */
export type OnDefinitionClick = (symbol: string) => void;

/** Whether `symbol` has a definition in this diff — see lib/definitions.ts's
 *  `buildDefinitionIndex`. Anything not in the index does nothing at all. */
export type IsDefinedInDiff = (symbol: string) => boolean;

function handleDefinitionClick(
  e: MouseEvent<HTMLSpanElement>,
  onDefinitionClick?: OnDefinitionClick,
  isDefinedInDiff?: IsDefinedInDiff,
) {
  if (!onDefinitionClick || !(e.metaKey || e.ctrlKey)) return;
  const symbol = identifierAtPoint(e.currentTarget, e.clientX, e.clientY);
  if (!symbol || !isDefinedInDiff?.(symbol)) return;
  e.preventDefault();
  onDefinitionClick(symbol);
}

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

/**
 * `moved` overrides the add/del tint with the same violet used everywhere
 * else for a code move (see lib/moveDetection.ts + lib/themes.ts) — it never
 * applies to context lines, which are shared, unmoved code either way.
 */
function bgFor(type: DiffRow["type"], moved?: boolean) {
  // Direction is a hue: violet where the code arrived, cyan where it left.
  if (type === "add") return moved ? "var(--moved-bg)" : "var(--add-bg)";
  if (type === "del") return moved ? "var(--moved-out-bg)" : "var(--del-bg)";
  return "transparent";
}
/** Row background, with the "changed in rN" tint layered over it when marked. */
function rowBackground(type: DiffRow["type"], moved?: boolean, changed?: boolean) {
  const base = bgFor(type, moved);
  return changed ? `linear-gradient(var(--changed-in-bg), var(--changed-in-bg)), ${base}` : base;
}
function gutterBgFor(type: DiffRow["type"], moved?: boolean) {
  if (type === "add") return moved ? "var(--moved-gutter)" : "var(--add-gutter)";
  if (type === "del") return moved ? "var(--moved-out-gutter)" : "var(--del-gutter)";
  return "transparent";
}
function markerColor(type: DiffRow["type"]) {
  return type === "add" ? "var(--ok)" : type === "del" ? "var(--risk)" : "var(--fg-faint)";
}

/**
 * The comment column: a bubble when the line already has comments (always
 * visible — that is the whole point), and the `+` add affordance, still
 * hover-only. Two slots, one fixed width, so every line in the pane keeps the
 * same code column no matter what hangs off it.
 */
export const COMMENT_COL_WIDTH = 30;

export interface LineCommentProps {
  /** comments anchored to this line; undefined/empty renders no bubble */
  comments?: DraftComment[];
  expanded?: boolean;
  onToggleComments?: () => void;
}

function CommentColumn({
  onComment,
  comments,
  expanded,
  onToggleComments,
}: { onComment?: () => void } & LineCommentProps) {
  const has = Boolean(comments && comments.length);
  return (
    <span
      className="flex flex-none items-start justify-end gap-[1px]"
      style={{ width: COMMENT_COL_WIDTH }}
    >
      {has && onToggleComments ? (
        <CommentBubble
          compact
          comments={comments!}
          expanded={Boolean(expanded)}
          onToggle={onToggleComments}
        />
      ) : null}
      {onComment ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onComment();
          }}
          title={has ? "Add another comment on this line" : "Draft a comment on this line"}
          className="diff-comment-affordance my-[2px] h-[13px] w-[13px] flex-none rounded text-[10px] leading-[12px] opacity-0 transition-opacity group-hover:opacity-100 group-hover/half:opacity-100"
          style={{ background: "var(--bg-hover)", color: "var(--fg-muted)" }}
        >
          +
        </button>
      ) : null}
    </span>
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
  action,
}: {
  number?: number;
  side: LineSide;
  background: string;
  selected?: boolean;
  /** overlaid at the gutter's left edge (see `foldAction`) — the gutter sits
   *  in the pinned column, so it stays put when wrap is off */
  action?: ReactNode;
} & Pick<GutterSelectProps, "onSelectDown" | "onSelectEnter">) {
  const interactive = Boolean(onSelectDown && number !== undefined);
  return (
    <span
      className={`diff-gutter${interactive ? " cursor-pointer select-none" : ""}${action ? " relative" : ""}`}
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
      {action}
      {number ?? ""}
    </span>
  );
}

/**
 * "K lines removed in rN" (the changelog highlight's pure deletions): a thin
 * dashed rule on the top edge of the row that now follows the deleted run, or
 * on the bottom edge of a hunk's last row. Absolutely positioned inside the
 * code column so it never changes the row's height (virtualization measures it).
 */
export interface RemovalMarkerProps {
  /** tooltip for lines removed just above this row */
  removedAbove?: string;
  /** tooltip for lines removed just below this row (a hunk's last row only) */
  removedBelow?: string;
}

function RemovalMarkers({ removedAbove, removedBelow }: RemovalMarkerProps) {
  return (
    <>
      {removedAbove ? (
        <span className="removed-marker" data-edge="above" title={removedAbove} aria-label={removedAbove} />
      ) : null}
      {removedBelow ? (
        <span className="removed-marker" data-edge="below" title={removedBelow} aria-label={removedBelow} />
      ) : null}
    </>
  );
}

export interface DiffLineProps extends GutterSelectProps, LineCommentProps, RemovalMarkerProps {
  row: DiffRow;
  tokens?: Tok[];
  onComment?: () => void;
  /** search hits on this row, if a search is running */
  marks?: LineMarks;
  /** true when this row's hunk is a detected move (see lib/moveDetection.ts) */
  moved?: boolean;
  /** a control overlaid on the gutter — the "fold back up" button on the
   *  first line of an opened moved-code region */
  foldAction?: ReactNode;
  /** the highlighted changelog revision introduced this line (see lib/revisionHighlight.ts) */
  changed?: boolean;
  onDefinitionClick?: OnDefinitionClick;
  isDefinedInDiff?: IsDefinedInDiff;
}

export const DiffLine = memo(function DiffLine({
  row,
  tokens,
  onComment,
  comments,
  expanded,
  onToggleComments,
  marks,
  onSelectDown,
  onSelectEnter,
  selectedOld,
  selectedNew,
  moved,
  foldAction,
  changed,
  removedAbove,
  removedBelow,
  onDefinitionClick,
  isDefinedInDiff,
}: DiffLineProps) {
  const intraBg =
    row.type === "add"
      ? moved
        ? "var(--moved-bg-strong)"
        : "var(--add-bg-strong)"
      : moved
        ? "var(--moved-out-bg-strong)"
        : "var(--del-bg-strong)";
  const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  const gutterBg = gutterBgFor(row.type, moved);
  const selected = Boolean(selectedOld || selectedNew);

  return (
    <div
      className="diff-line group relative"
      data-type={row.type}
      data-moved={moved ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-changed={changed ? "true" : undefined}
      style={{
        background: rowBackground(row.type, moved, changed),
        ...(changed ? { ["--row-bg" as string]: bgFor(row.type, moved) } : {}),
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
          action={foldAction}
        />
        <Gutter
          number={row.newNumber}
          side="new"
          background={gutterBg}
          selected={selectedNew}
          onSelectDown={onSelectDown}
          onSelectEnter={onSelectEnter}
        />
        <CommentColumn
          onComment={onComment}
          comments={comments}
          expanded={expanded}
          onToggleComments={onToggleComments}
        />
        <span className="diff-marker" style={{ color: markerColor(row.type) }}>
          {marker}
        </span>
      </span>
      <span
        className="diff-code relative min-w-0 flex-1 pr-4"
        onClick={(e) => handleDefinitionClick(e, onDefinitionClick, isDefinedInDiff)}
      >
        <RemovalMarkers removedAbove={removedAbove} removedBelow={removedBelow} />
        {renderContent(row.content, tokens, row.intra, marks)}
      </span>
    </div>
  );
});

export interface SplitHalfProps extends LineCommentProps, RemovalMarkerProps {
  row: DiffRow | null;
  /** which gutter number this side shows */
  side: LineSide;
  tokens?: Tok[];
  onComment?: () => void;
  marks?: LineMarks;
  selected?: boolean;
  onSelectDown?: GutterSelectProps["onSelectDown"];
  onSelectEnter?: GutterSelectProps["onSelectEnter"];
  /** true when this row's hunk is a detected move (see lib/moveDetection.ts) */
  moved?: boolean;
  foldAction?: ReactNode;
  changed?: boolean;
  onDefinitionClick?: OnDefinitionClick;
  isDefinedInDiff?: IsDefinedInDiff;
}

/** One side of a side-by-side row; `row === null` renders an empty filler. */
function SplitHalf({
  row,
  side,
  tokens,
  onComment,
  comments,
  expanded,
  onToggleComments,
  marks,
  selected,
  onSelectDown,
  onSelectEnter,
  moved,
  foldAction,
  changed,
  removedAbove,
  removedBelow,
  onDefinitionClick,
  isDefinedInDiff,
}: SplitHalfProps) {
  if (!row) {
    return (
      <div className="diff-half" data-type="none" style={{ background: "var(--bg-inset)" }}>
        <span className="diff-fixed">
          <span className="diff-gutter" />
          <span className="flex-none" style={{ width: COMMENT_COL_WIDTH }} />
          <span className="diff-marker" />
        </span>
        <span className="diff-code relative min-w-0 flex-1">
          <RemovalMarkers removedAbove={removedAbove} removedBelow={removedBelow} />
        </span>
      </div>
    );
  }
  const intraBg =
    row.type === "add"
      ? moved
        ? "var(--moved-bg-strong)"
        : "var(--add-bg-strong)"
      : moved
        ? "var(--moved-out-bg-strong)"
        : "var(--del-bg-strong)";
  const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  return (
    <div
      className="diff-half group/half"
      data-type={row.type}
      data-moved={moved ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-changed={changed ? "true" : undefined}
      style={{
        background: rowBackground(row.type, moved, changed),
        ...(changed ? { ["--row-bg" as string]: bgFor(row.type, moved) } : {}),
        ["--intra-bg" as string]: intraBg,
        boxShadow: selected ? "inset 0 0 0 9999px var(--accent-soft)" : undefined,
      }}
    >
      <span className="diff-fixed">
        <Gutter
          number={side === "old" ? row.oldNumber : row.newNumber}
          side={side}
          background={gutterBgFor(row.type, moved)}
          selected={selected}
          onSelectDown={onSelectDown}
          onSelectEnter={onSelectEnter}
          action={foldAction}
        />
        <CommentColumn
          onComment={onComment}
          comments={comments}
          expanded={expanded}
          onToggleComments={onToggleComments}
        />
        <span className="diff-marker" style={{ color: markerColor(row.type) }}>
          {marker}
        </span>
      </span>
      <span
        className="diff-code relative min-w-0 flex-1 pr-3"
        onClick={(e) => handleDefinitionClick(e, onDefinitionClick, isDefinedInDiff)}
      >
        <RemovalMarkers removedAbove={removedAbove} removedBelow={removedBelow} />
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
  commentsLeft?: DraftComment[];
  commentsRight?: DraftComment[];
  expandedLeft?: boolean;
  expandedRight?: boolean;
  onToggleCommentsLeft?: () => void;
  onToggleCommentsRight?: () => void;
  marksLeft?: LineMarks;
  marksRight?: LineMarks;
  selectedLeft?: boolean;
  selectedRight?: boolean;
  onSelectDown?: GutterSelectProps["onSelectDown"];
  onSelectEnter?: GutterSelectProps["onSelectEnter"];
  /**
   * Move status is per-line (see lib/moveDetection.ts's `HunkMoves`), so the
   * two halves take it independently: `left` is a del row (checked against
   * `movedOut`), `right` is an add row (checked against `movedIn`) — a mixed
   * hunk can have one side moved and not the other.
   */
  movedLeft?: boolean;
  movedRight?: boolean;
  /** "fold back up" control, on whichever half carries the moved region */
  foldActionLeft?: ReactNode;
  foldActionRight?: ReactNode;
  /**
   * "Changed in rN", per side: '-' lines mark on the left, '+' and context
   * lines on the right (a context row is on both sides; it marks only once).
   */
  changedLeft?: boolean;
  changedRight?: boolean;
  /** "K lines removed in rN" markers; split view draws them on the left (old) half */
  removedAboveLeft?: string;
  removedBelowLeft?: string;
  onDefinitionClick?: OnDefinitionClick;
  isDefinedInDiff?: IsDefinedInDiff;
}

export const SplitDiffLine = memo(function SplitDiffLine({
  left,
  right,
  leftTokens,
  rightTokens,
  onCommentLeft,
  onCommentRight,
  commentsLeft,
  commentsRight,
  expandedLeft,
  expandedRight,
  onToggleCommentsLeft,
  onToggleCommentsRight,
  marksLeft,
  marksRight,
  selectedLeft,
  selectedRight,
  onSelectDown,
  onSelectEnter,
  movedLeft,
  movedRight,
  foldActionLeft,
  foldActionRight,
  changedLeft,
  changedRight,
  removedAboveLeft,
  removedBelowLeft,
  onDefinitionClick,
  isDefinedInDiff,
}: SplitDiffLineProps) {
  return (
    <div className="diff-split group flex">
      <SplitHalf
        row={left}
        side="old"
        tokens={leftTokens}
        onComment={onCommentLeft}
        comments={commentsLeft}
        expanded={expandedLeft}
        onToggleComments={onToggleCommentsLeft}
        marks={marksLeft}
        selected={selectedLeft}
        onSelectDown={onSelectDown}
        onSelectEnter={onSelectEnter}
        moved={movedLeft}
        foldAction={foldActionLeft}
        changed={changedLeft}
        removedAbove={removedAboveLeft}
        removedBelow={removedBelowLeft}
        onDefinitionClick={onDefinitionClick}
        isDefinedInDiff={isDefinedInDiff}
      />
      <div className="diff-split-divider" />
      <SplitHalf
        row={right}
        side="new"
        tokens={rightTokens}
        onComment={onCommentRight}
        comments={commentsRight}
        expanded={expandedRight}
        onToggleComments={onToggleCommentsRight}
        marks={marksRight}
        selected={selectedRight}
        onSelectDown={onSelectDown}
        onSelectEnter={onSelectEnter}
        moved={movedRight}
        foldAction={foldActionRight}
        changed={changedRight}
        onDefinitionClick={onDefinitionClick}
        isDefinedInDiff={isDefinedInDiff}
      />
    </div>
  );
});
