import { useLayoutEffect, useRef } from "react";
import type { StripColumn, StripMark, StripRow } from "../../lib/revisionStrip";
import { stripStatus, type RevisionStripModel } from "../../lib/revisionStrip";
import { formatAddedAt, formatFullTimestamp } from "../../lib/prList";
import { UnitNumber } from "../Chips";
import { InlineMarkdown } from "../Markdown";
import { SectionHead } from "../SectionHead";

const TITLE_COL = "minmax(8rem, 24rem)";
const REV_W = 2.75;
const BASE_W = 1.25;
const STATUS_W = 5;

/**
 * Each revision against each unit (experiment `revisionStrip`): a column per
 * revision, a row per unit in the overview's reading order. A unit's line
 * runs through the revisions it existed in; a dot is a revision its
 * changelog names (hover for the line), a ring the revision it arrived in,
 * a cross the one it left in. The shaded stretch is how far you had read it:
 * a dot past it, in the accent, moved after you last looked, and the row
 * ends on "since rN". Many revisions scroll sideways inside the section,
 * newest in view, the titles pinned; a base-only revision is a narrow
 * column. A row opens its unit.
 */
export function RevisionStrip({
  model,
  onOpenUnit,
}: {
  model: RevisionStripModel;
  onOpenUnit: (unitId: string) => void;
}) {
  const { columns, rows } = model;
  const scroller = useRef<HTMLDivElement>(null);
  const widths = columns.map((c) => (c.baseOnly ? BASE_W : REV_W));
  const template = `${TITLE_COL} ${widths.map((w) => `${w}rem`).join(" ")} ${STATUS_W}rem`;
  const minWidth = `${8 + widths.reduce((a, b) => a + b, 0) + STATUS_W}rem`;

  // Newest revisions in view: with more than fit, the old ones are a scroll away.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [columns.length]);

  return (
    <section data-testid="overview-revisions" data-section="revisions">
      <SectionHead title="Revisions">
        {model.stale ? (
          <span className="chip" style={{ color: "var(--accent)", background: "var(--accent-soft)" }} data-testid="revision-strip-stale">
            {model.stale} moved since you read {model.stale === 1 ? "it" : "them"}
          </span>
        ) : null}
      </SectionHead>
      <div ref={scroller} className="quiet-scroll -mx-2 overflow-x-auto px-2 pb-1" data-testid="revision-strip">
        <div style={{ minWidth }} role="table" aria-label="Units changed in each revision">
          <div role="row" className="grid items-end pb-1" style={{ gridTemplateColumns: template }}>
            <span role="columnheader" className="sticky left-0 z-[1] self-stretch" style={{ background: "var(--bg-raised)" }} />
            {columns.map((c) => (
              <ColumnHead key={c.revision} column={c} />
            ))}
            <span role="columnheader" />
          </div>
          {rows.map((r) => (
            <Row key={r.id} row={r} columns={columns} template={template} onOpenUnit={onOpenUnit} />
          ))}
        </div>
      </div>
      <Legend />
    </section>
  );
}

function ColumnHead({ column: c }: { column: StripColumn }) {
  const when = c.addedAt ? formatAddedAt(c.addedAt) : "";
  const tip = [
    `r${c.revision}${c.baseOnly ? " · base moved only" : ""}${c.addedAt ? ` · ${formatFullTimestamp(c.addedAt)}` : ""}`,
    c.summary,
    c.reviewed ? "Your last review was on this revision." : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      role="columnheader"
      className="flex flex-col items-center text-2xs leading-4 tabular-nums"
      data-tip={tip}
      data-testid={`revision-strip-col-${c.revision}`}
    >
      {c.baseOnly ? (
        <span style={{ color: "var(--fg-faint)" }}>·</span>
      ) : (
        <>
          <span className="flex items-center gap-0.5" style={{ color: c.current ? "var(--fg)" : "var(--fg-muted)", fontWeight: c.current ? 600 : 400 }}>
            r{c.revision}
            {c.reviewed ? (
              <span className="inline-block h-1 w-1 rounded-full" style={{ background: "var(--accent)" }} aria-label="your review" />
            ) : null}
          </span>
          <span className="max-w-full truncate" style={{ color: "var(--fg-faint)" }}>
            {when}
          </span>
        </>
      )}
    </span>
  );
}

