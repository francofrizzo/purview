import { useContext } from "react";
import type { Finding } from "../api/types";
import { evidenceParts } from "../lib/codeLinks";
import { shownFindings } from "../lib/diffModel";
import { IconWarning } from "./icons";
import { CodeLinkContext, InlineMarkdown } from "./Markdown";

/**
 * Findings are what the analysis *verified* in the local checkout, as opposed
 * to everything else on a unit, which is how it wants the diff read. They are
 * annotations: nothing here is actionable by the app, nothing is posted, and
 * a unit that verified nothing renders exactly as it always did. Only
 * warnings show (see shownFindings).
 */

/** The unit's warnings, each with where it was verified. */
export function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="space-y-1.5" data-testid="unit-findings">
      {shownFindings(findings).map((f, i) => (
        <li key={`${i}-${f.evidence}`} className="flex items-start gap-1.5 text-2xs leading-4">
          <span className="flex-none pt-[3px]" style={{ color: "var(--warn)" }} data-tip="warning" aria-label="warning">
            <IconWarning width={10} height={10} />
          </span>
          <span className="min-w-0">
            <span style={{ color: "var(--fg-muted)" }}>
              <InlineMarkdown text={f.text} />
            </span>
            <Evidence text={f.evidence} />
          </span>
        </li>
      ))}
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
