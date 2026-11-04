import { useState } from "react";
import type { UnitDiagram as UnitDiagramData } from "../../api/types";
import { useExperiment } from "../../lib/experiments";
import { isSafeDiagram } from "../../lib/unitDiagram";
import { DiagramViewer } from "../DiagramViewer";
import { useMermaid } from "../Markdown";
import { IconDiagram } from "../icons";
import { UiText } from "../UiText";

const KIND_WORD: Record<UnitDiagramData["kind"], string> = {
  sequence: "Sequence",
  state: "States",
  flow: "Flow",
  er: "Data",
};

/**
 * A unit's diagram (the `unitDiagrams` experiment), under its brief: one
 * line, "Diagram: its caption", that opens it in the diagram viewer. Nothing
 * is drawn until then. Source the app refuses, or Mermaid cannot parse, is
 * one faint line, never a crash. Renders nothing while the experiment is off
 * or the unit has none.
 */
export function UnitDiagram({ diagram }: { diagram?: UnitDiagramData }) {
  const on = useExperiment("unitDiagrams");
  const [opened, setOpened] = useState(false);
  if (!on || !diagram) return null;
  const caption = diagram.title ?? `${KIND_WORD[diagram.kind]} diagram`;
  if (!isSafeDiagram(diagram.mermaid)) return <Failed />;
  return (
    <div data-testid="unit-diagram" data-kind={diagram.kind}>
      <button
        type="button"
        className="-ml-1 inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-[var(--bg-hover)]"
        data-testid="unit-diagram-open"
        data-tip={`Open the ${KIND_WORD[diagram.kind].toLowerCase()} diagram`}
        onClick={() => setOpened(true)}
      >
        <IconDiagram width={14} height={14} className="flex-none" style={{ color: "var(--accent)" }} />
        <span className="flex-none" style={{ color: "var(--fg-muted)" }}>
          <UiText>Diagram:</UiText>
        </span>
        <span className="truncate" style={{ color: "var(--fg)" }}>
          {caption}
        </span>
      </button>
      {opened ? <Viewer code={diagram.mermaid} caption={caption} onClose={() => setOpened(false)} /> : null}
    </div>
  );
}

/** Drawn only once opened: a unit's diagram costs nothing while it stays shut. */
function Viewer({ code, caption, onClose }: { code: string; caption: string; onClose: () => void }) {
  const result = useMermaid(code, false);
  return (
    <DiagramViewer
      svg={result.status === "ok" && result.svg ? result.svg : null}
      title={caption}
      onClose={onClose}
      fallback={result.status === "pending" ? <UiText className="text-xs text-[var(--fg-faint)]">drawing…</UiText> : <Failed />}
    />
  );
}

function Failed() {
  return (
    <p className="text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="unit-diagram-error">
      <UiText>diagram could not be drawn</UiText>
    </p>
  );
}
