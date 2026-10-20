import { useId, useMemo } from "react";
import type { FileEntry, FileNotes, Flow, ReviewUnit, ShapeStatus } from "../api/types";
import { fileTree, flowRows } from "../lib/shape";
import { InlineMarkdown } from "./Markdown";

const STATUS_INK: Record<ShapeStatus, string> = {
  added: "var(--ok)",
  changed: "var(--warn)",
  removed: "var(--risk)",
  context: "var(--fg-faint)",
};

/**
 * The PR's files as a tree, each with the analysis's one-line note: where the
 * change lands and what each file does in it, the way a design doc shows it.
 * New files carry a `+` and the add tint, deleted ones a `−` and the del
 * tint (the names stay in plain ink); a file opens in the Files view.
 */
export function FileShape({
  files,
  notes = {},
  onOpenFile,
}: {
  files: FileEntry[];
  notes?: FileNotes;
  onOpenFile?: (path: string) => void;
}) {
  const own = files.filter((f) => !f.generated);
  const generated = files.length - own.length;
  const lines = useMemo(() => fileTree(own, notes), [own, notes]);
  // Notes start at one column, like comments in a listing: past the longest
  // noted line, but never so far out that short names float alone.
  const width = (l: (typeof lines)[number]) => l.prefix.length + l.name.length;
  const noted = lines.filter((l) => l.note);
  const column = Math.min(52, Math.max(0, ...noted.map(width)) + 3);

  return (
    <div
      className="overflow-x-auto rounded-lg border py-2 font-mono text-[12px] leading-[20px]"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
      data-testid="file-shape"
    >
      {lines.map((l, i) => {
        const added = l.status === "added";
        const removed = l.status === "removed";
        return (
          <div
            key={`${i}:${l.path ?? l.name}`}
            className="flex items-start whitespace-pre pr-4"
            style={added ? { background: "var(--add-bg)" } : removed ? { background: "var(--del-bg)" } : undefined}
          >
            <span className="w-6 flex-none text-center" style={{ color: added ? "var(--ok)" : "var(--risk)" }}>
              {added ? "+" : removed ? "−" : " "}
            </span>
            <span className="flex-none" style={{ color: "var(--fg-faint)" }}>{l.prefix}</span>
            {l.dir ? (
              <span className="flex-none" style={{ color: "var(--fg-muted)" }}>
                {l.name}
                {l.folded ? <span style={{ color: "var(--fg-faint)" }}>{`  · ${l.folded} files`}</span> : null}
              </span>
            ) : (
              <button
                type="button"
                className="flex-none hover:underline"
                style={{ color: "var(--fg)", textDecoration: removed ? "line-through" : undefined }}
                onClick={() => l.path && onOpenFile?.(l.path)}
                data-tip={l.path}
                data-testid={`file-shape-${l.path}`}
              >
                {l.name}
              </button>
            )}
            {l.note ? (
              // Only the note wraps, inside its own column, so a long one
              // never pushes its file's name off its line.
              <span
                className="min-w-0 whitespace-normal"
                style={{ color: "var(--fg-faint)", marginLeft: `${Math.max(2, column - width(l))}ch` }}
              >
                # <InlineMarkdown text={l.note} />
              </span>
            ) : null}
          </div>
        );
      })}
      {generated ? (
        <div className="flex whitespace-pre" style={{ color: "var(--fg-faint)" }}>
          <span className="w-6 flex-none" />
          {`… ${generated} generated ${generated === 1 ? "file" : "files"}, not read by the analysis`}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The tree's key, as counts: what the marks mean and how much of each there
 * is. Each mark is drawn the way its rows are; unmarked rows are changed.
 */
export function FileLegend({ files }: { files: FileEntry[] }) {
  const own = files.filter((f) => !f.generated);
  const added = own.filter((f) => f.status === "added").length;
  const removed = own.filter((f) => f.status === "removed").length;
  const changed = own.length - added - removed;
  const mark = (glyph: string, bg: string, ink: string) => (
    <span className="rounded px-1 font-mono" style={{ background: bg, color: ink }}>
      {glyph}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="file-legend">
      {added ? (
        <span className="flex items-center gap-1">
          {mark("+", "var(--add-bg)", "var(--ok)")} {added} new
        </span>
      ) : null}
      {removed ? (
        <span className="flex items-center gap-1">
          {mark("−", "var(--del-bg)", "var(--risk)")} {removed} deleted
        </span>
      ) : null}
      {changed ? <span>{changed} changed</span> : null}
    </div>
  );
}

const MIN_COL = 170;
/** Narrower than this the labels stop reading; the pane scrolls instead. */
const MIN_SCALE = 0.8;
/** Average advance of the label fonts, for sizing without measuring. */
const MONO_CH = 7.3;
const SANS_CH = 6.2;
const HEAD = 30;
const ROW = 32;
const BAND = 26;

/**
 * One runtime path as a sequence diagram: lifelines left to right, messages
 * top to bottom, calls solid and returns dashed, each coloured by what the PR
 * does to it (a cut step is struck out). Laid out by hand, so it is the same
 * drawing every time; a step or a lifeline opens the unit that changes it.
 */
export function FlowView({
  flow,
  units,
  onOpenUnit,
}: {
  flow: Flow;
  units: ReviewUnit[];
  onOpenUnit?: (unitId: string) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const rows = useMemo(() => flowRows(flow), [flow]);
  const index = new Map(flow.participants.map((p, i) => [p.id, i]));
  const titles = new Map(units.map((u, i) => [u.id, `${i + 1}. ${u.title}`]));
  // Each lifeline gets the width its own box label needs, and the drawing
  // grows to the right for a self-step label that would run off it.
  const cols = flow.participants.map((p) => Math.max(MIN_COL, p.label.length * MONO_CH + 40));
  const lefts = cols.map((_, i) => cols.slice(0, i).reduce((a, b) => a + b, 0));
  const x = (id: string) => {
    const i = index.get(id) ?? 0;
    return lefts[i] + cols[i] / 2;
  };
  const width = Math.max(
    cols.reduce((a, b) => a + b, 0),
    ...flow.steps.filter((s) => s.from === s.to).map((s) => x(s.from) + 30 + s.label.length * SANS_CH + 12),
  );
  const top = HEAD + 14;
  const height = top + rows.reduce((h, r) => h + (r.kind === "phase" ? BAND : ROW), 0) + 10;
  // A step or a box that names a unit opens it; its tip says which, the one
  // thing the drawing doesn't already show. One that names none is inert.
  const link = (ids: string[]) => {
    const known = ids.filter((u) => titles.has(u));
    if (!known.length) return {};
    const [first, ...rest] = known.map((u) => titles.get(u)!);
    return {
      className: "flow-link",
      "data-tip": `Opens ${first}${rest.length ? ` · also ${rest.join(", ")}` : ""}`,
      onClick: () => onOpenUnit?.(known[0]),
      style: { cursor: "pointer" },
    };
  };

  let y = top;
  return (
    <div className="overflow-x-auto" data-testid="flow-view">
      {/* Fits the pane down to MIN_SCALE, then scrolls. */}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mx-auto block"
        style={{ width: "100%", maxWidth: width, minWidth: width * MIN_SCALE }}
        role="img"
        aria-label="Flow of the change"
      >
        <defs>
          {(["added", "changed", "removed", "context"] as const).map((s) => (
            <marker
              key={s}
              id={`${uid}-${s}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: STATUS_INK[s] }} />
            </marker>
          ))}
        </defs>

        {flow.participants.map((p, i) => {
          const cx = x(p.id);
          const col = cols[i];
          const ids = p.units ?? [];
          // Only the box opens the unit: the lifeline runs under every step.
          return (
            <g key={p.id}>
              <line x1={cx} y1={HEAD} x2={cx} y2={height - 4} style={{ stroke: "var(--border-strong)", strokeDasharray: "2 4" }} />
              <g data-flow-participant={p.id} {...link(ids)}>
                <rect
                  x={cx - col / 2 + 12}
                  y={2}
                  width={col - 24}
                  height={HEAD - 4}
                  rx={6}
                  style={{
                    fill: "var(--bg-raised)",
                    stroke: p.status === "context" ? "var(--border-strong)" : STATUS_INK[p.status],
                    strokeDasharray: p.status === "removed" ? "4 3" : undefined,
                  }}
                />
                <text
                  x={cx}
                  y={HEAD / 2 + 4}
                  textAnchor="middle"
                  style={{ fill: p.status === "context" ? "var(--fg-muted)" : "var(--fg)", fontSize: 12, fontFamily: "var(--font-code)" }}
                >
                  {p.label}
                </text>
              </g>
            </g>
          );
        })}

        {rows.map((r, i) => {
          if (r.kind === "phase") {
            const at = y;
            y += BAND;
            return (
              <g key={`p${i}`}>
                <rect x={6} y={at + 3} width={width - 12} height={BAND - 6} rx={4} style={{ fill: "var(--bg-inset)" }} />
                <text x={width / 2} y={at + BAND / 2 + 4} textAnchor="middle" style={{ fill: "var(--fg-muted)", fontSize: 11.5 }}>
                  {r.label}
                </text>
              </g>
            );
          }
          const s = flow.steps[r.index];
          const at = y;
          y += ROW;
          const line = at + ROW - 9;
          const ink = STATUS_INK[s.status];
          const dashed = s.kind === "return" || s.status === "removed";
          const self = s.from === s.to;
          const x1 = x(s.from);
          const x2 = x(s.to);
          const ids = s.units ?? [];
          const text = {
            fill: s.status === "context" ? "var(--fg-muted)" : "var(--fg)",
            fontSize: 11.5,
            textDecoration: s.status === "removed" ? "line-through" : undefined,
          } as const;
          if (self) {
            return (
              <g key={`s${i}`} data-flow-step={r.index} {...link(ids)}>
                <path
                  d={`M${x1},${line - 10} h22 v12 h-20`}
                  markerEnd={`url(#${uid}-${s.status})`}
                  style={{ fill: "none", stroke: ink, strokeWidth: 1.4, strokeDasharray: dashed ? "4 3" : undefined }}
                />
                <text x={x1 + 30} y={line - 1} style={text}>
                  {s.label}
                </text>
              </g>
            );
          }
          // Labels may run past their span (one per row, nothing to collide
          // with) but never off the drawing.
          const half = (s.label.length * SANS_CH) / 2;
          const mid = Math.min(Math.max((x1 + x2) / 2, half + 4), width - half - 4);
          return (
            <g key={`s${i}`} data-flow-step={r.index} {...link(ids)}>
              <line
                x1={x1}
                y1={line}
                x2={x2 + (x2 > x1 ? -2 : 2)}
                y2={line}
                markerEnd={`url(#${uid}-${s.status})`}
                style={{ stroke: ink, strokeWidth: s.status === "added" ? 1.8 : 1.3, strokeDasharray: dashed ? "4 3" : undefined }}
              />
              <text x={mid} y={line - 6} textAnchor="middle" style={text}>
                {s.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * The flow's key, only for what it uses. A colour means the same on a box
 * (a piece) and on an arrow (a step), so the words name neither.
 */
export function FlowLegend({ flow }: { flow: Flow }) {
  const used = new Set([...flow.steps, ...flow.participants].map((s) => s.status));
  const returns = flow.steps.some((s) => s.kind === "return");
  const item = (label: string, ink: string, dashed = false) => (
    <span key={label} className="flex items-center gap-1.5">
      <span className="inline-block w-4 border-t-2" style={{ borderColor: ink, borderStyle: dashed ? "dashed" : "solid" }} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
      {used.has("added") ? item("new", STATUS_INK.added) : null}
      {used.has("changed") ? item("changed", STATUS_INK.changed) : null}
      {used.has("removed") ? item("cut", STATUS_INK.removed, true) : null}
      {used.has("context") ? item("as before", STATUS_INK.context) : null}
      {returns ? item("returns", STATUS_INK.context, true) : null}
    </div>
  );
}
