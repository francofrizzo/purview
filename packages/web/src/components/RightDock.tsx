import { useState, type ReactNode } from "react";
import { clampChatPanelWidth, useSettings } from "../lib/settings";
import { IconChat, IconCheck, IconClose, IconComment, IconSpinner } from "./icons";

/**
 * The one panel on the right: comments, the review chat, and finishing the
 * review are tabs of a single pane rather than three panels with their own
 * widths and rules about who may be open with whom. One toggle per tab in the
 * top bar (and `m`, `c`, `r`), one resize handle, one remembered width.
 */
export type DockTab = "comments" | "chat" | "review";

export interface DockBadges {
  /** comments still on this machine or in the pending review */
  comments?: number;
  /** the chat is replying */
  chatBusy?: boolean;
  /** what a submit would carry */
  review?: number;
}

const TABS: { id: DockTab; label: string; icon: ReactNode; key: string }[] = [
  { id: "comments", label: "Comments", icon: <IconComment width={12} height={12} />, key: "m" },
  { id: "chat", label: "Chat", icon: <IconChat width={12} height={12} />, key: "c" },
  { id: "review", label: "Review", icon: <IconCheck width={12} height={12} />, key: "r" },
];

export function RightDock({
  tab,
  onSelect,
  onClose,
  badges = {},
  children,
}: {
  tab: DockTab;
  onSelect: (tab: DockTab) => void;
  onClose: () => void;
  badges?: DockBadges;
  children: ReactNode;
}) {
  const { settings, update } = useSettings();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? settings.chatPanelWidth;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => setDragWidth(clampChatPanelWidth(window.innerWidth - ev.clientX));
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Commit once, at the end: the store writes to localStorage on every
      // update and a drag would otherwise produce hundreds of writes.
      update({ chatPanelWidth: clampChatPanelWidth(window.innerWidth - ev.clientX) });
      setDragWidth(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside
      className="pane relative m-[7px] ml-0 rounded-bl-none flex flex-none flex-col overflow-hidden"
      data-testid="right-dock"
      data-tab={tab}
      style={{ width }}
    >
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize"
        data-testid="dock-resize"
        style={{ background: dragWidth === null ? "transparent" : "var(--accent)" }}
      />
      <div
        role="tablist"
        aria-label="Right panel"
        className="flex flex-none items-stretch border-b"
        style={{ borderColor: "var(--border)" }}
      >
        {TABS.map((t) => {
          const on = t.id === tab;
          const badge =
            t.id === "comments" ? badges.comments : t.id === "review" ? badges.review : undefined;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`dock-tab-${t.id}`}
              title={`${t.label} (${t.key})`}
              onClick={() => onSelect(t.id)}
              className="relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors hover:text-[var(--fg)]"
              style={{ color: on ? "var(--fg)" : "var(--fg-faint)" }}
            >
              {t.icon}
              <span>{t.label}</span>
              {badge ? (
                <span
                  className="rounded-full px-1 text-2xs tabular-nums"
                  style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                >
                  {badge}
                </span>
              ) : null}
              {t.id === "chat" && badges.chatBusy ? (
                <IconSpinner width={10} height={10} style={{ color: "var(--accent)" }} />
              ) : null}
              {on ? (
                <span
                  aria-hidden
                  className="absolute inset-x-2 bottom-0 h-[2px] rounded-t"
                  style={{ background: "var(--accent)" }}
                />
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          className="ml-auto px-3"
          onClick={onClose}
          title="Close (esc)"
          aria-label="Close panel"
          data-testid="dock-close"
          style={{ color: "var(--fg-faint)" }}
        >
          <IconClose width={11} height={11} />
        </button>
      </div>
      {children}
    </aside>
  );
}
