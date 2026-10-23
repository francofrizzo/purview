import { createContext, useContext, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TagChip, TagPopover } from "../components/TagPopover";
import { arrangeBlock, type ArrangedRow } from "../lib/prList";
import { MOCK } from "../api/client";
import {
  useAddPr,
  useImportReviews,
  useMarkVersionSeen,
  usePrs,
  useRefresh,
  useRepos,
  useSetArchived,
  useVersion,
} from "../api/hooks";
import type { PrListEntry, RepoSummary } from "../api/types";
import { AnalysisChip } from "../components/Analysis";
import { AuthorAvatar } from "../components/AuthorAvatar";
import {
  EffortChip,
  Progress,
  PrStateChip,
  CiMark,
  ReviewDecisionChip,
  ReviewRequestAge,
  DiffSizeStat,
} from "../components/Chips";
import { useModalBackground } from "../components/Modal";
import { UpdateAvailable } from "../components/UpdateAvailable";
import { WhatsNew } from "../components/WhatsNew";
import {
  IconArchive,
  IconChevron,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSpinner,
  IconTag,
} from "../components/icons";
import { ReviewersMark, showsReviewers } from "../components/Reviewers";
import { errorText } from "../api/errors";
import { rollbackMessage } from "../lib/rollback";
import { formatImportResult } from "../lib/reviewImport";
import { visibleReviewRequest } from "../lib/reviewRequest";
import {
  formatAddedAt,
  formatFullTimestamp,
  groupPrsByRepo,
  finishedPrKeys,
  partitionRepoGroups,
  prUrlForNumber,
  type RepoGroup,
} from "../lib/prList";
import { AutoArchiveButton, RepoMenu } from "../components/RepoActions";
// Inlined as data URLs by the build (see vite.config.ts): the logo is part of
// the first paint, not a request that lands after the header drew without it.
import logoDark from "../assets/logo-dark.png";
import logoLight from "../assets/logo-light.png";

/**
 * One archive mutation for the whole list, so a refusal (the row already
 * jumped and jumped back) can be reported once at the top rather than lost
 * in the row it happened on.
 */
type TagEditor = { pr: PrListEntry; anchor: HTMLElement };
const TagContext = createContext<(editor: TagEditor) => void>(() => {});

const ArchiveContext = createContext<ReturnType<typeof useSetArchived> | null>(
  null,
);

