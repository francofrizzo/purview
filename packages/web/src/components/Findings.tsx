import { useContext, type ReactNode } from "react";
import type { ArchitectureDeviation, Finding, FindingKind } from "../api/types";
import { deviationForAgent } from "../lib/architectureForAgent";
import { useExperiment } from "../lib/experiments";
import { evidenceParts } from "../lib/codeLinks";
import { shownFindings } from "../lib/diffModel";
import { findingForAgent } from "../lib/findingForAgent";
import { CopyLink } from "./CopyForAgent";
import { IconDeviation, IconFindingBug, IconFindingContract, IconFindingUntested, IconWarning } from "./icons";
import { UiText } from "./UiText";
import { CodeLinkContext, InlineMarkdown } from "./Markdown";

/**
 * Findings are what the analysis *verified* in the local checkout, as opposed
 * to everything else on a unit, which is how it wants the diff read. They are
 * annotations: nothing here is actionable by the app, nothing is posted, and
 * a unit that verified nothing renders exactly as it always did. Only
 * warnings show (see shownFindings).
 */

const KIND_LOOK: Record<FindingKind, { label: string; Icon: (p: { width?: number; height?: number }) => ReactNode }> = {
  bug: { label: "Possible bug", Icon: IconFindingBug },
  contract: { label: "Contract break", Icon: IconFindingContract },
  untested: { label: "Untested", Icon: IconFindingUntested },
};

/**
 * The unit's warnings, each with where it was verified; on hover, a copy for
 * an agent. With finding kinds on, each says what it is, and the unit's
 * architecture deviations (written once, in the Overview) follow, each
 * opening its row there.
 */
export function FindingList({
  findings,
  unitTitle,
  deviations = [],
  onOpenDeviation,
}: {
  findings: Finding[];
  unitTitle: string;
  /** the Overview's deviations whose code sits in this unit, by their index there */
  deviations?: { index: number; deviation: ArchitectureDeviation }[];
  onOpenDeviation?: (index: number) => void;
}) {
  const kinds = useExperiment("findingKinds");
  return (
    <ul className="space-y-1.5" data-testid="unit-findings">
      {shownFindings(findings).map((f, i) => {
        const look = kinds && f.kind ? KIND_LOOK[f.kind] : null;
        const Icon = look?.Icon ?? IconWarning;
        return (
          <li key={`${i}-${f.evidence}`} className="group/finding flex items-start gap-1.5 text-2xs leading-4" data-testid="unit-finding" data-kind={look ? f.kind : undefined}>
            <span className="flex-none pt-[3px]" style={{ color: "var(--warn)" }} data-tip={look?.label ?? "warning"} aria-label={look?.label ?? "warning"}>
              <Icon width={10} height={10} />
            </span>
            <span className="min-w-0">
              {look ? (
                <span className="mr-1 font-medium" style={{ color: "var(--fg)" }}>
                  <UiText>{look.label}</UiText>
                </span>
              ) : null}
              <span style={{ color: "var(--fg-muted)" }}>
                <InlineMarkdown text={f.text} />
              </span>
              <Evidence text={f.evidence} />
            </span>
            <CopyLink
              text={() => findingForAgent(f, unitTitle, look?.label)}
              label=""
              tip="Copy as a task for an agent"
              testId="finding-copy"
              className="ml-auto opacity-0 transition-opacity focus-visible:opacity-100 group-hover/finding:opacity-100"
            />
          </li>
        );
      })}
      {kinds
        ? deviations.map(({ index, deviation: d }) => {
            const source = `${d.rule.source}${d.rule.heading ? ` · ${d.rule.heading}` : ""}`;
            return (
            <li key={`deviation-${index}`} className="group/finding flex items-start gap-1.5 text-2xs leading-4" data-testid="unit-deviation">
              <span className="flex-none pt-[3px]" style={{ color: "var(--warn)" }} data-tip="Architecture deviation" aria-label="Architecture deviation">
                <IconDeviation width={10} height={10} />
              </span>
              <span className="min-w-0">
                <span className="mr-1 font-medium" style={{ color: "var(--fg)" }}>
                  <UiText>Deviation</UiText>
                </span>
                <span style={{ color: "var(--fg-muted)" }}>
                  <InlineMarkdown text={d.what} />
                </span>
                <span className="mt-0.5 block font-mono" style={{ color: "var(--fg-faint)" }}>
                  {onOpenDeviation ? (
                    <button
                      type="button"
                      className="rounded text-left underline decoration-dotted underline-offset-2 transition-colors hover:bg-[var(--accent-soft)]"
                      style={{ color: "var(--accent)" }}
                      data-testid="unit-deviation-open"
                      data-tip="The rule beside the code, in the Overview's Architecture"
                      onClick={() => onOpenDeviation(index)}
                    >
                      {source}
                    </button>
                  ) : (
                    source
                  )}
                </span>
              </span>
              <CopyLink
                text={() => deviationForAgent(d)}
                label=""
                tip="Copy the rule, the place and the code as a task for an agent"
                testId="finding-copy"
                className="ml-auto opacity-0 transition-opacity focus-visible:opacity-100 group-hover/finding:opacity-100"
              />
            </li>
            );
          })
        : null}
    </ul>
  );
}

/**
 * Where the finding was verified. Each place the diff shows opens there (the
 * same linker the chat and the brief use); a place outside the diff, usually
 * a caller the PR did not touch, stays text.
 */
function Evidence({ text }: { text: string }) {
  const linkFor = useContext(CodeLinkContext);
  return (
    // Its own line under the finding, each place whole: a path broken across
    // lines (with its comma left on the next) reads as noise.
    <span className="mt-0.5 block font-mono" style={{ color: "var(--fg-faint)" }} data-testid="finding-evidence">
      {evidenceParts(text).map((part, i) => {
        if (!part.ref) return part.text;
        const link = linkFor?.(part.text);
        const place = shortPlace(part.text);
        if (!link) {
          return (
            <span key={i} className="whitespace-nowrap" data-tip={part.text}>
              {place}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            aria-label={part.text}
            className="inline whitespace-nowrap rounded underline decoration-dotted underline-offset-2 transition-colors hover:bg-[var(--accent-soft)]"
            style={{ color: "var(--accent)" }}
            data-tip={`${part.text}: ${link.title}`}
            onClick={link.onOpen}
          >
            {place}
          </button>
        );
      })}
    </span>
  );
}

/** "internal/x/engine.go:837–848" as "engine.go 837–848": the file and where; the folders are on hover. */
function shortPlace(ref: string): string {
  const colon = ref.indexOf(":", ref.lastIndexOf("/") + 1);
  const path = colon === -1 ? ref : ref.slice(0, colon);
  const at = colon === -1 ? "" : ref.slice(colon + 1);
  const name = path.slice(path.lastIndexOf("/") + 1);
  return at ? `${name} ${at}` : name;
}
