import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorText } from "../api/errors";
import { useRemoveRepo, useRepoRemoval, useSetRepoArchived } from "../api/hooks";
import {
  removalBlockedWhy,
  removalConfirmMatches,
  removalConfirmName,
  removalLossLines,
} from "../lib/repoRemoval";
import { useModalBackground } from "./Modal";
import { OverflowMenu } from "./TopBar";

/**
 * Repo-level archive and removal: the ⋯ menu on a PR-list repo header, and
 * the plain "archive or remove" section at the bottom of the repo settings.
 * Both are local-only — nothing on GitHub changes either way.
 */

export const REPO_ARCHIVE_HINT =
  "Moves the repo to Archived repos and stops automatic analyses and watch imports for it. Every PR keeps its own archived state, so unarchiving restores it exactly. Nothing changes on GitHub.";

export const REPO_UNARCHIVE_HINT =
  "Back in the list; each PR returns to the state it had before, and new revisions are analyzed automatically again.";

interface RepoRef {
  host: string;
  owner: string;
  repo: string;
}

const rkeyOf = (r: RepoRef) => `${r.host}/${r.owner}/${r.repo}`;
const settingsPath = (r: RepoRef) => `/repo/${r.host}/${r.owner}/${r.repo}/settings`;

/**
 * The repo header's ⋯. "Remove from Purview…" does not act here: it opens the
 * repo settings with the removal confirm already expanded, where the reader
 * sees what goes and types the repo's name.
 */
export function RepoMenu({ repo, archived }: { repo: RepoRef; archived: boolean }) {
  const setRepoArchived = useSetRepoArchived();
  const navigate = useNavigate();
  const background = useModalBackground();
  const rkey = rkeyOf(repo);

  return (
    <OverflowMenu
      fixed
      testId={`repo-menu-${rkey}`}
      label={`Actions for ${repo.owner}/${repo.repo}`}
      buttonClassName="flex-none rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
      buttonStyle={{ color: "var(--fg-faint)" }}
      items={[
        {
          label: archived ? "unarchive repo" : "archive repo",
          testId: `repo-archive-${rkey}`,
          disabled: setRepoArchived.isPending,
          hint: archived ? REPO_UNARCHIVE_HINT : REPO_ARCHIVE_HINT,
          onClick: () => setRepoArchived.mutate({ rkey, archived: !archived }),
        },
        {
          label: "remove from Purview…",
          testId: `repo-remove-${rkey}`,
          hint: "Delete all local state for this repo. Asks for confirmation first.",
          onClick: () =>
            navigate(settingsPath(repo), { state: { background, confirmRemove: true } }),
        },
      ]}
    />
  );
}

/**
 * The last section of the repo settings: archive/unarchive, and the removal
 * flow. Removal is two steps — "remove from Purview…" opens the confirm, which
 * shows what would be lost and only enables the final button once the repo's
 * name is typed — with "archive instead" offered as the reversible option.
 */
