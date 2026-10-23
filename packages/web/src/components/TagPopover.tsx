import { useEffect, useRef, useState, type RefObject } from "react";
import { usePrs, useSetPrTag } from "../api/hooks";
import { errorText } from "../api/errors";
import { stackOf } from "../lib/prList";
import { normalizeTag, TAG_COLORS, tagSlot } from "../lib/tags";
import { FloatingPanel } from "./FloatingPanel";

/** A PR's tag as a chip in the tag's colour; the same tag is the same colour everywhere. */
export function TagChip({ tag, className = "" }: { tag: string; className?: string }) {
  const color = TAG_COLORS[tagSlot(tag)];
  return (
    <span
      data-testid="pr-tag"
      className={`chip ${className}`}
      style={{ color: `var(--kind-${color})`, background: `var(--kind-${color}-soft)` }}
    >
      {tag}
    </span>
  );
}

/**
 * The tag editor, drawn under whatever opened it: one box with the current
 * tag, the tags already in use as chips under it (click one to take it),
 * Enter saves, Escape closes, an empty box or "Remove tag" clears. Like the
 * emoji picker, it is a panel over the page, not a form.
 */
export function TagPopover({
  prKey,
  current,
  anchorRef,
  onClose,
}: {
  prKey: string;
  current?: string;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(current ?? "");
  const { data: prs = [] } = usePrs();
  const save = useSetPrTag(prKey);
  const used = [...new Set(prs.flatMap((pr) => (pr.meta.tag ? [pr.meta.tag] : [])))].sort();
  // A PR in a stack tags the whole stack unless told otherwise: a stack is
  // one piece of work, and a tag that split it would also split the tree.
  const stack = stackOf(prs, prKey);
  const [wholeStack, setWholeStack] = useState(true);
  const normalized = normalizeTag(value);
  const tooLong = normalized.length > 24;
  const submit = (tag: string | null) => {
    if (save.isPending) return;
    const applyToStack = stack.length > 1 && wholeStack;
    if ((tag ?? undefined) === current && !applyToStack) return onClose();
    save.mutate({ tag, stack: applyToStack }, { onSuccess: onClose });
  };

  useEffect(() => {
    // The panel positions itself after a measure; focus and select once it has.
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <FloatingPanel anchorRef={anchorRef} onClose={onClose} label="Tag" className="w-56 p-2">
      <input
        ref={inputRef}
        type="text"
        data-testid="tag-input"
        aria-label="Tag"
        aria-invalid={tooLong || undefined}
        className="w-full rounded px-2 py-1 text-xs outline-none"
        style={{
          background: "var(--bg-inset)",
          color: "var(--fg)",
          border: `1px solid ${tooLong ? "var(--risk)" : "var(--border)"}`,
        }}
        placeholder="Tag this PR…"
        value={value}
        disabled={save.isPending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (!tooLong) submit(normalized || null);
          }
        }}
      />
      {tooLong ? (
        <p role="alert" className="mt-1 px-0.5 text-2xs" style={{ color: "var(--risk)" }}>
          At most 24 characters.
        </p>
      ) : null}
      {used.length ? (
        <div className="mt-2 flex flex-wrap gap-1" data-testid="tag-suggestions">
          {used.map((tag) => (
            <button
              key={tag}
              type="button"
              data-testid={`tag-pick-${tag}`}
              className="rounded transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-1"
              style={{ outlineColor: "var(--accent)", opacity: tag === current ? 1 : 0.85 }}
              aria-pressed={tag === current}
              disabled={save.isPending}
              onClick={() => submit(tag)}
            >
              <TagChip tag={tag} className={tag === current ? "ring-1 ring-[var(--fg-muted)]" : ""} />
            </button>
          ))}
        </div>
      ) : null}
      {stack.length > 1 ? (
        <label
          className="mt-2 flex cursor-pointer items-center gap-1.5 px-0.5 text-2xs"
          style={{ color: "var(--fg-muted)" }}
          data-tip="The PRs stacked on this one and the ones it stacks on get the same tag"
        >
          <input
            type="checkbox"
            data-testid="tag-whole-stack"
            checked={wholeStack}
            disabled={save.isPending}
            onChange={(e) => setWholeStack(e.target.checked)}
          />
          Whole stack ({stack.length} PRs)
        </label>
      ) : null}
      <div className="mt-2 flex items-center justify-between px-0.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
        <span>{save.isPending ? "Saving…" : "Enter saves"}</span>
        {current ? (
          <button
            type="button"
            data-testid="tag-remove"
            className="rounded hover:underline disabled:opacity-50"
            disabled={save.isPending}
            onClick={() => submit(null)}
          >
            Remove tag
          </button>
        ) : null}
      </div>
      {save.error ? (
        <p role="alert" className="mt-1 px-0.5 text-2xs" style={{ color: "var(--risk)" }}>
          {errorText(save.error)}
        </p>
      ) : null}
    </FloatingPanel>
  );
}
