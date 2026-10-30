import type { Concept } from "../api/types";

/**
 * The words the PR leans on, each with its meaning; the same meanings show on
 * hover wherever the guide uses them. The code's own names for a concept sit
 * faint beside it, so the reader can recognize them in the units.
 */
export function ConceptList({ concepts }: { concepts: Concept[] }) {
  return (
    <div className="mt-4" data-testid="pr-concepts">
      <h2 className="mb-2 text-xs font-semibold" style={{ color: "var(--fg-muted)" }}>
        Concepts
      </h2>
      <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-[minmax(7rem,auto)_1fr]">
        {concepts.map((c) => (
          <div key={c.term} className="contents" data-testid="concept">
            <dt className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] font-medium leading-5" style={{ color: "var(--fg)" }}>
              {c.term}
              {c.isNew ? (
                <span className="chip" style={{ color: "var(--accent)", background: "var(--accent-soft)" }} data-testid="concept-new">
                  new
                </span>
              ) : null}
            </dt>
            <dd className="-mt-1.5 text-[13px] leading-5 sm:mt-0" style={{ color: "var(--fg-muted)" }}>
              {c.means}
              {/* The first names are enough to recognize it in the units; the rest only feed the hover. */}
              {c.aka.length ? (
                <span className="ml-1.5 font-mono text-2xs" style={{ color: "var(--fg-faint)" }} data-tip="As the code and the guide name it">
                  {c.aka.slice(0, 2).join(" · ")}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
