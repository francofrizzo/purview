import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MOCK } from "../api/client";
import { useAddPr, usePrs, useSetArchived } from "../api/hooks";
import type { PrListEntry } from "../api/types";
import { AnalysisChip } from "../components/Analysis";
import { Progress, PrStateChip, ReviewDecisionChip } from "../components/Chips";
import { IconArchive, IconChevron, IconSettings } from "../components/icons";
import {
  formatAddedAt,
  formatFullTimestamp,
  groupPrsByRepo,
  type RepoGroup,
} from "../lib/prList";

export function PrList() {
  const { data: prs = [], isLoading, error } = usePrs();
  const addPr = useAddPr();
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
        <Link to="/settings" className="btn flex-none" title="Settings">
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
            No pull requests tracked yet. Paste a GitHub PR URL above; the server fetches it with{" "}
            <span className="font-mono">gh</span> and creates the local state directory.
          </p>
        ) : (
          <div className="flex flex-col gap-3 pb-6">
            {groups.map((group) => (
              <RepoSection key={group.key} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One repo: a header row, its PRs, and the archived disclosure at the bottom. */
function RepoSection({ group }: { group: RepoGroup }) {
  const [showArchived, setShowArchived] = useState(false);
  const settingsHref = `/repo/${group.host}/${group.owner}/${group.repo}/settings`;

  return (
    <section className="surface overflow-hidden rounded-md">
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
        <ul>
          {group.prs.map((pr) => (
            <PrRow key={pr.key} pr={pr} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
          Every PR in this repo is archived.
        </p>
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
                <PrRow key={pr.key} pr={pr} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const ARCHIVE_HINT =
  "Archiving is local only — it hides the PR here and changes nothing on GitHub.";

function PrRow({ pr }: { pr: PrListEntry }) {
  const setArchived = useSetArchived();
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
        disabled={setArchived.isPending}
        title={`${archived ? "Unarchive" : "Archive"} — ${ARCHIVE_HINT}`}
        aria-label={archived ? "Unarchive" : "Archive"}
        onClick={() => setArchived.mutate({ key: pr.key, archived: !archived })}
        style={{ color: "var(--fg-faint)" }}
      >
        <IconArchive out={archived} width={12} height={12} />
      </button>
    </li>
  );
}