export function PrList() {
  const [tagEditor, setTagEditor] = useState<TagEditor | null>(null);
  const tagEditorAnchor = useMemo(
    () => ({ current: tagEditor?.anchor ?? null }),
    [tagEditor],
  );
  const { data: prs = [], isLoading, error } = usePrs();
  const { data: repos = [] } = useRepos();
  const background = useModalBackground();
  const addPr = useAddPr();
  const setArchived = useSetArchived();
  const archiveError = rollbackMessage([
    { label: "archiving the PR", error: setArchived.error },
  ]);
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  // First open after an update: the unseen changelog entries float over the
  // list until dismissed, which records the version on the server.
  const version = useVersion();
  const markSeen = useMarkVersionSeen();
  const unseen = version.data?.unseen ?? [];

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
            state: entry.sharedAnalysis
              ? { sharedAnalysis: entry.sharedAnalysis }
              : undefined,
          });
      },
    });
  };

  return (
    <ArchiveContext.Provider value={setArchived}>
      <TagContext.Provider value={setTagEditor}>
        <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-10">
          {unseen.length && version.data?.version && !markSeen.isPending ? (
            <WhatsNew
              entries={unseen}
              version={version.data.version}
              onClose={() => markSeen.mutate(version.data!.version!)}
            />
          ) : null}
          <header className="mb-6 flex items-start">
            <div className="min-w-0 flex-1">
              <h1>
                {/* Two inks, one shown per theme (see index.css); the h1's name is the alt. */}
                <img
                  src={logoLight}
                  alt="Purview"
                  width={110}
                  height={24}
                  className="logo-for-dark h-6 w-auto"
                />
                <img
                  src={logoDark}
                  alt="Purview"
                  width={110}
                  height={24}
                  className="logo-for-light h-6 w-auto"
                />
              </h1>
              {MOCK ? (
                <p className="mt-0.5 text-xs" style={{ color: "var(--warn)" }}>
                  mock mode — no server, fixture data
                </p>
              ) : null}
            </div>
            <div className="flex flex-none items-center gap-2">
              <UpdateAvailable />
              <Link
                to="/settings"
                state={{ background }}
                className="btn"
                data-tip="Settings"
              >
                <IconSettings width={12} height={12} />
                settings
              </Link>
            </div>
          </header>

          <form onSubmit={submit} className="mb-6 flex gap-2">
            <input
              className="input font-mono text-xs"
              placeholder="https://github.com/owner/repo/pull/123"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary flex-none"
              disabled={addPr.isPending}
            >
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
          {archiveError ? (
            <div
              className="mb-4 rounded px-3 py-2 text-xs"
              data-testid="rollback-error"
              style={{ background: "var(--risk-soft)", color: "var(--risk)" }}
            >
              {archiveError}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto">
            {isLoading ? (
              <p
                className="surface flex items-center gap-2 rounded-md p-4 text-xs"
                style={{ color: "var(--fg-faint)" }}
              >
                <IconSpinner width={12} height={12} />
                Loading…
              </p>
            ) : error ? (
              <p
                className="surface rounded-md p-4 text-xs"
                style={{ color: "var(--risk)" }}
              >
                {(error as Error).message}
              </p>
            ) : groups.length === 0 ? (
              <p
                className="surface rounded-md p-4 text-xs leading-5"
                style={{ color: "var(--fg-faint)" }}
              >
                No pull requests tracked yet. Paste a GitHub PR URL above; the
                server fetches it with <span className="font-mono">gh</span> and
                creates the local state directory.
              </p>
            ) : (
              <div className="flex flex-col gap-3 pb-6">
                {tiers.active.map((group) => (
                  <RepoSection
                    key={group.key}
                    group={group}
                    repo={repoByKey.get(group.key)}
                  />
                ))}
                {tiers.active.length === 0 ? (
                  <p
                    className="surface rounded-md p-4 text-xs leading-5"
                    style={{ color: "var(--fg-faint)" }}
                  >
                    Every repo is archived. Unarchive one below, or paste a PR
                    URL above.
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
                      <IconChevron
                        open={showArchivedRepos}
                        width={10}
                        height={10}
                      />
                      Archived repos ({tiers.archived.length})
                    </button>
                    {showArchivedRepos
                      ? tiers.archived.map((group) => (
                          <RepoSection
                            key={group.key}
                            group={group}
                            repo={repoByKey.get(group.key)}
                          />
                        ))
                      : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
        {tagEditor ? (
          <TagPopover
            prKey={tagEditor.pr.key}
            current={tagEditor.pr.meta.tag}
            anchorRef={tagEditorAnchor}
            onClose={() => setTagEditor(null)}
          />
        ) : null}
      </TagContext.Provider>
    </ArchiveContext.Provider>
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
function RepoSection({
  group,
  repo,
}: {
  group: RepoGroup;
  repo?: RepoSummary;
}) {
  const [showArchived, setShowArchived] = useState(false);
  // The shelf opens on its newest page; "show more" walks back in time.
  const [archivedShown, setArchivedShown] = useState(ARCHIVED_PAGE);
  const finishedKeys = finishedPrKeys(group);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const background = useModalBackground();
  const settingsHref = `/repo/${group.host}/${group.owner}/${group.repo}/settings`;
  const repoArchived = group.repoArchived;
  const openCount =
    group.needsReview.length + group.mine.length + group.prs.length;
  // Labels only earn their place once there is more than one block to tell apart.
  const labeled =
    [group.needsReview, group.mine, group.prs].filter((b) => b.length).length >
    1;

  return (
    <section
      className="surface elev-1 overflow-hidden rounded-md"
      data-testid={`repo-section-${group.key}`}
      style={repoArchived ? { opacity: 0.6 } : undefined}
    >
      <header className="flex items-center gap-2 py-2 pl-3 pr-2">
        <span className="truncate text-[13px] font-semibold">
          <span style={{ color: "var(--fg-muted)", fontWeight: 400 }}>
            {group.owner}/
          </span>
          {group.repo}
        </span>
        {group.host !== "github.com" ? (
          <span
            className="chip flex-none"
            style={{ color: "var(--fg-faint)", background: "var(--bg-hover)" }}
            data-tip={`Hosted on ${group.host}`}
          >
            {group.host}
          </span>
        ) : null}
        {repoArchived ? (
          <span
            className="chip flex-none"
            style={{ color: "var(--fg-muted)", background: "var(--bg-hover)" }}
            data-tip="Archived repo: no automatic analyses or watch imports; unarchive from the ⋯ menu"
          >
            archived
          </span>
        ) : null}
        {repo?.watchReviews && !repoArchived ? (
          <span
            className="flex flex-none items-center gap-1 text-2xs"
            style={{ color: "var(--fg-faint)" }}
            data-tip={
              repo.watch
                ? `Polling for review requests; last checked ${formatFullTimestamp(repo.watch.checkedAt)}`
                : "Polling for review requests; no check yet"
            }
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--ok)" }}
            />
            watching
          </span>
        ) : null}
        <span
          className="ml-auto flex-none text-2xs tabular-nums"
          style={{ color: "var(--fg-faint)" }}
        >
          {openCount} {openCount === 1 ? "PR" : "PRs"}
        </span>
        {repoArchived ? null : (
          <button
            type="button"
            className="flex-none rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
            data-tip={`Add a PR from ${group.owner}/${group.repo} by number`}
            aria-label={`Add a PR from ${group.owner}/${group.repo} by number`}
            aria-expanded={addOpen}
            data-testid={`repo-add-pr-${group.key}`}
            onClick={() => setAddOpen((v) => !v)}
            style={{ color: addOpen ? "var(--accent)" : "var(--fg-faint)" }}
          >
            <IconPlus width={12} height={12} />
          </button>
        )}
        <Link
          to={settingsHref}
          state={{ background }}
          className="flex-none rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
          data-tip={`Settings for ${group.owner}/${group.repo}`}
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

      {addOpen && !repoArchived ? (
        <AddByNumberForm repo={group} onClose={() => setAddOpen(false)} />
      ) : null}

      {importOpen && !repoArchived ? (
        <ImportReviewsForm
          rkey={group.key}
          onClose={() => setImportOpen(false)}
        />
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

      {group.archived.length || finishedKeys.length ? (
        <div
          className="flex items-center border-t"
          style={{ borderColor: "var(--border)" }}
        >
          {group.archived.length ? (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              data-testid={`archived-toggle-${group.key}`}
              aria-expanded={showArchived}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left text-2xs transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--fg-faint)" }}
            >
              <IconChevron open={showArchived} width={10} height={10} />
              archived ({group.archived.length})
            </button>
          ) : (
            <span className="flex-1" />
          )}
          {/* The cleanup sits by the list it feeds, not in the ⋯ menu. */}
          {repoArchived ? null : (
            <AutoArchiveButton repo={group} finishedKeys={finishedKeys} />
          )}
        </div>
      ) : null}
      {group.archived.length && showArchived ? (
        <ul style={{ borderTop: "1px solid var(--border)" }}>
          {group.archived.slice(0, archivedShown).map((pr) => (
            <PrRow
              key={pr.key}
              row={{ pr, depth: 0, guides: [], last: true, hasChildren: false }}
            />
          ))}
          {group.archived.length > archivedShown ? (
            <li className="border-t" style={{ borderColor: "var(--border)" }}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-2xs hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--fg-muted)" }}
                data-testid={`archived-more-${group.key}`}
                onClick={() => setArchivedShown((n) => n + ARCHIVED_PAGE)}
              >
                show {Math.min(ARCHIVED_PAGE, group.archived.length - archivedShown)} more of{" "}
                {group.archived.length - archivedShown} older
              </button>
            </li>
          ) : null}
        </ul>
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
  const groups = arrangeBlock(prs);
  return (
    <div data-testid={testId}>
      {label ? (
        <GroupLabel color={color} count={prs.length}>
          {label}
        </GroupLabel>
      ) : null}
      {groups.map((group, i) => (
        <div
          key={group.tag ?? ""}
          data-testid="pr-tag-group"
          data-tag={group.tag ?? ""}
        >
          {group.tag || groups.length > 1 ? (
            <div
              data-testid="pr-tag-heading"
              className="flex items-baseline gap-1.5 border-t px-3 pb-1 pt-2 text-2xs"
              style={{ borderColor: "var(--border)", color: "var(--fg-faint)" }}
            >
              {group.tag ? <TagChip tag={group.tag} /> : <span className="chip">untagged</span>}
              <span className="tabular-nums">{group.prs.length}</span>
            </div>
          ) : null}
          <ul
            className={group.tag || groups.length > 1 || (label && i === 0) ? undefined : "border-t"}
            style={{ borderColor: "var(--border)" }}
          >
            {group.prs.map((row) => (
              <PrRow key={row.pr.key} row={row} waiting={waiting} />
            ))}
          </ul>
        </div>
      ))}
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
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-inset)",
        color,
      }}
    >
      {children}
      <span
        className="tabular-nums"
        style={{ color: "var(--fg-faint)", fontWeight: 400 }}
      >
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
/** "#[123] add" under a repo's header: the PR URL is built from the repo. */
function AddByNumberForm({
  repo,
  onClose,
}: {
  repo: { host: string; owner: string; repo: string; key: string };
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const addPr = useAddPr();
  const navigate = useNavigate();
  const url = prUrlForNumber(repo, value);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url || addPr.isPending) return;
    addPr.mutate(url, {
      onSuccess: (entry) => {
        onClose();
        if (entry?.key)
          navigate(`/pr/${entry.key}`, {
            state: entry.sharedAnalysis
              ? { sharedAnalysis: entry.sharedAnalysis }
              : undefined,
          });
      },
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-2xs"
      style={{ borderColor: "var(--border)" }}
      data-testid={`add-by-number-${repo.key}`}
    >
      <label
        className="flex items-center gap-1"
        style={{ color: "var(--fg-faint)" }}
      >
        #
        <input
          autoFocus
          inputMode="numeric"
          className="input w-24 px-1.5 py-0.5 text-2xs tabular-nums"
          placeholder="PR number"
          aria-label={`PR number in ${repo.owner}/${repo.repo}`}
          value={value}
          disabled={addPr.isPending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
      </label>
      <button type="submit" className="btn" disabled={!url || addPr.isPending}>
        {addPr.isPending ? "fetching…" : "add"}
      </button>
      <button
        type="button"
        className="btn"
        disabled={addPr.isPending}
        onClick={onClose}
      >
        cancel
      </button>
      {addPr.error ? (
        <span style={{ color: "var(--risk)" }}>{errorText(addPr.error)}</span>
      ) : value.trim() && !url ? (
        <span style={{ color: "var(--fg-faint)" }}>a number, like 123</span>
      ) : null}
    </form>
  );
}

function ImportReviewsForm({
  rkey,
  onClose,
}: {
  rkey: string;
  onClose: () => void;
}) {
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
          if (Number.isFinite(n))
            setDays(Math.min(90, Math.max(1, Math.round(n))));
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
      <button
        type="button"
        className="btn"
        disabled={importReviews.isPending}
        onClick={onClose}
      >
        cancel
      </button>
      {importReviews.error ? (
        <span style={{ color: "var(--risk)" }}>
          {errorText(importReviews.error)}
        </span>
      ) : importReviews.data ? (
        <span
          style={{
            color: importReviews.data.failed.length
              ? "var(--risk)"
              : "var(--fg-faint)",
          }}
        >
          {formatImportResult(importReviews.data)}
        </span>
      ) : null}
    </div>
  );
}

const ARCHIVE_HINT = "local only, nothing changes on GitHub";
/** Archived rows shown per click of "show more". */
const ARCHIVED_PAGE = 10;

/**
 * One PR. The title line carries only what is out of the ordinary: "open" and
 * "awaiting approval" are what nearly every row would say, so the list shows
 * the lifecycle state only when it is draft, merged or closed, and the review
 * decision only once it is approved or has changes requested. `waiting` marks
 * a row of the "waiting on your review" block with the warm left rule.
 */
function PrRow({
  row,
  waiting = false,
}: {
  row: ArrangedRow;
  waiting?: boolean;
}) {
  const { pr, depth, hasChildren } = row;
  const openTag = useContext(TagContext);
  const tagButtonRef = useRef<HTMLButtonElement>(null);
  const setArchived = useContext(ArchiveContext)!;
  const archived = pr.archived;
  const meta = pr.meta;
  const edit = (anchor: HTMLElement | null) => {
    if (anchor) openTag({ pr, anchor });
  };

  return (
    <li
      className="group relative flex items-center gap-3 border-b pr-3 transition-colors last:border-b-0 hover:bg-[var(--bg-hover)]"
      style={{
        borderColor: "var(--border)",
        opacity: archived ? 0.55 : 1,
        paddingLeft: depth * STACK_INDENT,
        // A base and its stack read as one block: the tree joins them, no rule between.
        ...(hasChildren ? { borderBottomWidth: 0 } : {}),
      }}
      data-testid={`pr-row-${pr.key}`}
      data-depth={depth || undefined}
    >
      {depth > 0 ? <StackTree row={row} /> : null}
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
          <span
            className="flex-none text-2xs tabular-nums"
            style={{ color: "var(--fg-faint)" }}
          >
            #{meta?.number}
          </span>
        </div>
        <div
          className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs"
          style={{ color: "var(--fg-faint)" }}
        >
          {meta?.author ? (
            <span
              className="flex items-center gap-1"
              data-tip={`Opened by ${meta.author}`}
            >
              <AuthorAvatar
                author={meta.author}
                url={meta.authorAvatarUrl}
                size={14}
              />
              {meta.author}
            </span>
          ) : null}
          {depth === 0 && meta?.basePr ? (
            <span
              data-testid="pr-stacked-on"
              data-tip={`Targets #${meta.basePr.number}: ${meta.basePr.title}`}
            >
              stacked on #{meta.basePr.number}
            </span>
          ) : null}
          {visibleReviewRequest(pr.reviewRequest, pr.state) ? (
            <ReviewRequestAge request={pr.reviewRequest} state={pr.state} />
          ) : null}
          <span data-tip={formatFullTimestamp(pr.addedAt)}>
            added {formatAddedAt(pr.addedAt)}
          </span>
          <DiffSizeStat size={pr.diffSize} files={false} />
          <CiMark ci={pr.ci} />
          {showsReviewers(pr.authoredByYou, pr.state) ? (
            <ReviewersMark reviewers={pr.reviewers} />
          ) : null}
        </div>
        <RowStatus pr={pr} className="mt-1.5 flex flex-wrap sm:hidden" />
      </Link>

      <RowStatus pr={pr} className="hidden flex-none sm:flex" />

      {/* Hover-only, a column the row's two lines leave room for: tag over archive. The tag itself is the group heading above. */}
      <span className="-ml-1 flex flex-none flex-col items-center gap-0.5">
        <button
          ref={tagButtonRef}
          type="button"
          className="rounded p-1 opacity-0 transition hover:!bg-[var(--bg-inset)] focus-visible:opacity-100 group-hover:opacity-100"
          data-testid={`tag-${pr.key}`}
          data-tip={meta?.tag ? `Tagged ${meta.tag}; change it` : "Tag this PR"}
          aria-label={meta?.tag ? "Change the tag" : "Tag this PR"}
          onClick={() => edit(tagButtonRef.current)}
          style={{ color: "var(--fg-faint)", background: "var(--bg-hover)" }}
        >
          <IconTag width={12} height={12} />
        </button>
        <button
          type="button"
          className="rounded p-1 opacity-0 transition hover:!bg-[var(--bg-inset)] focus-visible:opacity-100 group-hover:opacity-100"
          data-testid={`archive-${pr.key}`}
          disabled={setArchived.isPending}
          data-tip={`${archived ? "Unarchive" : "Archive"}; ${ARCHIVE_HINT}`}
          aria-label={archived ? "Unarchive" : "Archive"}
          onClick={() => setArchived.mutate({ key: pr.key, archived: !archived })}
          style={{ color: "var(--fg-faint)", background: "var(--bg-hover)" }}
        >
          <IconArchive out={archived} width={12} height={12} />
        </button>
      </span>
    </li>
  );
}

/** How far each level of a stack steps in, in px. */
const STACK_INDENT = 20;
/** Where a level's guide line sits inside its indent: under the base title's first letter. */
const STACK_LINE = 12;
/** The elbow meets the row at its title line, not the row's middle. */
const STACK_ELBOW_Y = 20;
/** The row above's bottom padding: the line starts right under its text. */
const STACK_RISE = 10;

/**
 * The tree beside a stacked row: one guide line per ancestor that continues
 * below this row, and at the parent's level an elbow into this row, which
 * closes (└) on the last child and carries on (├) otherwise.
 */
function StackTree({ row }: { row: ArrangedRow }) {
  const { depth, guides, last } = row;
  const x = (level: number) => level * STACK_INDENT + STACK_LINE;
  const line = "1px solid var(--fg-faint)";
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0"
      data-testid="stack-tree"
    >
      {guides.map((continues, level) =>
        continues ? (
          <span
            key={level}
            className="absolute inset-y-0"
            style={{ left: x(level), borderLeft: line }}
          />
        ) : null,
      )}
      <span
        className="absolute top-0"
        style={{
          left: x(depth - 1),
          width: STACK_INDENT - STACK_LINE,
          height: STACK_ELBOW_Y + STACK_RISE,
          borderLeft: line,
          borderBottom: line,
          borderBottomLeftRadius: 5,
        }}
      />
      {last ? null : (
        <span
          className="absolute inset-y-0"
          style={{ left: x(depth - 1), borderLeft: line }}
        />
      )}
    </span>
  );
}

/**
 * "update": GitHub holds commits this PR's stored revision does not. Refreshes
 * the PR from the row, without opening it; the list re-reads itself after and
 * the mark goes away on its own (the new revision's head is the one upstream).
 * The row is a link, so the click must not travel.
 */
function UpdateButton({ prKey }: { prKey: string }) {
  const refresh = useRefresh(prKey);
  const error = refresh.isError ? errorText(refresh.error) : null;
  return (
    <button
      type="button"
      className="chip px-0 font-normal disabled:opacity-60"
      style={{ color: "var(--warn)", background: "transparent" }}
      data-testid="update-button"
      data-tip={
        error
          ? `Refresh failed: ${error}`
          : "New commits on GitHub · refresh this PR"
      }
      aria-label="Refresh this PR"
      disabled={refresh.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        refresh.mutate();
      }}
    >
      <IconRefresh
        width={10}
        height={10}
        className={refresh.isPending ? "animate-spin" : undefined}
      />
      update
    </button>
  );
}

/**
 * A row's status cluster: the out-of-the-ordinary state and review decision,
 * the analysis and effort chips, and how far you are through the hunks. Beside
 * the row on wide screens, under the meta line at phone width.
 */
function RowStatus({ pr, className }: { pr: PrListEntry; className: string }) {
  const decision =
    pr.reviewDecision === "review_required" ? null : pr.reviewDecision;
  return (
    <div className={`items-center gap-2 ${className}`}>
      {pr.needsUpdate && (pr.state === "open" || pr.state === "draft") ? (
        <UpdateButton prKey={pr.key} />
      ) : null}
      {pr.state !== "open" ? <PrStateChip state={pr.state} /> : null}
      <ReviewDecisionChip decision={decision} />
      <AnalysisChip job={pr.analysisJob} />
      <EffortChip effort={pr.effort} />
      {/* The unit count sits over the bar: one narrow column for the two numbers of the review's size. */}
      <span className="inline-flex flex-none flex-col items-end gap-0.5">
        <span
          className="text-2xs leading-none tabular-nums"
          style={{ color: "var(--fg-faint)" }}
          data-testid="unit-count"
        >
          {pr.unitCount
            ? `${pr.unitCount} ${pr.unitCount === 1 ? "unit" : "units"}`
            : "not analyzed"}
        </span>
        {pr.totalHunks ? (
          <Progress viewed={pr.viewedHunks ?? 0} total={pr.totalHunks} stacked />
        ) : null}
      </span>
    </div>
  );
}