export function RepoDangerZone({
  repo,
  archived,
  watchReviews,
  startConfirming = false,
}: {
  repo: RepoRef;
  archived: boolean;
  /** the repo's review watch is on (its settings go with it) */
  watchReviews: boolean;
  /** open with the removal confirm expanded (arrived from the list's menu) */
  startConfirming?: boolean;
}) {
  const rkey = rkeyOf(repo);
  const setRepoArchived = useSetRepoArchived();
  const [confirming, setConfirming] = useState(startConfirming);
  const [typed, setTyped] = useState("");
  const removal = useRepoRemoval(rkey, confirming);
  const remove = useRemoveRepo(rkey);
  const navigate = useNavigate();
  const sectionRef = useRef<HTMLElement>(null);

  // Arriving from the list's "remove from Purview…": bring the confirm into view.
  useEffect(() => {
    if (startConfirming) sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [startConfirming]);

  const stopConfirming = () => {
    setConfirming(false);
    setTyped("");
    remove.reset();
  };

  const name = removalConfirmName(repo);
  const blockedWhy = removal.data ? removalBlockedWhy(removal.data) : null;
  const canRemove =
    !!removal.data && !blockedWhy && removalConfirmMatches(typed, repo) && !remove.isPending;
  // Whatever route sat under the settings modal may belong to this repo, so
  // land on the list rather than go back to it.
  const doRemove = () =>
    remove.mutate(undefined, { onSuccess: () => navigate("/", { replace: true }) });

  const archiveButton = (label: string, testId: string) => (
    <button
      type="button"
      className="btn"
      data-testid={testId}
      disabled={setRepoArchived.isPending}
      title={archived ? REPO_UNARCHIVE_HINT : REPO_ARCHIVE_HINT}
      onClick={() => {
        setRepoArchived.mutate({ rkey, archived: !archived });
        stopConfirming();
      }}
    >
      {setRepoArchived.isPending ? (archived ? "unarchiving…" : "archiving…") : label}
    </button>
  );

  return (
    <section ref={sectionRef} className="surface mb-4 rounded-md p-4" data-testid="repo-danger-zone">
      <h2 className="text-[13px] font-semibold">Archive or remove</h2>
      <p className="mb-3 mt-0.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
        Both are local to this machine. Nothing on GitHub changes either way.
      </p>

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs">{archived ? "This repo is archived" : "Archive this repo"}</div>
          <p className="mt-0.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
            {archived ? REPO_UNARCHIVE_HINT : REPO_ARCHIVE_HINT}
          </p>
        </div>
        {archiveButton(archived ? "unarchive repo" : "archive repo", "repo-archive-toggle")}
      </div>
      {setRepoArchived.error ? (
        <p className="mt-1.5 text-2xs" role="alert" style={{ color: "var(--risk)" }}>
          {errorText(setRepoArchived.error)}
        </p>
      ) : null}

      <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs">Remove from Purview</div>
            <p className="mt-0.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
              Deletes everything Purview keeps locally for this repo. It cannot be undone.
            </p>
          </div>
          {!confirming ? (
            <button
              type="button"
              className="btn"
              data-testid="repo-remove-start"
              onClick={() => setConfirming(true)}
            >
              remove from Purview…
            </button>
          ) : null}
        </div>

        {confirming ? (
          <div
            className="mt-3 rounded p-3"
            data-testid="repo-remove-confirm"
            style={{ border: "1px solid var(--border)", background: "var(--bg-inset)" }}
          >
            {removal.isLoading ? (
              <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
                Counting what would be removed…
              </p>
            ) : removal.error ? (
              <p className="text-2xs" role="alert" style={{ color: "var(--risk)" }}>
                {errorText(removal.error)}
              </p>
            ) : removal.data ? (
              <>
                <p className="text-xs" style={{ color: "var(--fg)" }}>
                  This removes:
                </p>
                <ul
                  className="mt-1 list-disc pl-4 text-2xs leading-5"
                  data-testid="repo-remove-losses"
                  style={{ color: "var(--fg-muted)" }}
                >
                  {removalLossLines(removal.data).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p className="mt-2 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
                  Your own clones are not touched.{" "}
                  {watchReviews
                    ? "Its review watch goes with its settings, so nothing re-imports it on its own; adding one of its PRs again starts it over from scratch."
                    : "Adding one of its PRs again starts it over from scratch."}{" "}
                  To stop it without losing anything, archive it instead.
                </p>
              </>
            ) : null}

            <label className="mt-3 block text-2xs" style={{ color: "var(--fg-muted)" }}>
              Type <span className="font-mono">{name}</span> to confirm
              <input
                className="input mt-1 font-mono text-xs"
                data-testid="repo-remove-name"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                disabled={remove.isPending}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canRemove) doRemove();
                }}
              />
            </label>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn"
                data-testid="repo-remove-confirm-button"
                disabled={!canRemove}
                title={blockedWhy ?? undefined}
                style={canRemove ? { color: "var(--risk)", borderColor: "var(--risk)" } : undefined}
                onClick={doRemove}
              >
                {remove.isPending ? "removing…" : `remove ${name}`}
              </button>
              {!archived ? archiveButton("archive instead", "repo-remove-archive-instead") : null}
              <button
                type="button"
                className="btn"
                disabled={remove.isPending}
                onClick={stopConfirming}
              >
                cancel
              </button>
            </div>
            {blockedWhy ? (
              <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                {blockedWhy}
              </p>
            ) : null}
            {remove.error ? (
              <p className="mt-1.5 text-2xs leading-4" role="alert" style={{ color: "var(--risk)" }}>
                {errorText(remove.error)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
