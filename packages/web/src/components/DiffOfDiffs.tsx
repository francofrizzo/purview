import { diffWordsWithSpace } from "diff";
import { useMemo } from "react";
import type { HunkState, WordDiffPiece } from "../api/types";

/**
 * "Diff of diffs": what changed in this hunk after you marked it viewed.
 * Uses the server's wordDiff when present, otherwise computes one from the
 * before/after bodies, otherwise shows the two bodies side by side.
 */
export function DiffOfDiffs({ state }: { state: HunkState }) {
  const dod = state.diffOfDiffs;

  const pieces: WordDiffPiece[] | null = useMemo(() => {
    if (!dod) return null;
    if (dod.wordDiff?.length) return dod.wordDiff;
    if (typeof dod.before === "string" && typeof dod.after === "string") {
      return diffWordsWithSpace(dod.before, dod.after) as WordDiffPiece[];
    }
    return null;
  }, [dod]);

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

      {pieces ? (
        <pre
          className="overflow-x-auto whitespace-pre-wrap rounded p-2 font-mono text-[12px] leading-5"
          style={{ background: "var(--bg-inset)" }}
        >
          {pieces.map((p, i) => (
            <span
              key={i}
              style={
                p.added
                  ? { background: "var(--add-bg-strong)" }
                  : p.removed
                    ? { background: "var(--del-bg-strong)", textDecoration: "line-through" }
                    : undefined
              }
            >
              {p.value}
            </span>
          ))}
        </pre>
      ) : dod?.before || dod?.after ? (
        <div className="grid gap-2 md:grid-cols-2">
          <pre
            className="overflow-x-auto rounded p-2 font-mono text-[12px] leading-5"
            style={{ background: "var(--del-bg)" }}
          >
            {dod.before ?? "(not recorded)"}
          </pre>
          <pre
            className="overflow-x-auto rounded p-2 font-mono text-[12px] leading-5"
            style={{ background: "var(--add-bg)" }}
          >
            {dod.after ?? "(not recorded)"}
          </pre>
        </div>
      ) : (
        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
          The server did not record the previous content of this hunk
          {state.predecessorId ? ` (predecessor ${state.predecessorId})` : ""}. Re-read the hunk
          below.
        </div>
      )}
    </div>
  );
}
