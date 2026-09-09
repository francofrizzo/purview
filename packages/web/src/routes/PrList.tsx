import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MOCK, errorText } from "../api/client";
import { useAddPr, useDeletePr, useImportPrs, usePrPeople, usePrs, useSetArchived } from "../api/hooks";
import type { ImportScope, PrListEntry, PrPerson } from "../api/types";
import { AnalysisChip } from "../components/Analysis";
import { Progress, PrStateChip, ReviewDecisionChip } from "../components/Chips";
import { useModalBackground } from "../components/Modal";
import { IconArchive, IconChevron, IconSettings } from "../components/icons";
import {
  formatAddedAt,
  formatFullTimestamp,
  groupPrsByRepo,
  type RepoGroup,
} from "../lib/prList";

export function PrList() {
  const { data: prs = [], isLoading, error } = usePrs();
  const { data: people = {}, isPending: loadingPeople } = usePrPeople();
  const background = useModalBackground();
  const addPr = useAddPr();
  const importPrs = useImportPrs();
  const [importScope, setImportScope] = useState<ImportScope>("review-requested");
  const navigate = useNavigate();
  const [url, setUrl] = useState("");

  const groups = useMemo(() => groupPrsByRepo(prs), [prs]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    addPr.mutate(value, {
      onSuccess: (entry) => {
        setUrl("");
        if (entry?.key) navigate(`/pr/${entry.key}`);
      },
    });
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-10">
      <header className="mb-6 flex items-start">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">Purview</h1>
          <p className="mt-0.5 text-xs" style={{ color: "var(--fg-muted)" }}>
            Local-first pull request review.{" "}
            {MOCK ? (
              <span style={{ color: "var(--warn)" }}>mock mode — no server, fixture data</span>
            ) : (
              <span>talking to localhost:4779</span>
            )}
          </p>
        </div>
        <Link to="/settings" state={{ background }} className="btn flex-none" title="Settings">
          <IconSettings width={12} height={12} />
          settings
        </Link>
      </header>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          className="input font-mono text-xs"
          placeholder="https://github.com/owner/repo/pull/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="btn btn-primary flex-none" disabled={addPr.isPending}>
          {addPr.isPending ? "fetching…" : "add PR"}
        </button>
      </form>

      <div className="mb-6 text-xs">
        <div className="flex flex-wrap gap-2">
          <select
            className="input min-w-0 flex-1 text-xs"
            aria-label="GitHub PRs to import"
            value={importScope}
            onChange={(e) => { setImportScope(e.target.value as ImportScope); importPrs.reset(); }}
            disabled={importPrs.isPending}
          >
            <option value="all">All my open PRs</option>
            <option value="created">Created by me</option>
            <option value="assigned">Assigned to me</option>
            <option value="review-requested">Review requested</option>
          </select>
          <button
            type="button"
            className="btn flex-none"
            disabled={importPrs.isPending || MOCK}
            onClick={() => importPrs.mutate(importScope)}
          >
            {importPrs.isPending ? "Importing…" : "Import from GitHub"}
          </button>
        </div>
        <div role="status" aria-live="polite" className="mt-2 leading-5">
          {importPrs.isPending ? "Fetching your GitHub PRs and adding them for analysis…" : null}
          {!importPrs.isPending && importPrs.data ? (
            <>
              {importPrs.data.added.length === 0 && importPrs.data.failed.length === 0 ? (
                <p>{importPrs.data.skipped.length
                  ? `No new PRs to import. ${importPrs.data.skipped.length} already active in Purview.`
                  : "No matching PRs found."}</p>
              ) : (
                <p>
                  {importPrs.data.added.length} PRs added or restored,
                  {" "}{importPrs.data.queued} analysis jobs queued (oldest PR first),
                  {" "}{importPrs.data.skipped.length} already active,
                  {" "}{importPrs.data.failed.length} failed.
                </p>
              )}
              {importPrs.data.warnings.map((warning) => <p key={warning} style={{ color: "var(--warn)" }}>{warning}</p>)}
              {importPrs.data.failed.map((failure) => (
                <p key={failure.url} style={{ color: "var(--risk)" }}>{failure.url}: {failure.error}</p>
              ))}
            </>
          ) : null}
        </div>
        {importPrs.error ? <p role="alert" style={{ color: "var(--risk)" }}>{errorText(importPrs.error)}</p> : null}
      </div>

      {addPr.error ? (
        <div
          className="mb-4 rounded px-3 py-2 text-xs"
          style={{ background: "var(--risk-soft)", color: "var(--risk)" }}
        >
          {(addPr.error as Error).message}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <p className="surface rounded-md p-4 text-xs" style={{ color: "var(--fg-faint)" }}>
            Loading…
          </p>
        ) : error ? (
          <p className="surface rounded-md p-4 text-xs" style={{ color: "var(--risk)" }}>
            {(error as Error).message}
          </p>
        ) : groups.length === 0 ? (
          <p
            className="surface rounded-md p-4 text-xs leading-5"
            style={{ color: "var(--fg-faint)" }}
          >
            No pull requests tracked yet. Paste a GitHub PR URL above or import your open PRs from GitHub.
          </p>
        ) : (
          <div className="flex flex-col gap-3 pb-6">
            {groups.map((group) => (
              <RepoSection key={group.key} group={group} people={people} loadingPeople={loadingPeople} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One repo: a header row, its PRs, and the archived disclosure at the bottom. */
function RepoSection({ group, people, loadingPeople }: { group: RepoGroup; people: Record<string, PrPerson>; loadingPeople: boolean }) {
  const [showArchived, setShowArchived] = useState(false);
  const { data: archivedPeople = {} } = usePrPeople(true, showArchived);
  const background = useModalBackground();
  const settingsHref = `/repo/${group.host}/${group.owner}/${group.repo}/settings`;

  return (
    <section className="surface elev-1 overflow-hidden rounded-md">
      <header
        className="flex items-center gap-2 border-b px-3 py-1.5"
        style={{ borderColor: "var(--border)", background: "var(--bg-inset)" }}
      >
        <span className="truncate text-xs font-semibold">
          {group.owner}/{group.repo}
        </span>
        {group.host !== "github.com" ? (
          <span
            className="chip flex-none"
            style={{ color: "var(--fg-faint)", background: "var(--bg-hover)" }}
            title={`Hosted on ${group.host}`}
          >
            {group.host}
          </span>
        ) : null}
        <span className="flex-none text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
          {group.prs.length} {group.prs.length === 1 ? "PR" : "PRs"}
        </span>
        <Link
          to={settingsHref}
          state={{ background }}
          className="ml-auto flex-none rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
          title={`Settings for ${group.owner}/${group.repo}`}
          aria-label={`Settings for ${group.owner}/${group.repo}`}
          data-testid={`repo-settings-${group.key}`}
          style={{ color: "var(--fg-faint)" }}
        >
          <IconSettings width={12} height={12} />
        </Link>
      </header>

      {group.prs.length ? (
        (["review", "own", "other", "unknown"] as const).map((relationship) => {
          const prs = group.prs.filter((pr) => (people[pr.key]?.relationship ?? "unknown") === relationship);
          if (!prs.length) return null;
          const label = { review: "For your review", own: "Your PRs", other: "Other PRs", unknown: loadingPeople ? "Loading GitHub…" : "Uncategorized" }[relationship];
          return <div key={relationship}>
            <h3 className="px-3 pt-3 pb-1 text-2xs font-medium" style={{ color: "var(--fg-muted)" }}>{label} <span className="tabular-nums">({prs.length})</span></h3>
            <ul>{prs.map((pr) => <PrRow key={pr.key} pr={pr} person={people[pr.key]} />)}</ul>
          </div>;
        })
      ) : (
        <p className="px-3 py-2.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>Every PR in this repo is archived.</p>
      )}

      {group.archived.length ? (
        <div className="border-t" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            data-testid={`archived-toggle-${group.key}`}
            aria-expanded={showArchived}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-2xs transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--fg-faint)" }}
          >
            <IconChevron open={showArchived} width={10} height={10} />
            archived ({group.archived.length})
          </button>
          {showArchived ? (
            <ul style={{ borderTop: "1px solid var(--border)" }}>
              {group.archived.map((pr) => (
                <PrRow key={pr.key} pr={pr} person={archivedPeople[pr.key] ?? people[pr.key]} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const ARCHIVE_HINT =
  "Archiving cancels analysis and hides the PR here. It changes nothing on GitHub.";

function PrRow({ pr, person }: { pr: PrListEntry; person?: PrPerson }) {
  const setArchived = useSetArchived();
  const deletePr = useDeletePr();
  const archived = pr.archived;
  const meta = pr.meta;

  return (
    <li
      className="flex items-center gap-2 border-b pr-2 transition-colors last:border-b-0 hover:bg-[var(--bg-hover)]"
      style={{ borderColor: "var(--border)", opacity: archived ? 0.55 : 1 }}
      data-testid={`pr-row-${pr.key}`}
    >
      <Link to={`/pr/${pr.key}`} className="min-w-0 flex-1 py-2 pl-3">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">
            {pr.title ?? meta?.title ?? pr.key}
          </span>
          <span className="flex-none font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
            #{meta?.number}
          </span>
          <PrStateChip state={pr.state} />
          <ReviewDecisionChip decision={pr.reviewDecision} />
          <AnalysisChip job={pr.analysisJob} />
        </div>
        <div
          className="mt-0.5 flex items-center gap-2 text-2xs"
          style={{ color: "var(--fg-faint)" }}
        >
          <span>{person?.author || meta?.author ? `@${person?.author ?? meta?.author}` : "Author unavailable"}</span>
          <span>·</span>
          <span title={formatFullTimestamp(pr.addedAt)}>added {formatAddedAt(pr.addedAt)}</span>
          <span>·</span>
          <span className="font-mono">
            {pr.unitCount ? `${pr.unitCount} units` : "not analyzed"}
          </span>
        </div>
      </Link>

      {pr.totalHunks ? (
        <span className="flex-none">
          <Progress viewed={pr.viewedHunks ?? 0} total={pr.totalHunks} />
        </span>
      ) : null}

      <button
        type="button"
        className="flex-none rounded p-1 transition-colors hover:bg-[var(--bg-inset)]"
        data-testid={`archive-${pr.key}`}
        disabled={setArchived.isPending || deletePr.isPending}
        title={`${archived ? "Unarchive" : "Archive"} — ${ARCHIVE_HINT}`}
        aria-label={archived ? "Unarchive" : "Archive"}
        onClick={() => setArchived.mutate({ key: pr.key, archived: !archived })}
        style={{ color: "var(--fg-faint)" }}
      >
        <IconArchive out={archived} width={12} height={12} />
      </button>
      {archived ? <button
        type="button"
        className="btn flex-none text-2xs"
        data-testid={`delete-${pr.key}`}
        disabled={deletePr.isPending || setArchived.isPending}
        aria-label={`Delete PR #${meta?.number}`}
        onClick={() => {
          if (window.confirm(`Delete PR #${meta?.number} from Purview? This cancels analysis and permanently removes local diffs, review progress, draft comments, and chat. The GitHub PR is unchanged.`)) {
            deletePr.mutate(pr.key);
          }
        }}
        style={{ color: "var(--risk)" }}
      >
        {deletePr.isPending ? "Deleting…" : "Delete"}
      </button> : null}
      {deletePr.error ? <span role="alert" className="text-2xs" style={{ color: "var(--risk)" }}>{errorText(deletePr.error)}</span> : null}
    </li>
  );
}
