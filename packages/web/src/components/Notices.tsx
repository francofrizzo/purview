/**
 * What an action you just took came back with, as toasts at the bottom of the
 * workspace instead of strips between the header and the code: the page never
 * shifts down when one arrives. A result fades on its own (hovering holds it);
 * an error stays until you close it.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconClose, IconWarning } from "./icons";
import { UiText } from "./UiText";
import { useOfflineSince } from "../lib/offline";

export type NoticeTone = "neutral" | "warn" | "error";

/** How long a result stays when nobody is looking at it. */
export const NOTICE_FADE_MS = 8000;

export function NoticeStack({ children, fixed = false }: { children: ReactNode; fixed?: boolean }) {
  return (
    <div
      className={`pointer-events-none ${fixed ? "fixed" : "absolute"} inset-x-0 bottom-3 z-40 flex flex-col items-center gap-2 px-4`}
      data-testid="notices"
      aria-live="polite"
    >
      {children}
    </div>
  );
}

export function Notice({
  tone = "neutral",
  title,
  onDismiss,
  fadeMs,
  testId,
  children,
}: {
  tone?: NoticeTone;
  title: ReactNode;
  onDismiss: () => void;
  /** Fade after this long unless hovered or focused; errors leave it out and stay. */
  fadeMs?: number;
  testId?: string;
  children?: ReactNode;
}) {
  const [held, setHeld] = useState(false);
  // The page re-renders on every poll; the timer must not restart with it.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!fadeMs || held) return;
    const id = window.setTimeout(() => dismiss.current(), fadeMs);
    return () => window.clearTimeout(id);
  }, [fadeMs, held]);

  const color = tone === "error" ? "var(--risk)" : tone === "warn" ? "var(--warn)" : "var(--ok)";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="surface elev-2 pointer-events-auto flex w-full max-w-[30rem] items-start gap-2 rounded-md border px-3 py-2 text-xs"
      style={{ borderColor: tone === "error" ? "var(--risk)" : "var(--border)" }}
      data-testid={testId}
      data-tone={tone}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="flex h-5 flex-none items-center" style={{ color }}>
        {tone === "neutral" ? <IconCheck width={12} height={12} /> : <IconWarning width={12} height={12} />}
      </span>
      <div className="min-w-0 flex-1 leading-5">
        <div className="font-medium" style={{ color: tone === "error" ? "var(--risk)" : "var(--fg)" }}>
          {typeof title === "string" ? <UiText>{title}</UiText> : title}
        </div>
        {children ? <div style={{ color: "var(--fg-muted)" }}>{children}</div> : null}
      </div>
      <button
        type="button"
        className="flex-none rounded p-1 hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--fg-faint)" }}
        aria-label="Dismiss"
        data-tip="Dismiss"
        onClick={onDismiss}
      >
        <IconClose width={10} height={10} />
      </button>
    </div>
  );
}

/**
 * GitHub can't be reached. A warning, never a block: the server is local, so
 * reading, viewed marks, notes and drafts keep saving, and what needs GitHub
 * says so when you try it. Closing it holds until the next time GitHub drops.
 */
export function OfflineNotice() {
  const since = useOfflineSince();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!since || dismissed === since) return null;
  return (
    <Notice tone="warn" title="Offline: GitHub can't be reached" onDismiss={() => setDismissed(since)} testId="offline-notice">
      <UiText>Reading, notes and drafts still save here. Refresh, publishing and reactions wait until GitHub answers.</UiText>
    </Notice>
  );
}
