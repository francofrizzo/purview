import { memo, type ReactNode } from "react";
import type { Tok } from "../lib/highlight";
import type { CharRange, DiffRow } from "../lib/diffModel";

function inRange(pos: number, ranges: CharRange[] | undefined): boolean {
  if (!ranges) return false;
  for (const r of ranges) if (pos >= r.start && pos < r.end) return true;
  return false;
}

/** Split shiki tokens further at word-diff boundaries so both survive. */
function renderContent(content: string, toks: Tok[] | undefined, intra?: CharRange[]): ReactNode {
  const source: Tok[] = toks && toks.length ? toks : [{ content }];
  if (!intra || intra.length === 0) {
    return source.map((t, i) => (
      <span key={i} style={t.color ? { color: t.color } : undefined}>
        {t.content}
      </span>
    ));
  }

  const out: ReactNode[] = [];
  let pos = 0;
  let k = 0;
  for (const t of source) {
    let buf = "";
    let bufHi = inRange(pos, intra);
    for (const ch of t.content) {
      const hi = inRange(pos, intra);
      if (hi !== bufHi && buf) {
        out.push(
          <span
            key={k++}
            className={bufHi ? "intra" : undefined}
            style={{
              ...(t.color ? { color: t.color } : {}),
              ...(bufHi ? { background: "var(--intra-bg)" } : {}),
            }}
          >
            {buf}
          </span>,
        );
        buf = "";
      }
      bufHi = hi;
      buf += ch;
      pos += ch.length;
    }
    if (buf) {
      out.push(
        <span
          key={k++}
          className={bufHi ? "intra" : undefined}
          style={{
            ...(t.color ? { color: t.color } : {}),
            ...(bufHi ? { background: "var(--intra-bg)" } : {}),
          }}
        >
          {buf}
        </span>,
      );
    }
  }
  return out;
}

export interface DiffLineProps {
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
}: DiffLineProps) {
  const bg =
    row.type === "add" ? "var(--add-bg)" : row.type === "del" ? "var(--del-bg)" : "transparent";
  const gutterBg =
    row.type === "add" ? "var(--add-gutter)" : row.type === "del" ? "var(--del-gutter)" : "transparent";
  const intraBg = row.type === "add" ? "var(--add-bg-strong)" : "var(--del-bg-strong)";
  const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";

  return (
    <div
      className="diff-line group relative"
      style={{ background: bg, ["--intra-bg" as string]: intraBg }}
    >
      <span className="diff-gutter" style={{ background: gutterBg }}>
        {row.oldNumber ?? ""}
      </span>
      <span className="diff-gutter" style={{ background: gutterBg }}>
        {row.newNumber ?? ""}
      </span>
      {onComment ? (
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
      ) : (
        <span className="w-[15px] flex-none" />
      )}
      <span
        className="w-3 flex-none select-none pl-1"
        style={{
          color:
            row.type === "add" ? "var(--ok)" : row.type === "del" ? "var(--risk)" : "var(--fg-faint)",
        }}
      >
        {marker}
      </span>
      <span className="min-w-0 flex-1 pr-4">{renderContent(row.content, tokens, row.intra)}</span>
    </div>
  );
});
