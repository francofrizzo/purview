import { useState } from "react";
import type { Architecture as ArchitectureData, ArchitectureDeviation } from "../../api/types";
import { useExperiment } from "../../lib/experiments";
import { UnitNumber } from "../Chips";
import { CopyPathButton } from "../DiffPane";
import { IconCheck, IconComment, IconFile, IconUnit } from "../icons";
import { InlineMarkdown } from "../Markdown";
import { SectionHead } from "../SectionHead";
import { UiText } from "../UiText";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A doc as a file: its folder faint, its name plain. */
function DocName({ path }: { path: string }) {
  const name = baseName(path);
  const dir = path.slice(0, path.length - name.length);
  return (
    <span className="inline-flex items-center gap-1 font-mono">
      <IconFile width={11} height={11} />
      <span>
        {dir ? <span style={{ color: "var(--fg-faint)" }}>{dir}</span> : null}
        {name}
      </span>
    </span>
  );
}

/** Room for the situation on a line or two; the rule and the code share the rest. */
const COLS = "sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_minmax(0,1fr)_1.25rem]";

/**
 * The PR held against the repo's documented architecture (the `architecture`
 * experiment), after the behavior changes: first where it breaks a rule, the
 * rule quoted beside the code that breaks it; then what it decides that the
 * docs say nothing about, with a line the author could add to them. The
 * header names the docs read and, folded, the rules checked: what an empty
 * answer stands on. Renders nothing while the experiment is off or the
 * analysis found no documented architecture.
 */
