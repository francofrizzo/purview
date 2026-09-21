import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBundle,
  selectForBundle,
  type DiffContext,
  type ExportableComment,
} from "../lib/agentExport";
import { IconCheck, IconClose, IconCopy } from "./icons";

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

  /** Resolves true only when the text really reached the clipboard. */
  const copy = useCallback(async (text: string): Promise<boolean> => {
    if (!text) return false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard API");
      await navigator.clipboard.writeText(text);
      setState("copied");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), FLASH_MS);
      return true;
    } catch {
      setFallback(text);
      return false;
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
      title={copied ? "copied" : title}
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
      {copied ? <IconCheck width={11} height={11} /> : <IconCopy width={11} height={11} />}
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
      {copied ? (
        <>
          <IconCheck width={11} height={11} />
          copied
        </>
      ) : (
        (label ?? "copy for agent")
      )}
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
  onDeleteCopied,
}: {
  source: BundleSource;
  testId?: string;
  className?: string;
  /**
   * Offer "copy & delete": after the bundle really reaches the clipboard,
   * delete the copied comments that can be deleted (never submitted ones).
   * Omitted, the button isn't shown.
   */
  onDeleteCopied?: (ids: string[]) => Promise<unknown>;
}) {
  const [includeSubmitted, setIncludeSubmitted] = useState(false);
  const count = selectForBundle(source.comments, includeSubmitted).length;
  const submitted = source.comments.filter((c) => (c.status ?? "draft") === "submitted").length;
  const bundleText = () =>
    formatBundle(source.comments, source.ctx, {
      repoLabel: source.repoLabel,
      revision: source.revision,
      reviewBody: source.reviewBody,
      includeSubmitted,
    });

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
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
      {onDeleteCopied ? (
        <CopyAndDeleteButton
          testId={testId ? `${testId}-and-delete` : undefined}
          comments={selectForBundle(source.comments, includeSubmitted)}
          text={bundleText}
          onDelete={onDeleteCopied}
        />
      ) : null}
    </div>
  );
}

/**
 * "Copy all, then clear them": the hand-off to an agent that is going to act
 * on the comments, so they don't need to stay. Deletes only after the copy
 * really succeeded — on the manual-copy fallback nothing is deleted, since
 * the text never reached the clipboard. Submitted comments are public review
 * history and are never deleted. Deleting a *pushed* one also removes it from
 * the pending review on GitHub, so that case asks for a second click.
 */
function CopyAndDeleteButton({
  comments,
  text,
  onDelete,
  testId,
}: {
  comments: ExportableComment[];
  text: () => string;
  onDelete: (ids: string[]) => Promise<unknown>;
  testId?: string;
}) {
  const { copy, fallback, dismissFallback } = useCopyForAgent();
  const [phase, setPhase] = useState<"idle" | "confirm" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const deletable = comments.filter(
    (c): c is ExportableComment & { id: string } =>
      (c.status ?? "draft") !== "submitted" && typeof (c as { id?: unknown }).id === "string",
  );
  const pushed = deletable.filter((c) => c.status === "pushed").length;

  useEffect(() => {
    if (phase !== "confirm" && phase !== "done") return;
    const t = window.setTimeout(() => setPhase("idle"), phase === "confirm" ? 4000 : FLASH_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  const run = async () => {
    if (pushed > 0 && phase !== "confirm") {
      setPhase("confirm");
      return;
    }
    setPhase("working");
    setMessage(null);
    const ids = deletable.map((c) => c.id);
    if (!(await copy(text()))) {
      setPhase("idle");
      return;
    }
    try {
      await onDelete(ids);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setMessage((err as Error).message);
    }
  };

  const n = deletable.length;
  const label =
    phase === "confirm"
      ? `also deletes ${pushed} on GitHub — click to confirm`
      : phase === "working"
        ? "copying…"
        : phase === "done"
          ? "copied · deleted"
          : `copy & delete (${n})`;

  return (
    <>
      <button
        type="button"
        className="btn"
        data-testid={testId}
        disabled={n === 0 || phase === "working"}
        title={
          pushed > 0
            ? `Copy these comments for an agent, then delete the ${n} copied (${pushed} pushed ones are removed from the pending review on GitHub too)`
            : `Copy these comments for an agent, then delete the ${n} copied`
        }
        style={
          phase === "confirm"
            ? { color: "var(--warn)", borderColor: "var(--warn)" }
            : phase === "done"
              ? { color: "var(--ok)", borderColor: "var(--ok)" }
              : undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          void run();
        }}
      >
        {phase === "done" ? <IconCheck width={11} height={11} /> : null}
        {label}
      </button>
      {phase === "error" && message ? (
        <span className="text-2xs" style={{ color: "var(--risk)" }}>
          copied, but deleting failed: {message}
        </span>
      ) : null}
      {fallback !== null ? <CopyFallback text={fallback} onClose={dismissFallback} /> : null}
    </>
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
        className="surface w-full max-w-2xl rounded-md p-3 elev-3"
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
            <IconClose width={10} height={10} />
          </button>
        </div>
        <textarea
          ref={ref}
          readOnly
          className="input h-72 resize-none text-xs leading-[18px]"
          value={text}
        />
      </div>
    </div>
  );
}
