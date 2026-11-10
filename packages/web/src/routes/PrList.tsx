import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TagPopover } from "../components/TagPopover";
import { arrangeBlock, type ArrangedRow } from "../lib/prList";
import { MOCK } from "../api/client";
import {
  useAddPr,
  useArchiveMany,
  useImportCandidates,
  useImportReviews,
  useMarkVersionSeen,
  usePrs,
  useRefresh,
  useRepos,
  useSetArchived,
  useVersion,
} from "../api/hooks";
import type { ImportCandidate, ImportSource, PrListEntry, RepoSummary } from "../api/types";
import { AuthorAvatar } from "../components/AuthorAvatar";
import {
  EffortMark,
  ProgressRing,
  PrStateMark,
  CiMark,
  ReviewDecisionMark,
  ReviewRequestWait,
  DiffSizeStat,
} from "../components/Chips";
import { useModalBackground } from "../components/Modal";
import { UpdateAvailable } from "../components/UpdateAvailable";
import { NoticeStack, OfflineNotice } from "../components/Notices";
import { WhatsNew } from "../components/WhatsNew";
import {
  IconArchive,
  IconBranch,
  IconCheck,
  IconChevron,
  IconClose,
  IconDensity,
  IconHourglass,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSpinner,
  IconTag,
  IconUnit,
  IconWarning,
} from "../components/icons";
import { ReviewersMark, showsReviewers } from "../components/Reviewers";
import { errorText } from "../api/errors";
import { rollbackMessage } from "../lib/rollback";
import { formatImportResult } from "../lib/reviewImport";
import { useSettings } from "../lib/settings";
import { TAG_COLORS, tagSlot } from "../lib/tags";
import {
  filterRepoGroup,
  finishedPrs,
  formatAddedAt,
  formatFullTimestamp,
  groupPrsByRepo,
  isPrUrl,
  partitionRepoGroups,
  reviewedPrKeys,
  prUrlForNumber,
  tagFoldKey,
  type RepoGroup,
} from "../lib/prList";
import { AutoArchiveButton, RepoMenu } from "../components/RepoActions";
import { TreeLines } from "../components/TreeLines";
// Inlined as data URLs by the build (see vite.config.ts): the logo is part of
// the first paint, not a request that lands after the header drew without it.
import logoDark from "../assets/logo-dark.png";
import logoLight from "../assets/logo-light.png";
import { UiText } from "../components/UiText";

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

/**
 * The rows picked for an action on several PRs at once (tag, archive). While
 * any is picked the list is in selection mode: every row shows its checkbox
 * and a click on a row picks it instead of opening it; shift-click picks the
 * rows between it and the last one clicked, as they appear on the page.
 */
interface Selection {
  keys: Set<string>;
  toggle: (key: string, range: boolean) => void;
}
const SelectionContext = createContext<Selection>({ keys: new Set(), toggle: () => {} });

/** The header's bare icon buttons: no fill or border, a hover tint only. */
const ICON_BUTTON =
  "inline-flex h-7 w-7 flex-none items-center justify-center rounded text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]";

