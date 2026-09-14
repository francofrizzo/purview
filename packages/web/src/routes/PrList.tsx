import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MOCK } from "../api/client";
import { useAddPr, useImportReviews, usePrs, useRepos, useSetArchived } from "../api/hooks";
import type { PrListEntry, RepoSummary } from "../api/types";
import { AnalysisChip } from "../components/Analysis";
import { AuthorAvatar } from "../components/AuthorAvatar";
import { Progress, PrStateChip, ReviewDecisionChip } from "../components/Chips";
import { useModalBackground } from "../components/Modal";
import { IconArchive, IconChevron, IconSettings } from "../components/icons";
import { errorText } from "../api/errors";
import { formatImportResult } from "../lib/reviewImport";
import {
  formatAddedAt,
  formatFullTimestamp,
  groupPrsByRepo,
  type RepoGroup,
} from "../lib/prList";

export function PrList() {
  const { data: prs = [], isLoading, error } = usePrs();
  const { data: repos = [] } = useRepos();
  const background = useModalBackground();
  const addPr = useAddPr();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");

  const groups = useMemo(() => groupPrsByRepo(prs), [prs]);
  const repoByKey = useMemo(() => {
    const map = new Map<string, RepoSummary>();
    for (const r of repos) map.set(`${r.host}/${r.owner}/${r.repo}`, r);
    return map;
  }, [repos]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    addPr.mutate(value, {
      onSuccess: (entry) => {
        setUrl("");
        // The shared-analysis note rides along so the PR view can say the
        // analysis was imported rather than looking suspiciously instant.
        if (entry?.key)
          navigate(`/pr/${entry.key}`, {
            state: entry.sharedAnalysis ? { sharedAnalysis: entry.sharedAnalysis } : undefined,
          });
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
              <RepoSection key={group.key} group={group} repo={repoByKey.get(group.key)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One repo: a header row, its PRs, and the archived disclosure at the bottom. */
function RepoSection({ group, repo }: { group: RepoGroup; repo?: RepoSummary }) {
  const [showArchived, setShowArchived] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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
        {repo?.watchReviews ? (
          <span
            className="chip px-0 font-normal flex-none"
            style={{ color: "var(--fg-faint)", background: "transparent" }}
            title={
              repo.watch
                ? `Polling for review requests — last checked ${formatFullTimestamp(repo.watch.checkedAt)}`
                : "Polling for review requests — no check yet"
            }
          >
            watching
          </span>
        ) : null}
        <span className="flex-none text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
          {group.prs.length} {group.prs.length === 1 ? "PR" : "PRs"}
        </span>
        <button
          type="button"
          className="btn ml-auto flex-none"
          data-testid={`import-reviews-toggle-${group.key}`}
          aria-expanded={importOpen}
          onClick={() => setImportOpen((v) => !v)}
        >
          import review requests…
        </button>
        <Link
          to={settingsHref}
          state={{ background }}
          className="flex-none rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
          title={`Settings for ${group.owner}/${group.repo}`}
          aria-label={`Settings for ${group.owner}/${group.repo}`}
          data-testid={`repo-settings-${group.key}`}
          style={{ color: "var(--fg-faint)" }}
        >
          <IconSettings width={12} height={12} />
        </Link>
      </header>

      {importOpen ? (
        <ImportReviewsForm rkey={group.key} onClose={() => setImportOpen(false)} />
      ) : null}

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

/**
 * Inline "import review requests…" form: one numeric input, an import
 * button, and a transient result line. Collapses back into the header's
 * toggle button when the reader cancels or closes it.
 */
function ImportReviewsForm({ rkey, onClose }: { rkey: string; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const importReviews = useImportReviews(rkey);

  const submit = () => {
    importReviews.mutate(days);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-2xs"
      style={{ borderColor: "var(--border)" }}
    >
      <span style={{ color: "var(--fg-faint)" }}>last</span>
      <input
        type="number"
        min={1}
        max={90}
        className="input w-14 px-1.5 py-0.5 text-2xs"
        value={days}
        disabled={importReviews.isPending}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) setDays(Math.min(90, Math.max(1, Math.round(n))));
        }}
      />
      <span style={{ color: "var(--fg-faint)" }}>days</span>
      <button
        type="button"
        className="btn"
        disabled={importReviews.isPending}
        onClick={submit}
      >
        {importReviews.isPending ? "importing…" : "import"}
      </button>
      <button type="button" className="btn" disabled={importReviews.isPending} onClick={onClose}>
        cancel
      </button>
      {importReviews.error ? (
        <span style={{ color: "var(--risk)" }}>{errorText(importReviews.error)}</span>
      ) : importReviews.data ? (
        <span style={{ color: importReviews.data.failed.length ? "var(--risk)" : "var(--fg-faint)" }}>
          {formatImportResult(importReviews.data)}
        </span>
      ) : null}
    </div>
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
          {meta?.author ? (
            <>
              <span className="flex items-center gap-1" title={`Opened by ${meta.author}`}>
                <AuthorAvatar author={meta.author} url={meta.authorAvatarUrl} size={14} />
                {meta.author}
              </span>
              <span>·</span>
            </>
          ) : null}
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