export function ArchitectureSection({
  architecture,
  numbers,
  units,
  paths,
  inDiff,
  onOpenUnit,
  onOpenFile,
  onOpenCode,
  onCommentWithRule,
}: {
  architecture?: ArchitectureData;
  numbers: Map<string, number>;
  units: Set<string>;
  /** the PR's files: a doc among them opens in the Files view */
  paths: Set<string>;
  /** whether a line of the head is in the diff, where a draft can sit */
  inDiff: (file: string, line: number) => boolean;
  onOpenUnit: (unitId: string) => void;
  onOpenFile: (path: string) => void;
  /** the unit, scrolled to the line */
  onOpenCode: (unitId: string, file: string, line: number) => void;
  /** a draft on the line, holding only the rule's quote; absent where the line is outside the diff */
  onCommentWithRule?: (deviation: ArchitectureDeviation) => void;
}) {
  const on = useExperiment("architecture");
  const [rulesOpen, setRulesOpen] = useState(false);
  if (!on || !architecture) return null;
  const { sources, checked, deviations, decisions } = architecture;
  const empty = !deviations.length && !decisions.length;
  return (
    <section data-testid="overview-architecture" data-section="architecture">
      <SectionHead title="Architecture">
        <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-2xs">
          {sources.map((src) =>
            paths.has(src) ? (
              <button
                key={src}
                type="button"
                className="transition-colors hover:text-[var(--fg)]"
                style={{ color: "var(--fg-muted)" }}
                data-testid="architecture-source"
                data-tip="Open in Files: this PR changes it"
                onClick={() => onOpenFile(src)}
              >
                <DocName path={src} />
              </button>
            ) : (
              <span key={src} style={{ color: "var(--fg-muted)" }} data-testid="architecture-source" data-tip={`${src}, read at the PR's head; this PR does not change it`}>
                <DocName path={src} />
              </span>
            ),
          )}
          {checked.length && !empty ? (
            <button
              type="button"
              className="transition-colors hover:text-[var(--fg-muted)]"
              style={{ color: "var(--fg-faint)" }}
              aria-expanded={rulesOpen}
              data-testid="architecture-checked-toggle"
              data-tip={rulesOpen ? "Hide the rules checked" : "The rules the diff's files could break, as the docs say them"}
              onClick={() => setRulesOpen((o) => !o)}
            >
              <UiText>{`checked ${checked.length} ${checked.length === 1 ? "rule" : "rules"}`}</UiText>
            </button>
          ) : null}
        </span>
      </SectionHead>

      {rulesOpen && !empty ? (
        <ul className="mb-4 flex flex-col gap-1.5" data-testid="architecture-checked">
          {checked.map((c, i) => (
            <li key={i} className="text-xs leading-[18px]" style={{ color: "var(--fg-muted)" }} data-testid="architecture-checked-rule">
              <InlineMarkdown text={`“${c.rule}”`} />
              <span className="ml-1.5 font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
                {c.source}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {empty ? (
        <div className="flex gap-3" data-testid="architecture-clear">
          <span
            className="mt-px flex h-5 w-5 flex-none items-center justify-center rounded-full"
            style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
            aria-hidden
          >
            <IconCheck width={12} height={12} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium leading-5" style={{ color: "var(--fg)" }} data-testid="architecture-none">
              <UiText>Follows the documented architecture.</UiText>
            </p>
            {checked.length ? (
              <>
                <p className="mt-0.5 text-xs leading-[18px]" style={{ color: "var(--fg-faint)" }}>
                  <UiText>{`Checked against the ${checked.length === 1 ? "rule" : `${checked.length} rules`} these files could break:`}</UiText>
                </p>
                <ul className="mt-2 flex flex-col gap-1.5" data-testid="architecture-checked">
                  {checked.map((c, i) => (
                    <li key={i} className="flex gap-2 text-xs leading-[18px]" data-testid="architecture-checked-rule">
                      <span className="mt-[3px] flex-none" style={{ color: "var(--ok)" }} aria-hidden>
                        <IconCheck width={11} height={11} />
                      </span>
                      <span className="min-w-0" style={{ color: "var(--fg-muted)" }}>
                        <InlineMarkdown text={`“${c.rule}”`} />
                        <span className="ml-1.5 whitespace-nowrap text-2xs" style={{ color: "var(--fg-faint)" }} data-tip={c.source}>
                          {baseName(c.source)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-0.5 text-xs leading-[18px]" style={{ color: "var(--fg-faint)" }}>
                <UiText>No rule in these docs touches the files this PR changes.</UiText>
              </p>
            )}
          </div>
        </div>
      ) : null}

      {deviations.length ? (
        <>
          {/* No padding of its own: the rows' cancels their negative margin, so the
              labels start where the cells' text does. */}
          <div className={`mb-1 hidden gap-x-2 text-2xs font-medium sm:grid ${COLS}`} style={{ color: "var(--fg-faint)" }} aria-hidden>
            <span />
            <UiText className="px-2">Rule</UiText>
            <UiText className="px-2">This PR</UiText>
            <span className="flex items-center justify-center" data-tip="The unit that holds the code">
              <IconUnit width={11} height={11} />
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {deviations.map((d, i) => (
              <DeviationRow
                key={i}
                deviation={d}
                number={units.has(d.code.unit) ? numbers.get(d.code.unit) : undefined}
                onOpen={() => (units.has(d.code.unit) ? onOpenCode(d.code.unit, d.code.file, d.code.line) : onOpenFile(d.code.file))}
                onComment={onCommentWithRule && units.has(d.code.unit) && inDiff(d.code.file, d.code.line) ? () => onCommentWithRule(d) : undefined}
              />
            ))}
          </ul>
        </>
      ) : null}

      {decisions.length ? (
        <div className={deviations.length ? "mt-5" : ""} data-testid="architecture-decisions">
          <p className="mb-1 text-2xs font-medium" style={{ color: "var(--fg-faint)" }}>
            <UiText>Worth documenting</UiText>
          </p>
          <ul className="flex flex-col gap-1">
            {decisions.map((d, i) => {
              const unit = d.unit && units.has(d.unit) ? d.unit : undefined;
              const body = (
                <>
                  <span className="text-[13px] font-medium leading-5" style={{ color: "var(--fg)" }}>
                    <InlineMarkdown text={d.what} />
                  </span>
                  <span className="text-[13px] leading-5 sm:col-span-2 sm:px-2" style={{ color: "var(--fg-muted)" }}>
                    <InlineMarkdown text={d.means} />
                  </span>
                  <span className="hidden justify-center sm:flex">{unit ? <UnitNumber number={numbers.get(unit) ?? 0} /> : null}</span>
                </>
              );
              const row = `grid grid-cols-1 gap-x-2 gap-y-0.5 rounded-md px-2 py-1 text-left ${COLS}`;
              return (
                <li key={i} data-testid="architecture-decision">
                  {unit ? (
                    <button
                      type="button"
                      className={`${row} -mx-2 w-[calc(100%+1rem)] transition-colors hover:bg-[var(--bg-hover)]`}
                      onClick={() => onOpenUnit(unit)}
                      data-tip="Open the unit that makes this decision"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={`${row} -mx-2`}>{body}</div>
                  )}
                  {d.docLine ? (
                    <div className={`grid grid-cols-1 gap-x-2 pb-1 ${COLS}`} data-testid="architecture-docline">
                      <span className="hidden sm:block" />
                      <div className="flex flex-col gap-0.5 border-l-2 pl-2 sm:col-span-2 sm:ml-2" style={{ borderColor: "var(--border)" }}>
                        <span className="text-xs leading-[18px]" style={{ color: "var(--fg-muted)" }}>
                          <InlineMarkdown text={`“${d.docLine.text}”`} />
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 text-2xs" style={{ color: "var(--fg-faint)" }}>
                          <span className="font-mono">
                            {d.docLine.target}
                            {d.docLine.heading ? ` · ${d.docLine.heading}` : ""}
                          </span>
                          <span data-testid="architecture-docline-copy">
                            <CopyPathButton path={d.docLine.text} what="the line for the doc" label="Copy" />
                          </span>
                        </span>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A rule the PR breaks: the situation, the rule as the docs say it, the code
 * that breaks it. The rule sits on a neutral cell (it is neither side of a
 * diff) and the code on the well code sits in; a small risk dot by the
 * situation is all that marks it louder than a concept. The row opens the
 * unit at the line. The analysis's `why`, when it wrote one, is a faint line
 * under the row; the comment action never carries it, only the rule.
 */
function DeviationRow({
  deviation: d,
  number,
  onOpen,
  onComment,
}: {
  deviation: ArchitectureDeviation;
  number?: number;
  onOpen: () => void;
  onComment?: () => void;
}) {
  const where = `${d.code.file}:${d.code.line}`;
  return (
    <li className="group/arch" data-testid="architecture-deviation">
      <button
        type="button"
        className={`grid grid-cols-1 gap-x-2 gap-y-1 rounded-md px-2 py-1 text-left ${COLS} -mx-2 w-[calc(100%+1rem)] transition-colors hover:bg-[var(--bg-hover)]`}
        onClick={onOpen}
        data-tip="Open the unit at this line"
      >
        <span className="flex items-baseline gap-1.5 pt-1.5 text-[13px] font-medium leading-5" style={{ color: "var(--fg)" }}>
          <span
            className="relative -top-px inline-block h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: "var(--risk)" }}
            aria-label="Breaks a documented rule"
            data-testid="architecture-deviation-mark"
          />
          <InlineMarkdown text={d.what} />
        </span>
        <span
          className="flex flex-col gap-0.5 rounded bg-[var(--bg-hover)] px-2 py-1.5 text-[13px] leading-5 group-hover/arch:bg-[color-mix(in_srgb,var(--bg-hover),var(--fg)_6%)]"
          style={{ color: "var(--fg)" }}
          data-testid="architecture-rule"
        >
          <UiText className="sr-only">Rule: </UiText>
          <span>
            <InlineMarkdown text={`“${d.rule.quote}”`} />
          </span>
          <span className="font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
            {d.rule.source}
            {d.rule.heading ? ` · ${d.rule.heading}` : ""}
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 rounded px-2 py-1.5" style={{ background: "var(--bg-inset)" }} data-testid="architecture-code">
          <UiText className="sr-only">This PR: </UiText>
          <code className="block whitespace-pre-wrap break-words font-mono text-xs leading-[18px]" style={{ color: "var(--fg)" }}>
            {d.code.excerpt}
          </code>
          <span className="truncate font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
            {where}
          </span>
        </span>
        <span className="hidden justify-center pt-1.5 sm:flex">{number !== undefined ? <UnitNumber number={number} /> : null}</span>
      </button>
      {d.why || onComment ? (
        <div className={`grid grid-cols-1 gap-x-2 ${COLS}`}>
          <span className="hidden sm:block" />
          <div className="flex items-start gap-3 px-2 pb-1 sm:col-span-2">
            {d.why ? (
              <span className="min-w-0 flex-1 text-xs leading-[18px]" style={{ color: "var(--fg-faint)" }} data-testid="architecture-why">
                <InlineMarkdown text={d.why} />
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {onComment ? (
              <button
                type="button"
                className="inline-flex flex-none items-center gap-1 text-2xs opacity-0 transition-opacity hover:!text-[var(--fg)] focus-visible:opacity-100 group-hover/arch:opacity-100"
                style={{ color: "var(--fg-faint)" }}
                data-testid="architecture-comment"
                data-tip="A draft on this line, quoting the rule"
                onClick={onComment}
              >
                <IconComment width={12} height={12} />
                <UiText>Comment with the rule</UiText>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** The draft a "comment with the rule" opens: the rule quoted, its source, nothing of the analysis's own. */
export function ruleCommentBody(d: ArchitectureDeviation): string {
  const quote = d.rule.quote
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `${quote}\n>\n> — \`${d.rule.source}\`${d.rule.heading ? `, ${d.rule.heading}` : ""}\n\n`;
}
