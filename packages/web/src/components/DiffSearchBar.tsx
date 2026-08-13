import type { RefObject } from "react";
import type { DiffSearch } from "../lib/useDiffSearch";
import { IconCaret, IconSearch } from "./icons";

/**
 * Compact find bar docked above the diff. It deliberately hijacks Cmd/Ctrl+F:
 * the rows are virtualized, so the browser's own find would only ever see the
 * handful of lines currently mounted.
 */
export function DiffSearchBar({
  search,
  inputRef,
}: {
  search: DiffSearch;
  inputRef: RefObject<HTMLInputElement>;
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
      <Toggle
        testId="search-case"
        active={search.caseSensitive}
        title={search.caseSensitive ? "Matching case" : "Ignoring case"}
        onClick={() => search.setCaseSensitive(!search.caseSensitive)}
      >
        Aa
      </Toggle>
      <Toggle
        testId="search-scope"
        active={!search.changedOnly}
        title={
          search.changedOnly
            ? "Searching added and removed lines only — click to include context"
            : "Searching every line, context included"
        }
        onClick={() => search.setChangedOnly(!search.changedOnly)}
      >
        {search.changedOnly ? "changed" : "all lines"}
      </Toggle>
      <button
        type="button"
        className="ml-auto flex-none text-2xs"
        data-testid="search-close"
        title="Close search (esc)"
        style={{ color: "var(--fg-faint)" }}
        onClick={search.close}
      >
        ✕
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
      title={label}
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

function Toggle({
  active,
  title,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
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
