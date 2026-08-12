import { useDiffOfDiffs } from "../api/hooks";
import type { DiffOfDiffsLine, HunkState } from "../api/types";

/**
 * "Diff of diffs": how this hunk's own content changed after you marked it
 * viewed. Fetched on demand from
 * `GET /api/prs/:key/hunks/:id/diff-of-diffs`, which returns core's
 * line-oriented payload with a word-level breakdown on modified lines.
 */
export function DiffOfDiffs({
  prKey,
  hunkId,
  state,
}: {
  prKey: string;
  hunkId: string;
  state: HunkState;
}) {
  const { data, isLoading, error } = useDiffOfDiffs(prKey, hunkId);

  return (
    <div
      className="border-y px-3 py-2"
      style={{ background: "var(--warn-soft)", borderColor: "var(--border)" }}
    >
      <div className="mb-1.5 text-2xs uppercase tracking-wide" style={{ color: "var(--warn)" }}>
        changed since you viewed it
        {state.viewedAtRevision !== undefined ? ` · viewed at revision ${state.viewedAtRevision}` : ""}
        {state.migration ? ` · ${state.migration} match` : ""}
      </div>

      {isLoading ? (
        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
          computing diff of diffs…
        </div>
      ) : error ? (
        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
          The server could not reconstruct the previous content of this hunk
          {state.predecessorId ? ` (predecessor ${state.predecessorId.slice(0, 8)})` : ""}:{" "}
          {(error as Error).message}. Re-read the hunk below.
        </div>
      ) : !data || !data.changed ? (
        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
          No content difference against the predecessor hunk.
        </div>
      ) : (
        <div
          className="overflow-x-auto rounded font-mono text-[12px] leading-5"
          style={{ background: "var(--bg-inset)" }}
        >
          {data.lines.map((line, i) => (
            <DodLine key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}

function DodLine({ line }: { line: DiffOfDiffsLine }) {
  if (line.type === "unchanged") {
    return (
      <div className="whitespace-pre px-2" style={{ color: "var(--fg-faint)" }}>
        {"  "}
        {line.oldLine}
      </div>
    );
  }

  if (line.type === "removed") {
    return (
      <div className="whitespace-pre px-2" style={{ background: "var(--del-bg)" }}>
        {"- "}
        {line.oldLine}
      </div>
    );
  }

  if (line.type === "added") {
    return (
      <div className="whitespace-pre px-2" style={{ background: "var(--add-bg)" }}>
        {"+ "}
        {line.newLine}
      </div>
    );
  }

  // modified: render old and new with the word-level parts highlighted.
  return (
    <>
      <div className="whitespace-pre px-2" style={{ background: "var(--del-bg)" }}>
        {"- "}
        {line.parts
          ?.filter((p) => p.type !== "added")
          .map((p, i) => (
            <span
              key={i}
              style={
                p.type === "removed"
                  ? { background: "var(--del-bg-strong)", borderRadius: 2 }
                  : undefined
              }
            >
              {p.value}
            </span>
          )) ?? line.oldLine}
      </div>
      <div className="whitespace-pre px-2" style={{ background: "var(--add-bg)" }}>
        {"+ "}
        {line.parts
          ?.filter((p) => p.type !== "removed")
          .map((p, i) => (
            <span
              key={i}
              style={
                p.type === "added"
                  ? { background: "var(--add-bg-strong)", borderRadius: 2 }
                  : undefined
              }
            >
              {p.value}
            </span>
          )) ?? line.newLine}
      </div>
    </>
  );
}
