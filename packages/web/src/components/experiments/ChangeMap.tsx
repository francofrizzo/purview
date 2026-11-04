import { useMemo, useState } from "react";
import { useChangeMap } from "../../api/hooks";
import type { ChangeMapNode } from "../../api/types";
import { DEFAULT_SIZE as SIZE, layoutChangeMap, shortPaths } from "../../lib/changeMapLayout";
import { UnitNumber } from "../Chips";
import { SectionHead } from "../SectionHead";

/** How each status is painted: the diff's own tints, a mark in its color. */
export const FN_STATUS = {
  added: { glyph: "+", label: "added", tint: "var(--add-bg)", mark: "var(--ok)" },
  changed: { glyph: "~", label: "changed", tint: "var(--warn-soft)", mark: "var(--warn)" },
  removed: { glyph: "−", label: "removed", tint: "var(--del-bg)", mark: "var(--risk)" },
} as const;

const LOOP = 28;

/**
 * The PR's changed functions and the calls between them, found without a
 * model: a box per function (added, changed or removed, its file and the
 * unit its change sits in), an arrow from caller to callee. Functions that
 * call no other changed function and are called by none are listed by file
 * under the drawing. A box opens its unit, or its file when no unit has it.
 */
export function ChangeMap({
  prKey,
  version,
  numbers,
  units,
  onOpenUnit,
  onOpenFile,
}: {
  prKey: string;
  /** changes when the head or the units do, so the map is asked again */
  version: string;
  numbers: Map<string, number>;
  units: Set<string>;
  onOpenUnit: (unitId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const q = useChangeMap(prKey, version, true);
  const data = q.data;
  return (
    <section data-testid="overview-change-map" data-section="map">
      <SectionHead title="Change map">
        <Legend />
      </SectionHead>
      {q.isPending ? (
        <Quiet>Reading the changed functions…</Quiet>
      ) : q.isError ? (
        <Quiet>The map could not be drawn: {(q.error as Error).message}</Quiet>
      ) : !data || !data.available ? (
        <Quiet>No map: {data?.reason ?? "no answer"}</Quiet>
      ) : data.nodes.length === 0 ? (
        <Quiet>No changed functions found in Go, TypeScript, JavaScript or Python.</Quiet>
      ) : (
        <MapBody
          nodes={data.nodes}
          edges={data.edges}
          numbers={numbers}
          units={units}
          onOpen={(n) => (n.unit && units.has(n.unit) ? onOpenUnit(n.unit) : onOpenFile(n.path))}
        >
          <Footnotes total={data.total} drawn={data.nodes.length} unsupported={data.unsupportedFiles} unread={data.unreadFiles} />
        </MapBody>
      )}
    </section>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs" style={{ color: "var(--fg-faint)" }} data-testid="change-map-quiet">
      {children}
    </p>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-3 text-2xs" style={{ color: "var(--fg-muted)" }}>
      {Object.values(FN_STATUS).map((s) => (
        <span key={s.label} className="flex items-center gap-1">
          <span className="font-mono font-semibold" style={{ color: s.mark }} aria-hidden>
            {s.glyph}
          </span>
          {s.label}
        </span>
      ))}
    </span>
  );
}

function MapBody({
  nodes,
  edges,
  numbers,
  units,
  onOpen,
  children,
}: {
  nodes: ChangeMapNode[];
  edges: { from: string; to: string; calls: number }[];
  numbers: Map<string, number>;
  units: Set<string>;
  onOpen: (n: ChangeMapNode) => void;
  children: React.ReactNode;
}) {
  const layout = useMemo(() => layoutChangeMap({ nodes, edges }), [nodes, edges]);
  const short = useMemo(() => shortPaths(nodes.map((n) => n.path)), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const [hover, setHover] = useState<string | null>(null);
  const isolated = layout.isolated.map((id) => byId.get(id)!);
  const isolatedByFile = new Map<string, ChangeMapNode[]>();
  for (const n of isolated) isolatedByFile.set(n.path, [...(isolatedByFile.get(n.path) ?? []), n]);
  const unitOf = (n: ChangeMapNode) => (n.unit && units.has(n.unit) ? numbers.get(n.unit) : undefined);

  return (
    <div className="flex flex-col gap-4">
      {layout.boxes.size > 0 ? (
        <div className="quiet-scroll -mx-1 overflow-x-auto px-1 pb-1">
          <div className="relative" style={{ width: layout.width, height: layout.height + 2 }} data-testid="change-map-graph">
            <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height + 2} aria-hidden>
              <defs>
                {(["faint", "hot"] as const).map((k) => (
                  <marker key={k} id={`cm-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0.5 L7.5,4 L0,7.5 z" fill={k === "hot" ? "var(--accent)" : "var(--fg-faint)"} />
                  </marker>
                ))}
              </defs>
              {layout.edges.map((e) => {
                const a = layout.boxes.get(e.from)!;
                const b = layout.boxes.get(e.to)!;
                const hot = hover !== null && (e.from === hover || e.to === hover);
                const dim = hover !== null && !hot;
                let d: string;
                if (e.back) {
                  const sx = a.x + SIZE.w / 2;
                  const sy = a.y + SIZE.h;
                  const tx = b.x + SIZE.w / 2 + 8;
                  const ty = b.y + SIZE.h;
                  const low = Math.max(sy, ty) + LOOP - 6;
                  d = `M${sx},${sy} C${sx},${low} ${tx},${low} ${tx},${ty + 1}`;
                } else {
                  const sx = a.x + SIZE.w;
                  const sy = a.y + SIZE.h / 2;
                  const tx = b.x - 1;
                  const ty = b.y + SIZE.h / 2;
                  const dx = Math.max(18, (tx - sx) / 2);
                  d = `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
                }
                return (
                  <path
                    key={`${e.from}>${e.to}`}
                    d={d}
                    fill="none"
                    stroke={hot ? "var(--accent)" : "var(--fg-faint)"}
                    strokeWidth={hot ? 1.75 : 1.25}
                    opacity={dim ? 0.35 : 1}
                    markerEnd={`url(#cm-arrow-${hot ? "hot" : "faint"})`}
                  />
                );
              })}
            </svg>
            {[...layout.boxes].map(([id, pos]) => {
              const n = byId.get(id)!;
              return (
                <FnBox
                  key={id}
                  node={n}
                  file={short.get(n.path) ?? n.path}
                  unitNumber={unitOf(n)}
                  style={{ left: pos.x, top: pos.y, width: SIZE.w, height: SIZE.h }}
                  onOpen={() => onOpen(n)}
                  onHover={(on) => setHover(on ? id : null)}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {isolated.length > 0 ? (
        <div data-testid="change-map-isolated">
          {layout.boxes.size > 0 ? (
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide" style={{ color: "var(--fg-faint)" }}>
              Calling no other changed function
            </div>
          ) : null}
          <ul className="flex flex-col gap-1">
            {[...isolatedByFile].map(([path, fns]) => (
              <li key={path} className="grid grid-cols-1 items-baseline gap-x-3 gap-y-1 sm:grid-cols-[minmax(8rem,12rem)_1fr]">
                <span className="truncate font-mono text-[12px]" style={{ color: "var(--fg-muted)" }} data-tip={path}>
                  {short.get(path) ?? path}
                </span>
                <span className="flex flex-wrap gap-1">
                  {fns.map((n) => (
                    <FnChip key={n.id} node={n} unitNumber={unitOf(n)} onOpen={() => onOpen(n)} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function tipFor(n: ChangeMapNode, unitNumber: number | undefined): string {
  const name = n.qualifier ? `${n.qualifier}.${n.name}` : n.name;
  const parts = [`${name}, ${FN_STATUS[n.status].label} (${n.lines} line${n.lines === 1 ? "" : "s"})`, `${n.path}:${n.line}`];
  if (n.movedFrom) parts.push(`moved from ${n.movedFrom}`);
  parts.push(unitNumber !== undefined ? `Open unit ${unitNumber}` : "Open the file");
  return parts.join(" · ");
}

function FnBox({
  node: n,
  file,
  unitNumber,
  style,
  onOpen,
  onHover,
}: {
  node: ChangeMapNode;
  file: string;
  unitNumber: number | undefined;
  style: React.CSSProperties;
  onOpen: () => void;
  onHover: (on: boolean) => void;
}) {
  const s = FN_STATUS[n.status];
  return (
    <button
      type="button"
      data-testid="change-map-node"
      data-status={n.status}
      className="absolute flex flex-col justify-center overflow-hidden rounded-md border pl-3 pr-1.5 text-left transition-shadow hover:shadow-[0_0_0_1px_var(--accent)] focus-visible:shadow-[0_0_0_1px_var(--accent)]"
      style={{ ...style, background: `linear-gradient(${s.tint}, ${s.tint}), var(--bg)`, borderColor: "var(--border)" }}
      onClick={onOpen}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      data-tip={tipFor(n, unitNumber)}
      aria-label={tipFor(n, unitNumber)}
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: s.mark }} aria-hidden />
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="w-2 flex-none font-mono text-[12px] font-semibold leading-4" style={{ color: s.mark }} aria-hidden>
          {s.glyph}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] leading-4"
          style={{ color: "var(--fg)", textDecoration: n.status === "removed" ? "line-through" : undefined }}
        >
          {n.name}
        </span>
        {unitNumber !== undefined ? <UnitNumber number={unitNumber} /> : null}
      </span>
      <span className="truncate pl-3.5 text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
        {n.qualifier ? `${n.qualifier} · ` : ""}
        {file}
        {n.movedFrom ? " · moved" : ""}
      </span>
    </button>
  );
}

function FnChip({ node: n, unitNumber, onOpen }: { node: ChangeMapNode; unitNumber: number | undefined; onOpen: () => void }) {
  const s = FN_STATUS[n.status];
  return (
    <button
      type="button"
      data-testid="change-map-chip"
      data-status={n.status}
      className="flex h-6 items-center gap-1.5 rounded-md border pl-1.5 pr-1 font-mono text-[12px] transition-shadow hover:shadow-[0_0_0_1px_var(--accent)]"
      style={{ background: `linear-gradient(${s.tint}, ${s.tint}), var(--bg)`, borderColor: "var(--border)", color: "var(--fg)" }}
      onClick={onOpen}
      data-tip={tipFor(n, unitNumber)}
      aria-label={tipFor(n, unitNumber)}
    >
      <span className="font-semibold" style={{ color: s.mark }} aria-hidden>
        {s.glyph}
      </span>
      <span style={{ textDecoration: n.status === "removed" ? "line-through" : undefined }}>
        {n.qualifier ? <span style={{ color: "var(--fg-muted)" }}>{n.qualifier}.</span> : null}
        {n.name}
      </span>
      {unitNumber !== undefined ? <UnitNumber number={unitNumber} /> : <span className="w-0.5" />}
    </button>
  );
}

function Footnotes({ total, drawn, unsupported, unread }: { total: number; drawn: number; unsupported: number; unread: number }) {
  const notes: string[] = [];
  if (total > drawn) notes.push(`${total - drawn} more changed function${total - drawn === 1 ? "" : "s"} left out: must-read units first, then the most lines changed.`);
  if (unsupported > 0) notes.push(`${unsupported} changed file${unsupported === 1 ? " is" : "s are"} in a language the map does not read.`);
  if (unread > 0) notes.push(`${unread} changed file${unread === 1 ? " was" : "s were"} not read.`);
  notes.push("Found by name, without a parser: a call to another function of the same name can draw a wrong arrow.");
  return (
    <div className="flex flex-col gap-0.5 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="change-map-notes">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}