/**
 * The home: one header line (the logo, the field that searches the list or
 * adds a pasted PR URL, and the icon buttons), then a card per repo. The page
 * scrolls, not the list, so the sticky header and the cards share one width
 * whether or not there is a scrollbar; the header's rule shows once scrolled.
 */
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
  const archiveMany = useArchiveMany();
  const tagMany = useRef<HTMLButtonElement>(null);
  const [tagManyOpen, setTagManyOpen] = useState(false);
  const archiveError = rollbackMessage([
    { label: "archiving the PR", error: setArchived.error },
    { label: "archiving the PRs", error: archiveMany.error },
  ]);
  const [picked, setPicked] = useState<string[]>([]);
  const lastPicked = useRef<string | null>(null);
  const navigate = useNavigate();
  const { settings, update } = useSettings();
  const compact = settings.compactRows;
  // One field for both: a PR URL adds the PR, anything else filters the list.
  const [field, setField] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const fieldIsUrl = isPrUrl(field);
  const query = fieldIsUrl ? "" : field.trim();
  const [scrolled, setScrolled] = useState(false);
  // First open after an update: the unseen changelog entries float over the
  // list until dismissed, which records the version on the server.
  const version = useVersion();
  const markSeen = useMarkVersionSeen();
  const unseen = version.data?.unseen ?? [];

  const groups = useMemo(() => groupPrsByRepo(prs), [prs]);
  const tiers = useMemo(() => partitionRepoGroups(groups), [groups]);
  const shown = useMemo(() => {
    const cut = (list: RepoGroup[]) =>
      list.flatMap((group) => {
        const match = filterRepoGroup(group, query);
        return match ? [{ group: match, full: group }] : [];
      });
    return { active: cut(tiers.active), archived: cut(tiers.archived) };
  }, [tiers, query]);
  const [showArchivedRepos, setShowArchivedRepos] = useState(false);
  const repoByKey = useMemo(() => {
    const map = new Map<string, RepoSummary>();
    for (const r of repos) map.set(`${r.host}/${r.owner}/${r.repo}`, r);
    return map;
  }, [repos]);

  // A PR that left the list (removed elsewhere) drops out of the selection.
  const selected = useMemo(() => {
    const live = new Set(prs.map((pr) => pr.key));
    return picked.filter((key) => live.has(key));
  }, [picked, prs]);
  const toggle = useCallback((key: string, range: boolean) => {
    const from = lastPicked.current;
    lastPicked.current = key;
    setPicked((current) => {
      if (range && from && from !== key) {
        const order = [...document.querySelectorAll<HTMLElement>("[data-pr-key]")].map((el) => el.dataset.prKey!);
        const [a, b] = [order.indexOf(from), order.indexOf(key)].sort((x, y) => x - y);
        if (a >= 0) return [...new Set([...current, ...order.slice(a, b + 1)])];
      }
      return current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    });
  }, []);
  const clearSelection = useCallback(() => {
    setPicked([]);
    setTagManyOpen(false);
    lastPicked.current = null;
  }, []);
  const selection = useMemo<Selection>(() => ({ keys: new Set(selected), toggle }), [selected, toggle]);
  const selectedPrs = prs.filter((pr) => selection.keys.has(pr.key));
  const selectedTags = new Set(selectedPrs.map((pr) => pr.meta.tag));
  const toArchive = selectedPrs.filter((pr) => !pr.archived).map((pr) => pr.key);
  const toUnarchive = selectedPrs.filter((pr) => pr.archived).map((pr) => pr.key);

  // Escape lets go of the selection, unless a text box or a panel has it.
  useEffect(() => {
    if (!selected.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      clearSelection();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected.length, clearSelection]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // "/" goes to the field from anywhere on the page, unless something else
  // takes the keys: a text box, or a dialog over the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      fieldRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = field.trim();
    if (!fieldIsUrl || addPr.isPending) return;
    addPr.mutate(value, {
      onSuccess: (entry) => {
        setField("");
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
      <SelectionContext.Provider value={selection}>
        <div className="mx-auto flex min-h-full max-w-3xl flex-col px-6 2xl:max-w-[49rem]">
          {unseen.length && version.data?.version && !markSeen.isPending ? (
            <WhatsNew
              entries={unseen}
              version={version.data.version}
              onClose={() => markSeen.mutate(version.data!.version!)}
            />
          ) : null}
          <header
            className="sticky top-0 z-10 flex items-center gap-3 border-b pb-[18px] pt-7 transition-colors duration-[120ms] sm:gap-5"
            data-testid="home-header"
            data-scrolled={scrolled || undefined}
            style={{
              background: "var(--bg)",
              borderColor: scrolled ? "var(--border)" : "transparent",
              // Covers the cards' shadows as they scroll under the header's edges.
              boxShadow: "-10px 0 0 var(--bg), 10px 0 0 var(--bg)",
            }}
          >
            <h1 className="relative flex-none">
              {/* Two inks, one shown per theme (see index.css); the h1's name is the alt. */}
              <img
                src={logoLight}
                alt="Purview"
                width={110}
                height={24}
                className="logo-for-dark h-[22px] w-auto"
              />
              <img
                src={logoDark}
                alt="Purview"
                width={110}
                height={24}
                className="logo-for-light h-[22px] w-auto"
              />
              {MOCK ? (
                <span
                  className="absolute left-0 top-full mt-0.5 whitespace-nowrap text-2xs font-normal"
                  style={{ color: "var(--warn)" }}
                >
                  <UiText>mock mode — no server, fixture data</UiText>
                </span>
              ) : null}
            </h1>
            <form onSubmit={submit} className="min-w-0 flex-1">
              <label className="flex h-8 cursor-text items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-raised)] pl-2.5 pr-1 text-[var(--fg-faint)] focus-within:border-[var(--accent)]">
                <IconSearch width={12} height={12} className="flex-none" />
                <input
                  ref={fieldRef}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent text-xs text-[var(--fg)] outline-none placeholder:text-[var(--fg-faint)]"
                  placeholder="Search PRs, or paste a PR URL to add it"
                  aria-label="Search PRs, or paste a PR URL to add it"
                  data-testid="home-find"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    setField("");
                    e.currentTarget.blur();
                  }}
                />
                {fieldIsUrl ? (
                  <button
                    type="submit"
                    className="btn btn-primary h-[22px] min-h-0 flex-none px-2 py-0"
                    data-testid="home-add-pr"
                    disabled={addPr.isPending}
                  >
                    <UiText>{addPr.isPending ? "fetching…" : "add PR"}</UiText>
                  </button>
                ) : (
                  <kbd className="mr-1 flex-none" data-tip="Search PRs" data-tip-key="/">
                    <UiText>/</UiText>
                  </kbd>
                )}
              </label>
            </form>
            <div className="flex flex-none items-center gap-0.5">
              <button
                type="button"
                className={ICON_BUTTON}
                data-testid="home-compact"
                aria-label="Compact rows"
                aria-pressed={compact}
                data-tip={compact ? "Comfortable rows" : "Compact rows"}
                onClick={() => update({ compactRows: !compact })}
                style={compact ? { background: "var(--bg-hover)", color: "var(--fg)" } : undefined}
              >
                <IconDensity width={15} height={15} />
              </button>
              <UpdateAvailable className={ICON_BUTTON} />
              <Link
                to="/settings"
                state={{ background }}
                className={ICON_BUTTON}
                aria-label="Settings"
                data-tip="Settings"
                data-testid="home-settings"
              >
                <IconSettings width={15} height={15} />
              </Link>
            </div>
          </header>

          {addPr.error ? (
            <div
              className="mt-1.5 rounded px-3 py-2 text-xs"
              style={{ background: "var(--risk-soft)", color: "var(--risk)" }}
            >
              {(addPr.error as Error).message}
            </div>
          ) : null}
          {archiveError ? (
            <div
              className="mt-1.5 rounded px-3 py-2 text-xs"
              data-testid="rollback-error"
              style={{ background: "var(--risk-soft)", color: "var(--risk)" }}
            >
              {archiveError}
            </div>
          ) : null}

          <div className="flex-1 pt-1.5">
            {isLoading ? (
              <p
                className="surface flex items-center gap-2 rounded-md p-4 text-xs"
                style={{ color: "var(--fg-faint)" }}
              >
                <IconSpinner width={12} height={12} />
                <UiText>Loading…</UiText>
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
                <UiText>No pull requests tracked yet. Paste a GitHub PR URL above; the server fetches it with</UiText>{" "}
                <span className="font-mono"><UiText>gh</UiText></span>{" "}
                <UiText>and creates the local state directory.</UiText>
              </p>
            ) : query && !shown.active.length && !shown.archived.length ? (
              <p
                className="py-6 text-center text-xs"
                style={{ color: "var(--fg-muted)" }}
                data-testid="home-find-empty"
              >
                <UiText>{`No PR matches "${query}". Paste a PR URL to add it.`}</UiText>
              </p>
            ) : (
              <div className={`flex flex-col gap-[22px] ${selectedPrs.length ? "pb-20" : "pb-6"}`}>
                {shown.active.map(({ group, full }) => (
                  <RepoSection
                    key={group.key}
                    group={group}
                    full={full}
                    repo={repoByKey.get(group.key)}
                  />
                ))}
                {tiers.active.length === 0 ? (
                  <p
                    className="surface rounded-md p-4 text-xs leading-5"
                    style={{ color: "var(--fg-faint)" }}
                  >
                    <UiText>Every repo is archived. Unarchive one below, or paste a PR URL above.</UiText>
                  </p>
                ) : null}
                {shown.archived.length ? (
                  <div className="flex flex-col gap-[22px]">
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
                      <UiText>{`Archived repos (${shown.archived.length})`}</UiText>
                    </button>
                    {showArchivedRepos
                      ? shown.archived.map(({ group, full }) => (
                          <RepoSection
                            key={group.key}
                            group={group}
                            full={full}
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
        {selectedPrs.length ? (
          <div
            className="surface elev-2 fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-md py-1 pl-3 pr-1 text-xs"
            role="toolbar"
            aria-label="Selected PRs"
            data-testid="selection-bar"
          >
            <span className="mr-2 whitespace-nowrap tabular-nums" style={{ color: "var(--fg-muted)" }} data-testid="selection-count">
              <UiText>{`${selectedPrs.length} selected`}</UiText>
            </span>
            <SelectionAction
              buttonRef={tagMany}
              testId="selection-tag"
              icon={<IconTag width={13} height={13} />}
              label="Tag"
              tip={`Tag the ${selectedPrs.length === 1 ? "selected PR" : `${selectedPrs.length} selected PRs`}`}
              onClick={() => setTagManyOpen((v) => !v)}
            />
            {toArchive.length ? (
              <SelectionAction
                testId="selection-archive"
                icon={<IconArchive width={13} height={13} />}
                label={toUnarchive.length ? `Archive ${toArchive.length}` : "Archive"}
                tip={`Archive ${toArchive.length === 1 ? "it" : `the ${toArchive.length}`}; ${ARCHIVE_HINT}`}
                disabled={archiveMany.isPending}
                onClick={() => {
                  archiveMany.mutate({ keys: toArchive, archived: true });
                  clearSelection();
                }}
              />
            ) : null}
            {toUnarchive.length ? (
              <SelectionAction
                testId="selection-unarchive"
                icon={<IconArchive out width={13} height={13} />}
                label={toArchive.length ? `Unarchive ${toUnarchive.length}` : "Unarchive"}
                tip={`Unarchive ${toUnarchive.length === 1 ? "it" : `the ${toUnarchive.length}`}; ${ARCHIVE_HINT}`}
                disabled={archiveMany.isPending}
                onClick={() => {
                  archiveMany.mutate({ keys: toUnarchive, archived: false });
                  clearSelection();
                }}
              />
            ) : null}
            <span className="mx-1 h-4 w-px" style={{ background: "var(--border)" }} aria-hidden />
            <button
              type="button"
              className={ICON_BUTTON}
              data-testid="selection-clear"
              aria-label="Clear the selection"
              data-tip="Clear the selection"
              data-tip-key="Esc"
              onClick={clearSelection}
            >
              <IconClose width={14} height={14} />
            </button>
          </div>
        ) : null}
        {tagManyOpen && selectedPrs.length ? (
          <TagPopover
            prKey={selectedPrs[0].key}
            prKeys={selectedPrs.map((pr) => pr.key)}
            current={selectedTags.size === 1 ? [...selectedTags][0] : undefined}
            anchorRef={tagMany}
            onClose={() => setTagManyOpen(false)}
          />
        ) : null}
        <NoticeStack fixed>
          <OfflineNotice />
        </NoticeStack>
      </SelectionContext.Provider>
      </TagContext.Provider>
    </ArchiveContext.Provider>
  );
}

/** A labeled action in the selection bar. */
function SelectionAction({
  buttonRef,
  testId,
  icon,
  label,
  tip,
  disabled,
  onClick,
}: {
  buttonRef?: React.Ref<HTMLButtonElement>;
  testId: string;
  icon: ReactNode;
  label: string;
  tip: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="inline-flex h-7 items-center gap-1.5 rounded px-2 text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-50"
      data-testid={testId}
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <UiText>{label}</UiText>
    </button>
  );
}

/**
 * One repo: a header row, its PRs, and the archived disclosure at the bottom.
 * PRs waiting on your review get their own labeled block on top, under a warm
 * label; then "Your PRs" (the ones you opened), then "Other PRs". Those two
 * are labeled only when there is another block to tell them from. A whole
 * archived repo renders the same way, dimmed and without the import entry,
 * and its ⋯ offers the unarchive. `group` is what the search left of the
 * repo; the counts and the cleanup read `full`, the whole of it.
 */
function RepoSection({
  group,
  full,
  repo,
}: {
  group: RepoGroup;
  full: RepoGroup;
  repo?: RepoSummary;
}) {
  const [showArchived, setShowArchived] = useState(false);
  // The shelf opens on its newest page; "show more" walks back in time.
  const [archivedShown, setArchivedShown] = useState(ARCHIVED_PAGE);
  const finished = finishedPrs(full);
  const reviewedKeys = reviewedPrKeys(full);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const background = useModalBackground();
  const settingsHref = `/repo/${group.host}/${group.owner}/${group.repo}/settings`;
  const repoArchived = group.repoArchived;
  const openCount =
    full.needsReview.length + full.mine.length + full.prs.length;
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
            <UiText>archived</UiText>
          </span>
        ) : null}
        {(repo?.watchReviews || repo?.watchOwn) && !repoArchived ? (
          <span
            className="flex flex-none items-center gap-1 text-2xs"
            style={{ color: "var(--fg-faint)" }}
            data-tip={
              `Polling for ${[repo.watchReviews && "review requests", repo.watchOwn && "your PRs"].filter(Boolean).join(" and ")}; ${repo.watch ? `last checked ${formatFullTimestamp(repo.watch.checkedAt)}` : "no check yet"}${repo.watchReviews && repo.watch?.error ? `; review requests failed: ${repo.watch.error}` : ""}${repo.watchOwn && repo.watch?.own?.error ? `; your PRs failed: ${repo.watch.own.error}` : ""}`
            }
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--ok)" }}
            />
            <UiText>watching</UiText>
          </span>
        ) : null}
        <span
          className="ml-auto flex-none text-2xs tabular-nums"
          style={{ color: "var(--fg-faint)" }}
        >
          <UiText>{`${openCount} ${openCount === 1 ? "PR" : "PRs"}`}</UiText>
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
          repo={repo}
          onClose={() => setImportOpen(false)}
        />
      ) : null}

      {group.needsReview.length ? (
        <PrBlock
          testId={`needs-review-${group.key}`}
          label="Waiting on your review"
          color="var(--warn)"
          prs={group.needsReview}
          foldPrefix={`${group.key}|needs-review`}
        />
      ) : null}
      {group.mine.length ? (
        <PrBlock
          testId={`mine-${group.key}`}
          label={labeled ? "Your PRs" : null}
          prs={group.mine}
          foldPrefix={`${group.key}|mine`}
        />
      ) : null}
      {group.prs.length ? (
        <PrBlock
          label={labeled ? "Other PRs" : null}
          prs={group.prs}
          foldPrefix={`${group.key}|other`}
        />
      ) : openCount ? null : (
        <p
          className="border-t px-3 py-2.5 text-2xs leading-4"
          style={{ borderColor: "var(--border)", color: "var(--fg-faint)" }}
        >
          <UiText>Every PR in this repo is archived.</UiText>
        </p>
      )}

      {group.archived.length || finished.length || reviewedKeys.length ? (
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
              <UiText>{`archived (${group.archived.length})`}</UiText>
            </button>
          ) : (
            <span className="flex-1" />
          )}
          {/* The cleanup sits by the list it feeds, not in the ⋯ menu. */}
          {repoArchived ? null : (
            <AutoArchiveButton repo={group} finished={finished} reviewedKeys={reviewedKeys} />
          )}
        </div>
      ) : null}
      {group.archived.length && showArchived ? (
        <ul style={{ borderTop: "1px solid var(--border)" }}>
          {group.archived.slice(0, archivedShown).map((pr) => (
            <PrRow
              key={pr.key}
              row={{ pr, depth: 0, guides: [], last: true, joinsNext: false }}
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
                <UiText>{`show ${Math.min(ARCHIVED_PAGE, group.archived.length - archivedShown)} more of ${group.archived.length - archivedShown} older`}</UiText>
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
 * Its tag groups fold, each remembered by `foldPrefix` and the tag.
 */
function PrBlock({
  label,
  prs,
  color,
  foldPrefix,
  testId,
}: {
  label: string | null;
  prs: PrListEntry[];
  color?: string;
  /** `repo|block`, the start of each tag group's fold key */
  foldPrefix: string;
  testId?: string;
}) {
  const { settings, update } = useSettings();
  const groups = arrangeBlock(prs);
  const [repoKey, block] = foldPrefix.split("|");
  return (
    <div data-testid={testId}>
      {label ? (
        <GroupLabel color={color} count={prs.length}>
          <UiText>{label}</UiText>
        </GroupLabel>
      ) : null}
      {groups.map((group, i) => {
        const headed = Boolean(group.tag) || groups.length > 1;
        const foldKey = tagFoldKey(repoKey, block, group.tag);
        const open = !headed || !settings.foldedTagGroups.includes(foldKey);
        const toggle = () =>
          update({
            foldedTagGroups: open
              ? [...settings.foldedTagGroups, foldKey]
              : settings.foldedTagGroups.filter((k) => k !== foldKey),
          });
        return (
          <div
            key={group.tag ?? ""}
            data-testid="pr-tag-group"
            data-tag={group.tag ?? ""}
          >
            {headed ? (
              <TagBand tag={group.tag} count={group.prs.length} open={open} onToggle={toggle} />
            ) : null}
            {open ? (
              <ul
                className={headed || (label && i === 0) ? undefined : "border-t"}
                style={{ borderColor: "var(--border)" }}
              >
                {group.prs.map((row) => (
                  <PrRow key={row.pr.key} row={row} />
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A tag's heading: a full-width band that folds the group, with the tag icon
 * in the tag's color. A faint tint and a rule above and below; it overlaps
 * the rule over it by a pixel, and folded it leaves the rule under it to
 * whatever comes next, so two rules never stack.
 */
function TagBand({
  tag,
  count,
  open,
  onToggle,
}: {
  tag: string | null;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = tag ? TAG_COLORS[tagSlot(tag)] : null;
  return (
    <button
      type="button"
      data-testid="pr-tag-heading"
      aria-expanded={open}
      onClick={onToggle}
      data-tip={`${open ? "Fold" : "Unfold"} ${tag ? `the ${tag} PRs` : "the untagged PRs"}`}
      className={`relative -mt-px flex w-full items-center gap-1.5 border-t px-4 py-1.5 text-left text-2xs leading-[normal] text-[var(--fg-muted)] transition-colors hover:text-[var(--fg)] ${open ? "border-b" : ""}`}
      style={{
        borderColor: "var(--border)",
        background: "color-mix(in srgb, var(--fg) 2.5%, transparent)",
      }}
    >
      <IconChevron open={open} width={10} height={10} className="flex-none" style={{ color: "var(--fg-faint)" }} />
      {/* The tag as the chip it is everywhere else; "untagged" stays plain. */}
      <span
        className="chip gap-1"
        style={
          kind
            ? { color: `var(--kind-${kind})`, background: `var(--kind-${kind}-soft)` }
            : { color: "var(--fg-muted)", background: "transparent", paddingLeft: 0 }
        }
        data-testid={tag ? "pr-tag" : undefined}
      >
        <IconTag width={11} height={11} className="flex-none" />
        {tag ?? <UiText>untagged</UiText>}
      </span>
      <span className="tabular-nums" style={{ color: "var(--fg-faint)" }}>
        {count}
      </span>
    </button>
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
      className="flex items-baseline gap-1.5 border-y px-4 py-[7px] text-xs font-medium"
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-inset)",
        color,
      }}
    >
      {children}
      <span
        className="text-2xs tabular-nums"
        style={{ color: "var(--fg-faint)", fontWeight: 400 }}
      >
        {count}
      </span>
    </div>
  );
}

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
        <UiText>{addPr.isPending ? "fetching…" : "add"}</UiText>
      </button>
      <button
        type="button"
        className="btn"
        disabled={addPr.isPending}
        onClick={onClose}
      >
        <UiText>cancel</UiText>
      </button>
      {addPr.error ? (
        <span style={{ color: "var(--risk)" }}>{errorText(addPr.error)}</span>
      ) : value.trim() && !url ? (
        <span style={{ color: "var(--fg-faint)" }}><UiText>a number, like 123</UiText></span>
      ) : null}
    </form>
  );
}

/**
 * Inline "import PRs…" form, in two steps. First what to look for: how many
 * days back, and which searches (PRs that want your review, PRs you opened;
 * they start as the repo's watch settings). Then the PRs found, each with a
 * checkbox: new ones start ticked, an archived one can be ticked to bring it
 * back, and one already on the list is shown but cannot be picked.
 */
function ImportReviewsForm({
  rkey,
  repo,
  onClose,
}: {
  rkey: string;
  repo?: RepoSummary;
  onClose: () => void;
}) {
  const [days, setDays] = useState(7);
  const [picked, setPicked] = useState<ImportSource[] | null>(null);
  const sources: ImportSource[] = picked ?? defaultImportSources(repo);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const find = useImportCandidates(rkey);
  const importReviews = useImportReviews(rkey);
  const busy = find.isPending || importReviews.isPending;
  const candidates = find.data?.candidates;

  const toggleSource = (source: ImportSource, on: boolean) => {
    const next = on ? [...new Set([...sources, source])] : sources.filter((s) => s !== source);
    setPicked(next);
    find.reset();
  };
  const search = () => {
    importReviews.reset();
    find.mutate(
      { days, sources },
      {
        onSuccess: (data) =>
          setSelected(new Set(data.candidates.filter((c) => !c.tracked).map((c) => c.number))),
      },
    );
  };
  const submit = () => {
    importReviews.mutate(
      { days, numbers: [...selected] },
      { onSuccess: () => find.reset() },
    );
  };
  const toggle = (n: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(n);
      else next.delete(n);
      return next;
    });

  return (
    <div
      className="border-t px-3 py-2 text-2xs"
      style={{ borderColor: "var(--border)" }}
      data-testid={`import-form-${rkey}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ color: "var(--fg-faint)" }}><UiText>last</UiText></span>
        <input
          type="number"
          min={1}
          max={90}
          className="input w-14 px-1.5 py-0.5 text-2xs"
          value={days}
          disabled={busy}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) setDays(Math.min(90, Math.max(1, Math.round(n))));
            find.reset();
          }}
        />
        <span style={{ color: "var(--fg-faint)" }}><UiText>days:</UiText></span>
        {(
          [
            ["requests", "review requests"],
            ["own", "your PRs"],
          ] as const
        ).map(([source, label]) => (
          <label key={source} className="flex items-center gap-1">
            <input
              type="checkbox"
              data-testid={`import-source-${source}`}
              checked={sources.includes(source)}
              disabled={busy}
              onChange={(e) => toggleSource(source, e.target.checked)}
            />
            <UiText>{label}</UiText>
          </label>
        ))}
        <button
          type="button"
          className="btn"
          data-testid="import-find"
          disabled={busy || !sources.length}
          onClick={search}
        >
          <UiText>{find.isPending ? "looking…" : "find PRs"}</UiText>
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          <UiText>{importReviews.data ? "close" : "cancel"}</UiText>
        </button>
        {find.error ? (
          <span style={{ color: "var(--risk)" }}>{errorText(find.error)}</span>
        ) : importReviews.error ? (
          <span style={{ color: "var(--risk)" }}>{errorText(importReviews.error)}</span>
        ) : importReviews.data ? (
          <span
            data-testid="import-result"
            style={{ color: importReviews.data.failed.length ? "var(--risk)" : "var(--fg-faint)" }}
          >
            <UiText>{formatImportResult(importReviews.data)}</UiText>
          </span>
        ) : null}
      </div>

      {candidates ? (
        candidates.length ? (
          <div className="mt-2">
            <ul className="flex flex-col" data-testid="import-candidates">
              {candidates.map((c) => (
                <ImportCandidateRow
                  key={c.number}
                  candidate={c}
                  checked={selected.has(c.number)}
                  disabled={busy}
                  onChange={(on) => toggle(c.number, on)}
                />
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="btn"
                data-testid="import-submit"
                disabled={busy || !selected.size}
                onClick={submit}
              >
                <UiText>{importReviews.isPending ? "importing…" : `import ${selected.size}`}</UiText>
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-2" style={{ color: "var(--fg-faint)" }} data-testid="import-none">
            <UiText>{`No open PRs found in the last ${days} day${days === 1 ? "" : "s"}.`}</UiText>
          </p>
        )
      ) : null}
    </div>
  );
}

/** The searches the import form starts with: the repo's watch settings, or review requests. */
function defaultImportSources(repo: RepoSummary | undefined): ImportSource[] {
  const out: ImportSource[] = [];
  if (repo?.watchReviews) out.push("requests");
  if (repo?.watchOwn) out.push("own");
  return out.length ? out : ["requests"];
}

function ImportCandidateRow({
  candidate: c,
  checked,
  disabled,
  onChange,
}: {
  candidate: ImportCandidate;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const onList = c.tracked && !c.archived;
  const why = c.sources.map((s) => (s === "requests" ? "wants your review" : "yours")).join(", ");
  return (
    <li>
      <label
        className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-[var(--bg-hover)]"
        style={{ opacity: onList ? 0.55 : 1 }}
        data-testid={`import-candidate-${c.number}`}
      >
        <input
          type="checkbox"
          checked={onList || checked}
          disabled={disabled || onList}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="flex-none tabular-nums" style={{ color: "var(--fg-faint)" }}>
          #{c.number}
        </span>
        <span className="min-w-0 truncate" style={{ color: "var(--fg)" }}>
          {c.title}
        </span>
        <span className="flex-none" style={{ color: "var(--fg-faint)" }}>
          {c.author ? `${c.author} · ` : ""}
          <UiText>{`${why}${onList ? " · already on the list" : c.archived ? " · archived, brings it back" : ""}`}</UiText>
        </span>
      </label>
    </li>
  );
}

const ARCHIVE_HINT = "local only, nothing changes on GitHub";
/** Archived rows shown per click of "show more". */
const ARCHIVED_PAGE = 10;

/** Shown while the pointer is on the row or focus is inside it; at phone width, where nothing hovers, left out. */
const HOVER_ONLY =
  "opacity-0 transition-opacity duration-150 ease-in-out group-focus-within:opacity-100 group-hover:opacity-100 max-sm:hidden";

/** The stack tree's lines: quieter than faint text. */
/** The room tag and archive take after the number (two 20px buttons, their
 *  6px margin), plus a gap; GitHub's side takes it as `pl-[52px]` the same
 *  way. Nothing shows there in selection mode. */
const ACTIONS_ROOM = "group-hover:pr-[52px] group-focus-within:pr-[52px]";
const ACTIONS_ROOM_LEFT = "group-hover:pl-[52px] group-focus-within:pl-[52px]";

const STACK_LINE_COLOR = "color-mix(in srgb, var(--fg-faint) 45%, transparent)";

/**
 * One PR, as two lines that each run the row's full width: the title line,
 * with the tag and archive buttons after the number on hover and GitHub's
 * side at its right end (new commits, a state other than open, the review
 * decision); and the meta line (who, the request waiting on you, the stack,
 * the size, CI when it is not passing, the reviewers, and on hover when it was
 * added and a passing CI) with the analysis at its right end. A title only
 * gives way to what shares its own line. Compact rows put it all on one
 * line: the title, the request, then GitHub's side and the analysis. At
 * phone width GitHub's side moves down beside the analysis. The row's left
 * edge holds its select box, shown on hover and throughout selection mode,
 * when the whole row is a checkbox and a click picks it.
 */
function PrRow({ row }: { row: ArrangedRow }) {
  const { pr, depth, joinsNext } = row;
  const selection = useContext(SelectionContext);
  const selecting = selection.keys.size > 0;
  const picked = selection.keys.has(pr.key);
  const { settings } = useSettings();
  const compact = settings.compactRows;
  const archived = pr.archived;
  const meta = pr.meta;
  const ciPassing = pr.ci?.state === "success";
  const title = (
    // While tag and archive show, what follows the number keeps clear of them:
    // the title gives way when the line is full, nothing moves when it is not.
    <div className={`flex min-w-0 items-baseline gap-2 ${compact ? `flex-auto ${selecting ? "" : ACTIONS_ROOM}` : ""}`}>
      <span className="truncate text-[13px] font-medium">
        {pr.title ?? meta?.title ?? pr.key}
      </span>
      <span
        className="relative flex-none text-2xs tabular-nums"
        style={{ color: "var(--fg-faint)" }}
      >
        #{meta?.number}
        {selecting ? null : <RowActions pr={pr} />}
      </span>
      {compact ? null : (
        <span className={`${SIDE_LINE} ml-auto self-center pl-4 max-sm:hidden ${selecting ? "" : ACTIONS_ROOM_LEFT}`}>
          <GithubSide pr={pr} />
        </span>
      )}
    </div>
  );

  return (
    <li
      className="group relative border-b transition-colors duration-150 ease-in-out last:border-b-0 hover:bg-[var(--bg-hover)]"
      style={{
        borderColor: "var(--border)",
        opacity: archived ? 0.55 : 1,
        ...(picked ? { background: "var(--accent-soft)" } : {}),
        paddingLeft: depth * STACK_INDENT,
        // A base and its stack read as one block: the tree joins them, no rule between.
        ...(joinsNext ? { borderBottomWidth: 0 } : {}),
      }}
      data-testid={`pr-row-${pr.key}`}
      data-pr-key={pr.key}
      data-depth={depth || undefined}
    >
      <SelectBox prKey={pr.key} checked={picked} selecting={selecting} compact={compact} />
      {depth > 0 ? (
        <TreeLines
          depth={depth}
          guides={row.guides}
          last={row.last}
          indent={STACK_INDENT}
          lineAt={STACK_LINE}
          elbowWidth={STACK_ELBOW_WIDTH}
          elbowY={compact ? STACK_ELBOW_Y_COMPACT : STACK_ELBOW_Y + STACK_RISE}
          color={STACK_LINE_COLOR}
          testId="stack-tree"
        />
      ) : null}
      {compact ? (
        <RowTarget pr={pr} className="flex min-w-0 items-center gap-3.5 py-[7px] pl-8 pr-8">
          {title}
          <span className="flex flex-none text-2xs leading-normal max-sm:hidden">
            <ReviewRequestWait request={pr.reviewRequest} state={pr.state} />
          </span>
          <span className={`${SIDE_LINE} flex-none sm:min-w-[168px]`}>
            <GithubSide pr={pr} />
            <AnalysisSide pr={pr} />
          </span>
        </RowTarget>
      ) : (
        <RowTarget pr={pr} className="flex min-w-0 flex-col gap-[5px] py-3 pl-8 pr-8">
          {title}
          <div
            className="flex min-h-4 flex-wrap items-center gap-x-3.5 gap-y-1 text-2xs leading-normal"
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
                className="inline-flex items-center gap-1"
                data-testid="pr-stacked-on"
                data-tip={`Targets #${meta.basePr.number}: ${meta.basePr.title}`}
              >
                <IconBranch width={11} height={11} />
                <UiText>{`on #${meta.basePr.number}`}</UiText>
              </span>
            ) : null}
            <ReviewRequestWait request={pr.reviewRequest} state={pr.state} />
            <DiffSizeStat size={pr.diffSize} files={false} quiet omitGenerated={settings.omitGeneratedLines} />
            {ciPassing ? null : <CiMark ci={pr.ci} />}
            {showsReviewers(pr.authoredByYou, pr.state) ? (
              <ReviewersMark reviewers={pr.reviewers} />
            ) : null}
            <span className={HOVER_ONLY} data-tip={formatFullTimestamp(pr.addedAt)}>
              <UiText>{`added ${formatAddedAt(pr.addedAt)}`}</UiText>
            </span>
            {ciPassing ? (
              <span className={`inline-flex ${HOVER_ONLY}`}>
                <CiMark ci={pr.ci} />
              </span>
            ) : null}
            <span className={`${SIDE_LINE} ml-auto pl-4 max-sm:ml-0 max-sm:w-full max-sm:justify-start max-sm:pl-0`}>
              <span className="contents sm:hidden">
                <GithubSide pr={pr} />
              </span>
              <AnalysisSide pr={pr} />
            </span>
          </div>
        </RowTarget>
      )}
    </li>
  );
}

/**
 * What a row's click lands on: the link to the PR, or in selection mode a
 * checkbox that picks it (Space too; shift picks the run from the last one).
 */
function RowTarget({ pr, className, children }: { pr: PrListEntry; className: string; children: ReactNode }) {
  const selection = useContext(SelectionContext);
  const picked = selection.keys.has(pr.key);
  if (!selection.keys.size) {
    return (
      <Link to={`/pr/${pr.key}`} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <div
      role="checkbox"
      aria-checked={picked}
      aria-label={`Select ${pr.title ?? pr.meta?.title ?? pr.key}`}
      tabIndex={0}
      className={`${className} cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]`}
      data-testid={`select-${pr.key}`}
      onClick={(e) => selection.toggle(pr.key, e.shiftKey)}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        selection.toggle(pr.key, e.shiftKey);
      }}
    >
      {children}
    </div>
  );
}

/**
 * A row's select box, in the column at the card's left edge whatever the
 * row's depth in a stack. At rest it shows on hover and starts selection
 * mode; in that mode it shows on every row and the row itself is the
 * checkbox, so the box is only something to click.
 */
function SelectBox({ prKey, checked, selecting, compact }: { prKey: string; checked: boolean; selecting: boolean; compact: boolean }) {
  const selection = useContext(SelectionContext);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label="Select"
      aria-hidden={selecting || undefined}
      tabIndex={selecting ? -1 : undefined}
      data-testid={`select-start-${prKey}`}
      data-tip={selecting ? undefined : "Select, to tag or archive several PRs at once"}
      className={`absolute left-2.5 z-[1] flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-[opacity,background-color,border-color] duration-150 ease-in-out max-sm:hidden ${
        selecting ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
      }`}
      style={{
        top: compact ? 9 : 15,
        borderColor: checked ? "var(--accent)" : "var(--fg-muted)",
        background: checked ? "var(--accent)" : "transparent",
        color: "var(--bg)",
      }}
      onClick={(e) => selection.toggle(prKey, e.shiftKey)}
    >
      {checked ? <IconCheck width={10} height={10} /> : null}
    </button>
  );
}

/**
 * Tag and archive, right after the number: hidden until the row is hovered or
 * one of them has focus, and taking no clicks while hidden, so the title line
 * stays a plain link. They float over what is to the right of the number
 * (on the row's hover tint) instead of holding room the title could use. They
 * sit inside the link, so a click must not travel.
 */
function RowActions({ pr }: { pr: PrListEntry }) {
  const openTag = useContext(TagContext);
  const tagButtonRef = useRef<HTMLButtonElement>(null);
  const setArchived = useContext(ArchiveContext)!;
  const archived = pr.archived;
  const tag = pr.meta?.tag;
  const button =
    "inline-flex h-5 w-5 items-center justify-center rounded-[5px] text-[var(--fg-muted)] hover:bg-[var(--bg-inset)] hover:text-[var(--fg)] disabled:opacity-50";
  return (
    <span
      className="pointer-events-none absolute left-full top-1/2 z-[1] ml-1.5 flex -translate-y-1/2 gap-px rounded-[5px] bg-[var(--bg-hover)] opacity-0 transition-opacity duration-150 ease-in-out focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
      data-testid="row-actions"
    >
      <button
        ref={tagButtonRef}
        type="button"
        className={button}
        data-testid={`tag-${pr.key}`}
        data-tip={tag ? `Tagged ${tag}; change it` : "Tag this PR"}
        aria-label={tag ? "Change the tag" : "Tag this PR"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (tagButtonRef.current) openTag({ pr, anchor: tagButtonRef.current });
        }}
      >
        <IconTag width={13} height={13} />
      </button>
      <button
        type="button"
        className={button}
        data-testid={`archive-${pr.key}`}
        disabled={setArchived.isPending}
        data-tip={`${archived ? "Unarchive" : "Archive"}; ${ARCHIVE_HINT}`}
        aria-label={archived ? "Unarchive" : "Archive"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setArchived.mutate({ key: pr.key, archived: !archived });
        }}
      >
        <IconArchive out={archived} width={13} height={13} />
      </button>
    </span>
  );
}

/** How far each level of a stack steps in, in px. */
const STACK_INDENT = 20;
/** Where a level's guide line sits inside its indent: just inside the base
 *  title's first letter, past the select box's column. */
const STACK_LINE = 34;
/** The elbow's reach into the row it joins. */
const STACK_ELBOW_WIDTH = 8;
/** The elbow meets the row at its title line, not the row's middle. */
const STACK_ELBOW_Y = 20;
/** The row above's bottom padding: the line starts right under its text. */
const STACK_RISE = 10;
/** A compact row is one line: the elbow meets its middle. */
const STACK_ELBOW_Y_COMPACT = 16;

/**
 * "new commits": GitHub holds commits this PR's stored revision does not.
 * Refreshes the PR from the row, without opening it; the list re-reads itself
 * after and the mark goes away on its own (the new revision's head is the one
 * upstream). The row is a link, so the click must not travel.
 */
function UpdateButton({ prKey }: { prKey: string }) {
  const refresh = useRefresh(prKey);
  const error = refresh.isError ? errorText(refresh.error) : null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:underline disabled:opacity-60"
      style={{ color: "var(--accent)" }}
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
        width={11}
        height={11}
        className={refresh.isPending ? "animate-spin" : undefined}
      />
      <UiText>new commits</UiText>
    </button>
  );
}

/** One of the row's right-hand groups: words and icons, right-aligned, never wrapping. */
const SIDE_LINE =
  "flex flex-none items-center justify-end gap-3 whitespace-nowrap text-2xs font-normal leading-normal text-[var(--fg-faint)]";

/** GitHub's side of a row: new commits, a state other than open, and the review decision once there is one. */
function GithubSide({ pr }: { pr: PrListEntry }) {
  const decision =
    pr.reviewDecision === "review_required" ? null : pr.reviewDecision;
  return (
    <>
      {pr.needsUpdate && (pr.state === "open" || pr.state === "draft") ? (
        <UpdateButton prKey={pr.key} />
      ) : null}
      <PrStateMark state={pr.state} />
      <ReviewDecisionMark decision={decision} />
    </>
  );
}

/**
 * The analysis side of a row: the job while one is queued, running or failed;
 * otherwise the effort mark, the units and how far you are through the hunks,
 * or "not analyzed".
 */
function AnalysisSide({ pr }: { pr: PrListEntry }) {
  const job = pr.analysisJob;
  if (job && (job.status === "queued" || job.status === "running" || job.status === "failed"))
    return <JobMark job={job} />;
  const units = pr.unitCount ?? 0;
  return (
    <>
      <EffortMark effort={pr.effort} />
      {units ? (
        <span
          className="inline-flex items-center gap-1 tabular-nums"
          data-tip={`${units} ${units === 1 ? "unit" : "units"}`}
          data-testid="unit-count"
        >
          <IconUnit width={12} height={12} />
          {units}
        </span>
      ) : null}
      {pr.totalHunks ? <ProgressRing viewed={pr.viewedHunks ?? 0} total={pr.totalHunks} quiet /> : null}
      {units ? null : <span data-testid="not-analyzed"><UiText>not analyzed</UiText></span>}
    </>
  );
}

/** An analysis job that is not done: its state alone, the detail in the tooltip. */
function JobMark({ job }: { job: NonNullable<PrListEntry["analysisJob"]> }) {
  const mark =
    job.status === "failed"
      ? { color: "var(--risk)", icon: <IconWarning width={11} height={11} />, word: "analysis failed", tip: job.error ?? "The analysis failed" }
      : job.status === "running"
        ? { color: undefined, icon: <IconSpinner width={11} height={11} />, word: "analyzing", tip: job.progress ?? "Analyzing this PR" }
        : { color: undefined, icon: <IconHourglass width={11} height={11} />, word: "queued", tip: job.progress ?? "Waiting for its turn to be analyzed" };
  return (
    <span
      className="inline-flex items-center gap-1"
      style={mark.color ? { color: mark.color } : undefined}
      data-tip={mark.tip}
      data-testid="analysis-chip"
      data-status={job.status}
    >
      {mark.icon}
      <UiText>{mark.word}</UiText>
    </span>
  );
}
