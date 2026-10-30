import { useEffect, useRef, useState } from "react";
import { useVersion } from "../api/hooks";
import { IconDownload } from "./icons";

/** How to move a checkout to the newest release; the server restarts on `pnpm start`. */
export const UPDATE_COMMAND = "git pull && pnpm start";

/**
 * "A newer Purview is on origin": a chip that opens a short card with the
 * version and the command to run. It lives on the home page and renders
 * nothing while there is no update. Nothing here updates anything —
 * the server cannot replace itself while serving — so the card says exactly
 * what to type and leaves it there.
 */
export function UpdateAvailable() {
  const latest = useVersion().data?.latest ?? null;
  return latest ? <UpdateChip latest={latest} /> : null;
}

function UpdateChip({ latest }: { latest: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard: the command is right there to select */
    }
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        className="btn relative"
        data-testid="update-available"
        aria-expanded={open}
        aria-label={`Purview ${latest} is available`}
        data-tip={`Purview ${latest} is available`}
        onClick={() => setOpen((v) => !v)}
        style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
      >
        <IconDownload width={12} height={12} />
        Update available
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Update available"
          data-testid="update-card"
          className="surface elev-3 absolute right-0 top-full z-20 mt-1 w-72 rounded-lg p-3 text-xs"
        >
          <p className="font-medium">Purview {latest} is available</p>
          <p className="mt-1 leading-4" style={{ color: "var(--fg-muted)" }}>
            Pull the checkout and start it again. The server restarts on its own; reload this tab
            once it is back.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-2xs"
              style={{ background: "var(--bg-inset)" }}
            >
              {UPDATE_COMMAND}
            </code>
            <button type="button" className="btn flex-none" onClick={copy}>
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <p className="mt-2 text-2xs" style={{ color: "var(--fg-faint)" }}>
            You can turn this check off in Settings → About.
          </p>
        </div>
      ) : null}
    </div>
  );
}
