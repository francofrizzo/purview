import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBundle,
  selectForBundle,
  type DiffContext,
  type ExportableComment,
} from "../lib/agentExport";
import { IconCopy } from "./icons";

/**
 * Copy-to-clipboard for the agent-facing markdown.
 *
 * `navigator.clipboard` is unavailable on insecure origins and can be denied
 * outright, and a failed copy that looks like a success is the worst outcome
 * here — the reader would paste stale text into their agent. So the failure
 * path is loud: a small panel with the text pre-selected, ready for ⌘C.
 */

const FLASH_MS = 1500;

export function useCopyForAgent() {
  const [state, setState] = useState<"idle" | "copied">("idle");
  const [fallback, setFallback] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string) => {
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard API");
      await navigator.clipboard.writeText(text);
      setState("copied");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), FLASH_MS);
    } catch {
      setFallback(text);
    }
  }, []);

  return { state, copy, fallback, dismissFallback: () => setFallback(null) };
}

export function CopyForAgentButton({
  /** Built lazily: the text depends on what is on screen at click time. */
  text,
  label,
  title,
  disabled,
  iconOnly,
  className,
  testId,
}: {
  text: () => string;
  label?: string;
  title: string;
  disabled?: boolean;
  iconOnly?: boolean;
  className?: string;
  testId?: string;
}) {
  const { state, copy, fallback, dismissFallback } = useCopyForAgent();
  const copied = state === "copied";

  const button = iconOnly ? (
    <button
      type="button"
      title={copied ? "copied ✓" : title}
      aria-label={title}
      data-testid={testId}
      data-copied={copied ? "1" : undefined}
      disabled={disabled}
      className={`flex-none rounded p-0.5 opacity-50 transition-opacity hover:opacity-100 ${className ?? ""}`}
      style={{ color: copied ? "var(--ok)" : "var(--fg-muted)", opacity: copied ? 1 : undefined }}
      onClick={(e) => {
        e.stopPropagation();
        void copy(text());
      }}
    >
      {copied ? <span className="text-2xs leading-none">✓</span> : <IconCopy width={11} height={11} />}
    </button>
  ) : (
    <button
      type="button"
      className={`btn ${className ?? ""}`}
      title={title}
      data-testid={testId}
      data-copied={copied ? "1" : undefined}
      disabled={disabled}
      style={copied ? { color: "var(--ok)", borderColor: "var(--ok)" } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        void copy(text());
      }}
    >
      {copied ? "copied ✓" : (label ?? "copy for agent")}
    </button>
  );

  return (
    <>
      {button}
      {fallback !== null ? <CopyFallback text={fallback} onClose={dismissFallback} /> : null}
    </>
  );
}

export interface BundleSource {
  comments: ExportableComment[];
  ctx: DiffContext;
  repoLabel?: string;
  revision?: number;
  reviewBody?: string;
}

/**
 * The bundle action plus the one decision it takes: whether already-public
 * comments ride along. The count on the button is the honest answer to "what
 * am I about to paste", so it tracks the checkbox.
 */
export function CopyBundleControls({
  source,
  testId,
  className,
}: {
  source: BundleSource;
  testId?: string;
  className?: string;
}) {
  const [includeSubmitted, setIncludeSubmitted] = useState(false);
  const count = selectForBundle(source.comments, includeSubmitted).length;
  const submitted = source.comments.filter((c) => (c.status ?? "draft") === "submitted").length;

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <CopyForAgentButton
        testId={testId}
        disabled={count === 0}
        label={`copy all for agent (${count})`}
        title="Copy every comment below as one markdown work order"
        text={() =>
          formatBundle(source.comments, source.ctx, {
            repoLabel: source.repoLabel,
            revision: source.revision,
            reviewBody: source.reviewBody,
            includeSubmitted,
          })
        }
      />
      <label
        className="flex cursor-pointer items-center gap-1 text-2xs"
        style={{ color: "var(--fg-faint)" }}
        title={
          submitted === 0
            ? "No submitted comments to include"
            : `Also include the ${submitted} already-submitted ${submitted === 1 ? "comment" : "comments"}`
        }
      >
        <input
          type="checkbox"
          data-testid={testId ? `${testId}-submitted` : undefined}
          checked={includeSubmitted}
          onChange={(e) => setIncludeSubmitted(e.target.checked)}
        />
        include submitted
      </label>
    </div>
  );
}

/** Last resort when the clipboard API is unavailable: select it yourself. */
function CopyFallback({ text, onClose }: { text: string; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.45)" }}
      data-testid="copy-fallback"
      onClick={onClose}
    >
      <div
        className="surface w-full max-w-2xl rounded-md p-3 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-xs font-semibold">Copy this by hand</span>
          <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            The clipboard was not available — the text is selected, press ⌘C.
          </span>
          <button type="button" className="ml-auto text-xs" onClick={onClose} style={{ color: "var(--fg-faint)" }}>
            ✕
          </button>
        </div>
        <textarea
          ref={ref}
          readOnly
          className="input h-72 resize-none font-mono text-xs"
          value={text}
        />
      </div>
    </div>
  );
}
