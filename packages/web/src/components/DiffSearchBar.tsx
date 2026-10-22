import type { RefObject } from "react";
import type { DiffSearch } from "../lib/useDiffSearch";
import { IconCaret, IconClose, IconSearch } from "./icons";

/**
 * Compact find bar docked above the diff. It deliberately hijacks Cmd/Ctrl+F:
 * the rows are virtualized, so the browser's own find would only ever see the
 * handful of lines currently mounted.
 */
export function DiffSearchBar({
  search,
  inputRef,
  scopeLabel = "shown",
}: {
  search: DiffSearch;
  inputRef: RefObject<HTMLInputElement>;
  /** what the visible scope is called right now ("this unit" / "this file") */
  scopeLabel?: string;
}) {
  const total = search.matches.length;
  const status = !search.activeQuery
    ? ""
    : total
      ? `${search.index + 1}/${total}`
      : "no matches";

  return (
    <div
      className="flex flex-none items-center gap-2 border-b px-3 py-1.5"
      data-testid="diff-search"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <IconSearch width={12} height={12} style={{ color: "var(--fg-faint)", flex: "none" }} />
      <input
        ref={inputRef}
        autoFocus
        type="text"
        className="input w-64 flex-none px-2 py-0.5 text-xs"
        data-testid="search-input"
        placeholder="find in diff"
        spellCheck={false}
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) search.prev();
            else search.next();
          } else if (e.key === "Escape") {
            e.preventDefault();
            search.close();
          }
        }}
      />
      <span
        className="w-20 flex-none tabular-nums text-2xs"
        data-testid="search-count"
        style={{ color: total || !search.activeQuery ? "var(--fg-muted)" : "var(--warn)" }}
      >
        {status}
      </span>
      <div className="flex flex-none items-center gap-0.5">
        <StepButton
          up
          label="Previous match (shift+enter)"
          testId="search-prev"
          disabled={!total}
          onClick={search.prev}
        />
        <StepButton
          label="Next match (enter)"
          testId="search-next"
          disabled={!total}
          onClick={search.next}
        />
      </div>
      <Segmented
        testId="search-where"
        value={search.scope}
        options={[
          { value: "visible", label: scopeLabel, tip: `Search ${scopeLabel} only (⌘F)` },
          { value: "all", label: "whole diff", tip: "Search the whole diff (⌘⇧F)" },
        ]}
        onChange={search.setScope}
      />
      <Toggle
        testId="search-case"
        active={search.caseSensitive}
        tip={search.caseSensitive ? "Matching case; click to ignore it" : "Ignoring case; click to match it"}
        onClick={() => search.setCaseSensitive(!search.caseSensitive)}
      >
        Aa
      </Toggle>
      <Segmented
        testId="search-lines"
        value={search.changedOnly ? "changed" : "all"}
        options={[
          { value: "changed", label: "changed", tip: "Added and removed lines only" },
          { value: "all", label: "all lines", tip: "Every line, context included" },
        ]}
        onChange={(v) => search.setChangedOnly(v === "changed")}
      />
      <button
        type="button"
        className="ml-auto flex-none text-2xs"
        data-testid="search-close"
        data-tip="Close search"
        data-tip-key="esc"
        aria-label="Close search"
        style={{ color: "var(--fg-faint)" }}
        onClick={search.close}
      >
        <IconClose width={10} height={10} />
      </button>
    </div>
  );
}

function StepButton({
  up,
  label,
  testId,
  disabled,
  onClick,
}: {
  up?: boolean;
  label: string;
  testId: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tip={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-0.5 transition-colors disabled:opacity-30"
      style={{ color: "var(--fg-muted)" }}
    >
      <IconCaret up={up} width={12} height={12} />
    </button>
  );
}

/**
 * Two modes side by side, the one in force lit: the reader sees both the
 * state and the alternative, where a lone toggle with a changing label left
 * it unclear which of the two words was the mode and which the action.
 */
function Segmented<V extends string>({
  value,
  options,
  testId,
  onChange,
}: {
  value: V;
  options: { value: V; label: string; tip: string }[];
  testId: string;
  onChange: (v: V) => void;
}) {
  return (
    <div
      role="radiogroup"
      data-testid={testId}
      className="flex flex-none overflow-hidden rounded text-2xs font-medium"
      style={{ border: "1px solid var(--border)" }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={`${testId}-${o.value}`}
            data-tip={o.tip}
            onClick={() => onChange(o.value)}
            className="px-1.5 py-0.5 transition-colors"
            style={{
              background: on ? "var(--accent-soft)" : "var(--bg-inset)",
              color: on ? "var(--accent)" : "var(--fg-faint)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  active,
  tip,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  tip: string;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-tip={tip}
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className="flex-none rounded px-1.5 py-0.5 text-2xs font-medium transition-colors"
      style={{
        background: active ? "var(--accent-soft)" : "var(--bg-inset)",
        color: active ? "var(--accent)" : "var(--fg-faint)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
      }}
    >
      {children}
    </button>
  );
}
