import { useEffect } from "react";
import type { ChangelogEntry } from "../api/types";
import { InlineMarkdown } from "./Markdown";
import { IconClose } from "./icons";

/**
 * "What's new": the changelog entries the reader has not been shown, floating
 * over the home page the first time Purview opens after an update. Closing it
 * (the button, Esc, a click outside) is what marks them seen. From Settings
 * the same panel shows the whole log, and closing it marks nothing.
 */
export function WhatsNew({
  entries,
  version,
  title = "What's new in Purview",
  onClose,
}: {
  entries: ChangelogEntry[];
  version: string | null;
  title?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-20" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        data-testid="whats-new"
        className="surface flex max-h-[70vh] w-[min(40rem,100%)] flex-col overflow-hidden rounded-lg elev-3"
        style={{ borderColor: "var(--border-strong)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex flex-none items-center gap-2 border-b px-5 py-3" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {version ? (
            <span className="font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
              {version}
            </span>
          ) : null}
          <button
            type="button"
            className="ml-auto flex-none"
            style={{ color: "var(--fg-faint)" }}
            data-tip="Close"
            data-tip-key="esc"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose width={11} height={11} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {entries.map((e, i) => (
            <section key={e.version} className={i > 0 ? "mt-4 border-t pt-4" : ""} style={{ borderColor: "var(--border)" }}>
              <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-semibold">
                <span className="font-mono">{e.version}</span>
                <span className="font-normal" style={{ color: "var(--fg-faint)" }}>
                  {formatDate(e.date)}
                </span>
              </h3>
              <ul className="flex flex-col gap-1.5 pl-4 text-[13px] leading-[20px]" style={{ listStyle: "disc" }}>
                {e.items.map((item, j) => (
                  <li key={j}>
                    <InlineMarkdown text={item} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex flex-none justify-end border-t px-5 py-3" style={{ borderColor: "var(--border)" }}>
          <button type="button" className="btn btn-primary" data-testid="whats-new-close" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}
