import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DefinitionCandidate, DefinitionResult, Editor, FilesJson } from "../api/types";
import { findInDiffHunk } from "../lib/definitions";
import { IconClose, IconExternal } from "./icons";

/** `zed://file/<abs-path>:<line>` / `vscode://file/<abs-path>:<line>`. */
function editorUrl(editor: Editor, absPath: string, line: number): string {
  return `${editor}://file${absPath}:${line}`;
}

export interface DefinitionPopoverProps {
  /** click point, viewport coordinates — clamped to stay on screen */
  x: number;
  y: number;
  symbol: string;
  status: "loading" | "result" | "error";
  result?: DefinitionResult;
  error?: string;
  editor: Editor;
  /** the PR's own diff, for the "in this diff" marker + jump */
  files: FilesJson;
  onJumpInDiff: (hunkId: string, path: string) => void;
  onClose: () => void;
}

/**
 * The peek popover for cmd+click "go to definition". Anchored near the click,
 * clamped into the viewport after it measures its own size. Multiple
 * candidates show a compact list first; picking one (or there only being one
 * to begin with) shows its snippet.
 */
export function DefinitionPopover({
  x,
  y,
  symbol,
  status,
  result,
  error,
  editor,
  files,
  onJumpInDiff,
  onClose,
}: DefinitionPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const candidates = result?.checkout ? result.candidates : [];
  const [selected, setSelected] = useState(0);

  // A fresh lookup (new symbol) always starts at the list/first candidate.
  useEffect(() => {
    setSelected(0);
  }, [symbol]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp into the viewport once the real size is known — content varies a
  // lot (a two-line "no checkout" note vs. a 15-line snippet), so this reruns
  // whenever what's shown changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(margin, x), window.innerWidth - rect.width - margin);
    const top = Math.min(Math.max(margin, y), window.innerHeight - rect.height - margin);
    el.style.left = `${Math.max(margin, left)}px`;
    el.style.top = `${Math.max(margin, top)}px`;
  }, [x, y, status, result, selected]);

  const showList = candidates.length > 1;
  const candidate = candidates[selected];

  const inDiffOf = (c: DefinitionCandidate) => findInDiffHunk(files, c.path, c.line);

  return (
    <div
      ref={ref}
      data-testid="definition-popover"
      className="surface fixed z-40 flex w-[26rem] max-w-[90vw] flex-col rounded-md elev-2"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex flex-none items-center gap-2 border-b px-2.5 py-1.5"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
          {symbol}
        </span>
        <button
          type="button"
          data-testid="definition-popover-close"
          title="Close (esc)"
          style={{ color: "var(--fg-faint)" }}
          onClick={onClose}
        >
          <IconClose width={10} height={10} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {status === "loading" ? (
          <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            Looking up “{symbol}”…
          </p>
        ) : status === "error" ? (
          <p className="text-2xs" style={{ color: "var(--risk)" }}>
            {error ?? "Definition lookup failed."}
          </p>
        ) : !result?.checkout ? (
          <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            {result?.reason ?? "No local checkout configured for this repo."}
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            No definition found for “{symbol}”.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {showList ? (
              <CandidateList
                candidates={candidates}
                selected={selected}
                onSelect={setSelected}
                inDiffOf={inDiffOf}
                onJumpInDiff={onJumpInDiff}
              />
            ) : null}
            {candidate ? (
              <CandidateSnippet
                candidate={candidate}
                editor={editor}
                inDiff={inDiffOf(candidate)}
                onJumpInDiff={onJumpInDiff}
              />
            ) : null}
            {result.engine === "grep" ? (
              <p className="text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
                Basic text search — install universal-ctags for precise results (
                <span className="font-mono">brew install universal-ctags</span>).
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateList({
  candidates,
  selected,
  onSelect,
  inDiffOf,
  onJumpInDiff,
}: {
  candidates: DefinitionCandidate[];
  selected: number;
  onSelect: (i: number) => void;
  inDiffOf: (c: DefinitionCandidate) => { hunkId: string } | null;
  onJumpInDiff: (hunkId: string, path: string) => void;
}) {
  return (
    <div
      className="flex flex-col divide-y rounded"
      style={{ borderColor: "var(--border)", border: "1px solid var(--border)" }}
    >
      {candidates.map((c, i) => {
        const inDiff = inDiffOf(c);
        return (
          <button
            key={`${c.path}:${c.line}:${i}`}
            type="button"
            data-testid={`definition-candidate-${i}`}
            onClick={() => (inDiff ? onJumpInDiff(inDiff.hunkId, c.path) : onSelect(i))}
            className="flex flex-col items-start gap-0.5 px-2 py-1 text-left transition-colors"
            style={{
              background: i === selected ? "var(--accent-soft)" : "transparent",
              borderColor: "var(--border)",
            }}
          >
            <span className="flex w-full items-center gap-1.5 font-mono text-2xs">
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--fg)" }}>
                {c.path}:{c.line}
              </span>
              {inDiff ? (
                <span className="chip flex-none" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                  in this diff
                </span>
              ) : null}
              {c.kind ? (
                <span className="flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {c.kind}
                </span>
              ) : null}
            </span>
            {c.signature ? (
              <span
                className="w-full truncate font-mono text-2xs"
                style={{ color: "var(--fg-faint)" }}
              >
                {c.signature}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function CandidateSnippet({
  candidate,
  editor,
  inDiff,
  onJumpInDiff,
}: {
  candidate: DefinitionCandidate;
  editor: Editor;
  inDiff: { hunkId: string } | null;
  onJumpInDiff: (hunkId: string, path: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs" style={{ color: "var(--fg)" }}>
          {candidate.path}:{candidate.line}
        </span>
        {candidate.kind ? (
          <span className="flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
            {candidate.kind}
          </span>
        ) : null}
        {inDiff ? (
          <button
            type="button"
            data-testid="definition-jump-in-diff"
            className="chip flex-none"
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
            onClick={() => onJumpInDiff(inDiff.hunkId, candidate.path)}
          >
            jump to it in this diff
          </button>
        ) : (
          <a
            href={editorUrl(editor, candidate.absPath, candidate.line)}
            data-testid="definition-open-in-editor"
            className="flex flex-none items-center gap-1 text-2xs"
            style={{ color: "var(--accent)" }}
            title={`Open in ${editor === "vscode" ? "VS Code" : "Zed"}`}
          >
            <IconExternal width={10} height={10} />
            open in editor
          </a>
        )}
      </div>
      <pre
        className="overflow-x-auto rounded p-2 font-mono text-2xs leading-4"
        style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
      >
        {candidate.snippet.lines.map((line, i) => {
          const lineNo = candidate.snippet.startLine + i;
          const isTarget = lineNo === candidate.line;
          return (
            <div
              key={lineNo}
              style={{
                background: isTarget ? "var(--accent-soft)" : undefined,
                color: isTarget ? "var(--fg)" : undefined,
              }}
            >
              <span className="mr-2 inline-block w-8 flex-none select-none text-right" style={{ color: "var(--fg-faint)" }}>
                {lineNo}
              </span>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
