import { useEffect, useRef, useState, type ReactNode } from "react";
import { sectionInView } from "./SummaryStrip";

/**
 * The settings screens: titled sections on the right, a sticky list of them
 * on the left that scrolls to a section and underlines the one in view. The
 * same jump bar the summary panel uses, laid out as a rail because a settings
 * screen is long and its sections are many.
 */

export interface SettingsNavItem {
  id: string;
  title: string;
}
export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section id={`settings-${id}`} data-settings-section={id} className="surface mb-4 scroll-mt-4 rounded-md p-4">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {hint ? (
        <p className="mb-3 mt-0.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
          {hint}
        </p>
      ) : (
        <div className="mb-3" />
      )}
      {children}
    </section>
  );
}

/** The nearest scrolling ancestor: the modal's scrollport. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

export function SettingsLayout({ groups, children }: { groups: SettingsNavGroup[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(groups[0]?.items[0]?.id ?? null);
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  // A clicked item holds the highlight until the smooth scroll lands.
  const jumping = useRef<number | null>(null);

  useEffect(() => {
    const scroller = scrollParent(ref.current);
    if (!scroller) return;
    const update = () => {
      if (jumping.current !== null) {
        const landed =
          Math.abs(scroller.scrollTop - jumping.current) < 2 ||
          scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        if (!landed) return;
        jumping.current = null;
      }
      const tops = ids.map((id) => {
        const el = document.getElementById(`settings-${id}`);
        return el ? el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
      });
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      setCurrent(atEnd ? ids[ids.length - 1] : ids[sectionInView(tops, scroller.scrollTop)]);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
    // ids is derived from groups, which are static per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  const jump = (id: string) => {
    const el = document.getElementById(`settings-${id}`);
    const scroller = scrollParent(ref.current);
    if (!el || !scroller) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const top = Math.max(0, el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16);
    jumping.current = Math.min(top, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    setCurrent(id);
  };

  return (
    <div ref={ref} className="flex items-start gap-6">
      <nav className="sticky top-0 hidden w-36 flex-none flex-col gap-3 pt-1 md:flex" aria-label="Sections" data-testid="settings-nav">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="mb-1 px-2 text-2xs font-medium" style={{ color: "var(--fg-faint)" }}>
              {g.label}
            </div>
            {g.items.map((item) => {
              const active = item.id === current;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => jump(item.id)}
                  className="block w-full rounded px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    color: active ? "var(--fg)" : "var(--fg-muted)",
                    background: active ? "var(--bg-hover)" : undefined,
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  {item.title}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
