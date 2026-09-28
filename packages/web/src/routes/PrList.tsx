import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MOCK } from "../api/client";
import { useAddPr, useImportReviews, usePrs, useRepos, useSetArchived } from "../api/hooks";
import type { PrListEntry, RepoSummary } from "../api/types";
import { AnalysisChip } from "../components/Analysis";
import { AuthorAvatar } from "../components/AuthorAvatar";
import {
  EffortChip,
  HunkProgress,
  PrStateChip,
  ReviewDecisionChip,
  ReviewRequestAge,
} from "../components/Chips";
import { useModalBackground } from "../components/Modal";
import { IconArchive, IconChevron, IconSettings } from "../components/icons";
import { errorText } from "../api/errors";
import { formatImportResult } from "../lib/reviewImport";
import { visibleReviewRequest } from "../lib/reviewRequest";
import {
  formatAddedAt,
  formatFullTimestamp,
  groupPrsByRepo,
  partitionRepoGroups,
  type RepoGroup,
} from "../lib/prList";
import { RepoMenu } from "../components/RepoActions";
import logoDark from "../assets/logo-dark.png";
import logoLight from "../assets/logo-light.png";

export function PrList() {
  const { data: prs = [], isLoading, error } = usePrs();
  const { data: repos = [] } = useRepos();
  const background = useModalBackground();
  const addPr = useAddPr();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");

  const groups = useMemo(() => groupPrsByRepo(prs), [prs]);
  const tiers = useMemo(() => partitionRepoGroups(groups), [groups]);
  const [showArchivedRepos, setShowArchivedRepos] = useState(false);
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
          <h1>
            {/* Two inks, one shown per theme (see index.css); the h1's name is the alt. */}
            <img src={logoLight} alt="Purview" className="logo-for-dark h-6 w-auto" />
            <img src={logoDark} alt="Purview" className="logo-for-light h-6 w-auto" />
          </h1>
          {MOCK ? (
            <p className="mt-0.5 text-xs" style={{ color: "var(--warn)" }}>
              mock mode — no server, fixture data
            </p>
          ) : null}
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
            {tiers.active.map((group) => (
              <RepoSection key={group.key} group={group} repo={repoByKey.get(group.key)} />
            ))}
            {tiers.active.length === 0 ? (
              <p
                className="surface rounded-md p-4 text-xs leading-5"
                style={{ color: "var(--fg-faint)" }}
              >
                Every repo is archived. Unarchive one below, or paste a PR URL above.
              </p>
            ) : null}
            {tiers.archived.length ? (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => setShowArchivedRepos((v) => !v)}
                  data-testid="archived-repos-toggle"
                  aria-expanded={showArchivedRepos}
                  className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-2xs transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ color: "var(--fg-faint)" }}
                >
                  <IconChevron open={showArchivedRepos} width={10} height={10} />
                  Archived repos ({tiers.archived.length})
                </button>
                {showArchivedRepos
                  ? tiers.archived.map((group) => (
                      <RepoSection key={group.key} group={group} repo={repoByKey.get(group.key)} />
                    ))
                  : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One repo: a header row, its PRs, and the archived disclosure at the bottom.
 * PRs waiting on your review get their own labeled block on top, marked by a
 * warm rule down the left edge; then "Your PRs" (the ones you opened), then
 * "Other PRs". Those two are labeled only when there is another block to tell
 * them from. A whole archived repo renders the same way, dimmed and without
 * the import entry, and its ⋯ offers the unarchive.
 */
function RepoSection({ group, repo }: { group: RepoGroup; repo?: RepoSummary }) {
  const [showArchived, setShowArchived] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const background = useModalBackground();
  const settingsHref = `/repo/${group.host}/${group.owner}/${group.repo}/settings`;
  const repoArchived = group.repoArchived;
  const openCount = group.needsReview.length + group.mine.length + group.prs.length;
  // Labels only earn their place once there is more than one block to tell apart.
  const labeled = [group.needsReview, group.mine, group.prs].filter((b) => b.length).length > 1;

  return (
    <section
      className="surface elev-1 overflow-hidden rounded-md"
      data-testid={`repo-section-${group.key}`}
      style={repoArchived ? { opacity: 0.6 } : undefined}
    >
      <header className="flex items-center gap-2 py-2 pl-3 pr-2">
        <span className="truncate text-[13px] font-semibold">
          <span style={{ color: "var(--fg-muted)", fontWeight: 400 }}>{group.owner}/</span>
          {group.repo}
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
        {repoArchived ? (
          <span
            className="chip flex-none"
            style={{ color: "var(--fg-muted)", background: "var(--bg-hover)" }}
            title="Archived repo: no automatic analyses or watch imports. Unarchive from the ⋯ menu."
          >
            archived
          </span>
        ) : null}
        {repo?.watchReviews && !repoArchived ? (
          <span
            className="flex flex-none items-center gap-1 text-2xs"
            style={{ color: "var(--fg-faint)" }}
            title={
              repo.watch
                ? `Polling for review requests — last checked ${formatFullTimestamp(repo.watch.checkedAt)}`
                : "Polling for review requests — no check yet"
            }
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--ok)" }} />
            watching
          </span>
        ) : null}
        <span className="ml-auto flex-none text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
          {openCount} {openCount === 1 ? "PR" : "PRs"}
        </span>
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
        <RepoMenu
          repo={group}
          archived={repoArchived}
          onImport={repoArchived ? undefined : () => setImportOpen(true)}
        />
      </header>

      {importOpen && !repoArchived ? (
        <ImportReviewsForm rkey={group.key} onClose={() => setImportOpen(false)} />
      ) : null}

      {group.needsReview.length ? (
        <PrBlock
          testId={`needs-review-${group.key}`}
          label="Waiting on your review"
          color="var(--warn)"
          prs={group.needsReview}
          waiting
        />
      ) : null}
      {group.mine.length ? (
        <PrBlock
          testId={`mine-${group.key}`}
          label={labeled ? "Your PRs" : null}
          prs={group.mine}
        />
      ) : null}
      {group.prs.length ? (
        <PrBlock label={labeled ? "Other PRs" : null} prs={group.prs} />
      ) : openCount ? null : (
        <p
          className="border-t px-3 py-2.5 text-2xs leading-4"
          style={{ borderColor: "var(--border)", color: "var(--fg-faint)" }}
        >
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
 * One of a repo's PR blocks, under its label — or, when the repo has only one
 * block (and it is not the waiting one), unlabeled under a plain divider.
 */
function PrBlock({
  label,
  prs,
  color,
  waiting = false,
  testId,
}: {
  label: string | null;
  prs: PrListEntry[];
  color?: string;
  waiting?: boolean;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      {label ? (
        <GroupLabel color={color} count={prs.length}>
          {label}
        </GroupLabel>
      ) : null}
      <ul className={label ? undefined : "border-t"} style={{ borderColor: "var(--border)" }}>
        {prs.map((pr) => (
          <PrRow key={pr.key} pr={pr} waiting={waiting} />
        ))}
      </ul>
    </div>
  );
}

/** The heading over one of a repo's PR blocks. */
function GroupLabel({
  children,
  count,
  color = "var(--fg-muted)",
}: {
  children: React.ReactNode;
  count: number;
  color?: string;
}) {
  return (
    <div
      className="flex items-baseline gap-1.5 border-y px-3 py-1.5 text-2xs font-medium"
      style={{ borderColor: "var(--border)", background: "var(--bg-inset)", color }}
    >
      {children}
      <span className="tabular-nums" style={{ color: "var(--fg-faint)", fontWeight: 400 }}>
        {count}
      </span>
    </div>
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
      className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-2xs"
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

/**
 * One PR. The title line carries only what is out of the ordinary: "open" and
 * "awaiting approval" are what nearly every row would say, so the list shows
 * the lifecycle state only when it is draft, merged or closed, and the review
 * decision only once it is approved or has changes requested. `waiting` marks
 * a row of the "waiting on your review" block with the warm left rule.
 */
function PrRow({ pr, waiting = false }: { pr: PrListEntry; waiting?: boolean }) {
  const setArchived = useSetArchived();
  const archived = pr.archived;
  const meta = pr.meta;

  return (
    <li
      className="group relative flex items-center gap-3 border-b pr-3 transition-colors last:border-b-0 hover:bg-[var(--bg-hover)]"
      style={{ borderColor: "var(--border)", opacity: archived ? 0.55 : 1 }}
      data-testid={`pr-row-${pr.key}`}
    >
      {waiting ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-0.5"
          style={{ background: "var(--warn)" }}
        />
      ) : null}
      <Link to={`/pr/${pr.key}`} className="min-w-0 flex-1 py-2.5 pl-3">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium">
            {pr.title ?? meta?.title ?? pr.key}
          </span>
          <span className="flex-none text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
            #{meta?.number}
          </span>
        </div>
        <div
          className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs"
          style={{ color: "var(--fg-faint)" }}
        >
          {meta?.author ? (
            <span className="flex items-center gap-1" title={`Opened by ${meta.author}`}>
              <AuthorAvatar author={meta.author} url={meta.authorAvatarUrl} size={14} />
              {meta.author}
            </span>
          ) : null}
          {visibleReviewRequest(pr.reviewRequest, pr.state) ? (
            <ReviewRequestAge request={pr.reviewRequest} state={pr.state} />
          ) : null}
          <span title={formatFullTimestamp(pr.addedAt)}>added {formatAddedAt(pr.addedAt)}</span>
          <span>{pr.unitCount ? `${pr.unitCount} units` : "not analyzed"}</span>
        </div>
        <RowStatus pr={pr} className="mt-1.5 flex flex-wrap sm:hidden" />
      </Link>

      <RowStatus pr={pr} className="hidden flex-none sm:flex" />

      <button
        type="button"
        className="absolute right-2 top-1/2 flex-none -translate-y-1/2 rounded p-1.5 opacity-0 transition hover:!bg-[var(--bg-inset)] focus-visible:opacity-100 group-hover:opacity-100"
        data-testid={`archive-${pr.key}`}
        disabled={setArchived.isPending}
        title={`${archived ? "Unarchive" : "Archive"} — ${ARCHIVE_HINT}`}
        aria-label={archived ? "Unarchive" : "Archive"}
        onClick={() => setArchived.mutate({ key: pr.key, archived: !archived })}
        style={{ color: "var(--fg-faint)", background: "var(--bg-hover)" }}
      >
        <IconArchive out={archived} width={12} height={12} />
      </button>
    </li>
  );
}

/**
 * A row's status cluster: the out-of-the-ordinary state and review decision,
 * the analysis and effort chips, and how far you are through the hunks. Beside
 * the row on wide screens, under the meta line at phone width.
 */
function RowStatus({ pr, className }: { pr: PrListEntry; className: string }) {
  const decision = pr.reviewDecision === "review_required" ? null : pr.reviewDecision;
  return (
    <div className={`items-center gap-2 ${className}`}>
      {pr.state !== "open" ? <PrStateChip state={pr.state} /> : null}
      <ReviewDecisionChip decision={decision} />
      <AnalysisChip job={pr.analysisJob} />
      <EffortChip effort={pr.effort} />
      {pr.totalHunks ? <HunkProgress viewed={pr.viewedHunks ?? 0} total={pr.totalHunks} /> : null}
    </div>
  );
}
