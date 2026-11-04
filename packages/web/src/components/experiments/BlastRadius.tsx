import { useBlastRadius } from "../../api/hooks";
import type { BlastFunction, BlastRadius as BlastRadiusData } from "../../api/types";
import { UnitNumber } from "../Chips";
import { IconExternal } from "../icons";
import { SectionHead } from "../SectionHead";

/**
 * Code outside the diff that calls a function the PR changes: what the
 * change can break without the diff showing it. One block per changed
 * function, most callers first; each call site links to its line on GitHub
 * at the head commit. Found with `git grep` by name, so a same-named method
 * on another type can show up; the names too short or common to search are
 * listed instead of searched.
 */
export function BlastRadius({
  prKey,
  version,
  numbers,
  units,
  onOpenUnit,
  onOpenFile,
}: {
  prKey: string;
  version: string;
  numbers: Map<string, number>;
  units: Set<string>;
  onOpenUnit: (unitId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const q = useBlastRadius(prKey, version, true);
  const data = q.data;
  return (
    <section data-testid="overview-blast-radius" data-section="blast">
      <SectionHead title="Blast radius" />
      {q.isPending ? (
        <Quiet>Searching the repo for callers…</Quiet>
      ) : q.isError ? (
        <Quiet>The search failed: {(q.error as Error).message}</Quiet>
      ) : !data || !data.available ? (
        <Quiet>No search: {data?.reason ?? "no answer"}</Quiet>
      ) : (
        <Body data={data} numbers={numbers} units={units} onOpenUnit={onOpenUnit} onOpenFile={onOpenFile} />
      )}
    </section>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs" style={{ color: "var(--fg-faint)" }} data-testid="blast-radius-quiet">
      {children}
    </p>
  );
}

function Body({
  data,
  numbers,
  units,
  onOpenUnit,
  onOpenFile,
}: {
  data: Extract<BlastRadiusData, { available: true }>;
  numbers: Map<string, number>;
  units: Set<string>;
  onOpenUnit: (unitId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const notes: React.ReactNode[] = [];
  if (data.uncalled > 0) notes.push(`${data.uncalled} other changed function${data.uncalled === 1 ? " has" : "s have"} no caller outside the diff.`);
  if (data.skipped.length > 0) {
    notes.push(
      <>
        Not searched, the name is too short or too common to grep:{" "}
        {data.skipped.map((s, i) => (
          <span key={s.name}>
            {i > 0 ? ", " : ""}
            <code className="font-mono">{s.name}</code>
          </span>
        ))}
        .
      </>,
    );
  }
  if (data.notSearched > 0) notes.push(`${data.notSearched} more changed function${data.notSearched === 1 ? "" : "s"} not searched, past the cap.`);
  if (data.tests > 0) notes.push(`${data.tests} changed function${data.tests === 1 ? "" : "s"} in test files not searched.`);
  return (
    <div className="flex flex-col gap-4">
      {data.functions.length === 0 ? (
        <p className="text-[13px]" style={{ color: "var(--fg-muted)" }}>
          No code outside the diff calls the functions it changes.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {data.functions.map((f) => (
            <FunctionCallers
              key={f.id}
              fn={f}
              unitNumber={f.unit && units.has(f.unit) ? numbers.get(f.unit) : undefined}
              onOpen={() => (f.unit && units.has(f.unit) ? onOpenUnit(f.unit) : onOpenFile(f.path))}
            />
          ))}
        </ul>
      )}
      {notes.length ? (
        <div className="flex flex-col gap-0.5 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="blast-radius-notes">
          {notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FunctionCallers({ fn, unitNumber, onOpen }: { fn: BlastFunction; unitNumber: number | undefined; onOpen: () => void }) {
  const file = fn.path.split("/").pop();
  return (
    <li data-testid="blast-function">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="-mx-1.5 flex min-w-0 items-center gap-2 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
          onClick={onOpen}
          data-tip={unitNumber !== undefined ? `Open unit ${unitNumber}, where it changes` : "Open the file"}
        >
          <span className="truncate font-mono text-[13px] font-medium" style={{ color: "var(--fg)" }}>
            {fn.qualifier ? <span style={{ color: "var(--fg-muted)" }}>{fn.qualifier}.</span> : null}
            {fn.name}
          </span>
          <span className="flex-none text-2xs" style={{ color: "var(--fg-muted)" }}>
            {file}
          </span>
          {unitNumber !== undefined ? <UnitNumber number={unitNumber} /> : null}
        </button>
        <span className="ml-auto flex-none text-2xs tabular-nums" style={{ color: "var(--fg-muted)" }}>
          {fn.total} caller{fn.total === 1 ? "" : "s"}
        </span>
      </div>
      {fn.sameName?.length ? (
        <p className="mt-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
          Also changed under this name: {fn.sameName.join(", ")}. These calls could reach any of them.
        </p>
      ) : null}
      <ul className="mt-1 flex flex-col">
        {fn.sites.map((s) => (
          <li key={`${s.path}:${s.line}`}>
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              data-testid="blast-site"
              className="group -mx-1.5 grid grid-cols-1 gap-x-3 rounded px-1.5 py-1 transition-colors hover:bg-[var(--bg-hover)] sm:grid-cols-[minmax(10rem,16rem)_1fr]"
              data-tip="Open this line on GitHub"
            >
              <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                <span className="flex min-w-0 font-mono" style={{ color: "var(--fg-muted)" }} title={`${s.path}:${s.line}`}>
                  <span className="truncate">{s.path}</span>
                  <span className="flex-none">:{s.line}</span>
                </span>
                <IconExternal className="h-3 w-3 flex-none self-center opacity-0 transition-opacity group-hover:opacity-100" style={{ color: "var(--fg-faint)" }} />
              </span>
              <span className="flex min-w-0 items-baseline gap-2">
                <code className="min-w-0 truncate font-mono text-[12px]" style={{ color: "var(--fg)" }}>
                  {s.text}
                </code>
                {s.enclosing ? (
                  <span className="ml-auto flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
                    in {s.enclosing}
                  </span>
                ) : null}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {fn.total > fn.sites.length ? (
        <p className="mt-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
          {fn.total - fn.sites.length} more not shown.
        </p>
      ) : null}
    </li>
  );
}
