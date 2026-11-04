import { useState } from "react";
import type { UnitDiagram as UnitDiagramData } from "../../api/types";
import { useExperiment } from "../../lib/experiments";
import { isSafeDiagram } from "../../lib/unitDiagram";
import { MermaidBlock } from "../Markdown";
import { IconChevron } from "../icons";

const KIND_WORD: Record<UnitDiagramData["kind"], string> = {
  sequence: "Sequence",
  state: "States",
  flow: "Flow",
  er: "Data",
};

/**
 * A unit's diagram (the `unitDiagrams` experiment), under its brief: a
 * caption that folds it, and the diagram drawn the way the app draws every
 * Mermaid diagram (MermaidBlock: the theme's look, a click to see it larger).
 * Source the app refuses, or Mermaid cannot parse, is one faint line, never
 * a crash. Renders nothing while the experiment is off or the unit has none.
 */
export function UnitDiagram({ diagram }: { diagram?: UnitDiagramData }) {
  const on = useExperiment("unitDiagrams");
  if (!on || !diagram) return null;
  return <UnitDiagramBlock diagram={diagram} />;
}

function UnitDiagramBlock({ diagram }: { diagram: UnitDiagramData }) {
  const [folded, setFolded] = useState(false);
  const caption = diagram.title ?? `${KIND_WORD[diagram.kind]} diagram`;
  const failed = (
    <p className="text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="unit-diagram-error">
      diagram could not be drawn
    </p>
  );
  return (
    <div className="flex flex-col gap-1" data-testid="unit-diagram" data-kind={diagram.kind}>
      <button
        type="button"
        className="-ml-1 inline-flex max-w-full items-center gap-1 self-start rounded px-1 text-2xs font-medium hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--fg-muted)" }}
        aria-expanded={!folded}
        data-testid="unit-diagram-toggle"
        onClick={() => setFolded((f) => !f)}
      >
        <IconChevron open={!folded} width={10} height={10} className="flex-none" />
        <span className="uppercase tracking-wide" style={{ color: "var(--fg-faint)" }}>{KIND_WORD[diagram.kind]}</span>
        {diagram.title ? <span className="truncate">{diagram.title}</span> : null}
      </button>
      {folded ? null : !isSafeDiagram(diagram.mermaid) ? (
        failed
      ) : (
        <MermaidBlock
          code={diagram.mermaid}
          open={false}
          caption={caption}
          pending={<div className="h-16 rounded" style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }} aria-busy />}
          failed={failed}
        />
      )}
    </div>
  );
}
