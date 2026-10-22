import { useEffect, useMemo, useRef, useState } from "react";
import { IconMoodSmile } from "@tabler/icons-react";
import { searchEmoji } from "../lib/emoji";
import { FloatingPanel } from "./FloatingPanel";

/**
 * The composer's emoji button: a small panel with a search box that filters
 * as you type and a grid of what matches; Enter takes the first, a click
 * takes any, and the chosen emoji lands at the caret. Escape closes only the
 * panel, never the composer around it.
 */
export function EmojiPicker({
  onPick,
  disabled,
  testId = "composer-emoji",
}: {
  onPick: (emoji: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchEmoji(query), [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    // The panel positions itself after a measure; focus once it has.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const pick = (emoji: string) => {
    onPick(emoji);
    setOpen(false);
  };

  return (
    <span ref={anchorRef} className="inline-flex">
      <button
        type="button"
        data-testid={testId}
        aria-label="Insert an emoji"
        aria-expanded={open}
        disabled={disabled}
        className="flex h-5 w-5 items-center justify-center rounded transition-colors enabled:hover:bg-[var(--bg-hover)] enabled:hover:text-[var(--fg)] disabled:opacity-40"
        style={{ color: "var(--fg-faint)" }}
        data-tip="Insert an emoji"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <IconMoodSmile size={13} stroke={2} />
      </button>
      {open ? (
        <FloatingPanel anchorRef={anchorRef} onClose={() => setOpen(false)} label="Emoji" className="w-64 p-2">
          <input
            ref={inputRef}
            type="text"
            autoFocus
            data-testid={`${testId}-search`}
            className="mb-1.5 w-full rounded px-2 py-1 text-xs outline-none"
            style={{ background: "var(--bg-inset)", color: "var(--fg)", border: "1px solid var(--border)" }}
            placeholder="Search… (rocket, thumbs, eyes)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The composer cancels on Escape and saves on ⌘↵; neither is for this box.
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (results[0]) pick(results[0].char);
              }
            }}
          />
          {results.length ? (
            <div className="grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto" data-testid={`${testId}-results`}>
              {results.map((r) => (
                <button
                  key={r.char}
                  type="button"
                  data-testid={`${testId}-pick-${r.name}`}
                  className="flex h-7 w-7 items-center justify-center rounded text-base hover:bg-[var(--bg-hover)]"
                  data-tip={`:${r.name}:`}
                  aria-label={r.name.replace(/_/g, " ")}
                  onClick={() => pick(r.char)}
                >
                  {r.char}
                </button>
              ))}
            </div>
          ) : (
            <p className="px-1 py-2 text-2xs" style={{ color: "var(--fg-faint)" }}>
              Nothing called that.
            </p>
          )}
        </FloatingPanel>
      ) : null}
    </span>
  );
}
