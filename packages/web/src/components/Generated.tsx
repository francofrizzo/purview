import { useCallback, useRef, useState } from "react";
import type { FileEntry, FileGenerated } from "../api/types";
import { generatedReason, generatedTag, generatedToggle, type GeneratedUnitFile } from "../lib/generated";
import { FloatingPanel } from "./FloatingPanel";
import { IconMore } from "./icons";
import { MiddleTruncate } from "./Truncate";

/** "gen" / "lock" next to a generated file's name; the tooltip says which signal fired. */
export function GeneratedTag({ generated }: { generated: FileGenerated }) {
  return (
    <span
      className="chip"
      data-testid="generated-tag"
      title={generatedReason(generated)}
      style={{ background: "var(--bg-inset)", color: "var(--fg-faint)" }}
    >
      {generatedTag(generated)}
    </span>
  );
}

/**
 * The file header's ⋯: "Not generated" on a generated file, "Treat as
 * generated" on any other. The panel is the confirmation — it says what moves
 * and that the choice is remembered for the whole repo — so the action itself
 * is one more click. Closes once the server has answered; the PR refetch that
 * follows is what moves the file in or out of the generated unit.
 */
export function GeneratedFileMenu({
  file,
  repoName,
  pending,
  error,
  onSet,
}: {
  file: Pick<FileEntry, "path" | "generated">;
  /** owner/repo, for "remembered for every PR in …" */
  repoName: string;
  pending: boolean;
  error: string | null;
  onSet: (path: string, generated: boolean, done: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = generatedToggle(file, repoName);

  return (
    <span ref={wrapRef} className="relative inline-flex flex-none">
      <button
        type="button"
        data-testid={`file-menu-${file.path}`}
        aria-expanded={open}
        aria-label={`More actions for ${file.path}`}
        title="More actions"
        className="inline-flex items-center rounded px-0.5 hover:!text-[var(--fg)]"
        style={{ color: open ? "var(--fg)" : "var(--fg-faint)" }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <IconMore width={13} height={13} />
      </button>
      {open ? (
        <FloatingPanel
          anchorRef={wrapRef}
          onClose={close}
          label={`Actions for ${file.path}`}
          className="w-72 p-2.5 font-sans text-xs"
        >
          {file.generated ? (
            <p className="mb-1.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
              {generatedReason(file.generated)}
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            data-testid="toggle-generated"
            disabled={pending}
            onClick={() => onSet(file.path, toggle.generated, close)}
          >
            {pending ? "saving…" : toggle.label}
          </button>
          <p className="mt-1.5 text-2xs leading-4" style={{ color: "var(--fg-muted)" }}>
            {toggle.explain}
          </p>
          {error ? (
            <p className="mt-1.5 text-2xs leading-4" role="alert" style={{ color: "var(--risk)" }}>
              {error}
            </p>
          ) : null}
        </FloatingPanel>
      ) : null}
    </span>
  );
}

/**
 * What the generated unit's header shows instead of the analysis's prose:
 * each file it holds with its +/− and tag. Clicking a name scrolls the diff
 * pane to it (the caller decides how).
 */
export function GeneratedUnitFileList({
  files,
  onOpen,
}: {
  files: GeneratedUnitFile[];
  onOpen?: (path: string) => void;
}) {
  if (!files.length) return null;
  return (
    <ul className="mt-1.5 flex max-w-xl flex-col gap-0.5" data-testid="generated-unit-files">
      {files.map((f) => (
        <li key={f.path} className="flex min-w-0 items-center gap-2 font-mono text-2xs">
          {onOpen ? (
            <button
              type="button"
              className="min-w-0 text-left hover:underline"
              style={{ color: "var(--fg-muted)" }}
              onClick={() => onOpen(f.path)}
            >
              <MiddleTruncate text={f.path} tail={18} />
            </button>
          ) : (
            <span className="min-w-0" style={{ color: "var(--fg-muted)" }}>
              <MiddleTruncate text={f.path} tail={18} />
            </span>
          )}
          {f.generated ? <GeneratedTag generated={f.generated} /> : null}
          <span className="ml-auto flex-none tabular-nums" style={{ color: "var(--fg-faint)" }}>
            +{f.additions} −{f.deletions}
          </span>
        </li>
      ))}
    </ul>
  );
}