function Row({
  row,
  columns,
  template,
  onOpenUnit,
}: {
  row: StripRow;
  columns: StripColumn[];
  template: string;
  onOpenUnit: (unitId: string) => void;
}) {
  const status = stripStatus(row);
  const open = row.removed ? undefined : () => onOpenUnit(row.id);
  const byRevision = new Map(row.marks.map((m) => [m.revision, m]));
  const titleInk = row.removed ? "var(--fg-faint)" : "var(--fg)";
  const title = (
    <>
      <span className="flex w-5 flex-none justify-center">
        {row.number !== undefined ? <UnitNumber number={row.number} /> : null}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${row.removed ? "line-through" : ""}`} style={{ color: titleInk }}>
        <InlineMarkdown text={row.title} />
      </span>
    </>
  );
  return (
    <div
      role="row"
      data-testid={`revision-strip-row-${row.id}`}
      data-stale={row.stale || undefined}
      className={`group grid rounded-md transition-colors ${open ? "cursor-pointer hover:bg-[var(--bg-hover)]" : ""}`}
      style={{ gridTemplateColumns: template }}
      onClick={open}
      data-tip={row.removed ? `Every hunk of it left the PR in r${row.to}` : undefined}
    >
      <span
        role="rowheader"
        className={`sticky left-0 z-[1] flex min-w-0 items-center rounded-l-md bg-[var(--bg-raised)] pr-2 transition-colors ${open ? "group-hover:bg-[var(--bg-hover)]" : ""}`}
      >
        {open ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            aria-label={`Open ${row.title}${status ? `, ${status.tip}` : ""}`}
          >
            {title}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2 py-1">{title}</span>
        )}
      </span>
      {columns.map((c, i) => (
        <Cell key={c.revision} row={row} column={c} prev={columns[i - 1]} next={columns[i + 1]} mark={byRevision.get(c.revision)} />
      ))}
      <span role="cell" className="flex items-center justify-end pl-1">
        {status ? (
          <span
            className={status.stale ? "chip" : "text-2xs"}
            style={status.stale ? { color: "var(--accent)", background: "var(--accent-soft)" } : { color: "var(--fg-faint)" }}
            data-tip={status.tip}
            data-testid={`revision-strip-status-${row.id}`}
          >
            {status.label}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * One revision of one unit: the unit's line where it existed, the read band
 * up to the revision it was last read at, and the mark if this revision
 * touched it. The line and band run edge to edge between neighbours, so a
 * row reads as one stroke.
 */
function Cell({
  row,
  column: c,
  prev,
  next,
  mark,
}: {
  row: StripRow;
  column: StripColumn;
  prev?: StripColumn;
  next?: StripColumn;
  mark?: StripMark;
}) {
  const rev = c.revision;
  const alive = rev >= row.from && rev <= row.to;
  const read = row.readAt !== undefined && alive && rev <= row.readAt;
  // The line runs where the band does not: the band already says the unit was there.
  const lineLeft = alive && !read && prev !== undefined && prev.revision >= row.from;
  const lineRight = alive && !read && next !== undefined && next.revision <= row.to;
  const readLeft = read && prev !== undefined && prev.revision >= row.from;
  const readRight = read && next !== undefined && next.revision <= row.readAt!;
  return (
    <span role="cell" className="relative flex h-7 items-center justify-center" data-testid={mark ? `revision-strip-mark-${row.id}-${rev}` : undefined}>
      {read ? (
        <span
          aria-hidden
          className="absolute inset-y-1"
          style={{
            left: readLeft ? 0 : "20%",
            // the unit goes on past the band: the band nearly meets the line
            right: readRight ? 0 : next !== undefined && next.revision <= row.to ? 3 : "20%",
            background: "var(--ok-soft)",
            borderTopLeftRadius: readLeft ? 0 : 6,
            borderBottomLeftRadius: readLeft ? 0 : 6,
            borderTopRightRadius: readRight ? 0 : 6,
            borderBottomRightRadius: readRight ? 0 : 6,
          }}
        />
      ) : null}
      {/* The line stops short of a mark, so a ring stays hollow on any row tint. */}
      {lineLeft ? <Line left="0" right={mark ? "calc(50% + 7px)" : "50%"} /> : null}
      {lineRight ? <Line left={mark ? "calc(50% + 7px)" : "50%"} right="0" /> : null}
      {mark ? <Mark mark={mark} /> : null}
    </span>
  );
}

function Line({ left, right }: { left: string; right: string }) {
  return <span aria-hidden className="absolute top-1/2 h-px" style={{ left, right, background: "var(--border-strong)" }} />;
}

const MARK_WORD: Record<StripMark["kind"], string> = { added: "arrived", changed: "changed", removed: "left the PR" };

function Mark({ mark }: { mark: StripMark }) {
  const ink = mark.unread ? "var(--accent)" : "var(--fg-muted)";
  const tip = `r${mark.revision} · ${mark.text ?? MARK_WORD[mark.kind]}${mark.unread ? "\nAfter you last read it" : ""}`;
  if (mark.kind === "removed") {
    return (
      <span className="relative text-[13px] font-semibold leading-none" style={{ color: ink }} data-tip={tip} aria-label={tip}>
        ×
      </span>
    );
  }
  return (
    <span
      className="relative block h-2.5 w-2.5 rounded-full"
      data-tip={tip}
      aria-label={tip}
      data-kind={mark.kind}
      data-unread={mark.unread || undefined}
      style={
        mark.kind === "added"
          ? { border: `2px solid ${ink}` }
          : { background: ink }
      }
    />
  );
}

function Legend() {
  const item = "inline-flex items-center gap-1.5";
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs" style={{ color: "var(--fg-faint)" }} aria-hidden>
      <span className={item}>
        <span className="block h-2 w-2 rounded-full" style={{ background: "var(--fg-muted)" }} />
        changed
      </span>
      <span className={item}>
        <span className="block h-2 w-2 rounded-full" style={{ border: "2px solid var(--fg-muted)" }} />
        new unit
      </span>
      <span className={item}>
        <span className="block h-2 w-2 rounded-full" style={{ background: "var(--accent)" }} />
        after you read it
      </span>
      <span className={item}>
        <span className="block h-2.5 w-5 rounded" style={{ background: "var(--ok-soft)" }} />
        read up to
      </span>
    </p>
  );
}
