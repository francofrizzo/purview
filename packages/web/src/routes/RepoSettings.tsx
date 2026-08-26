/**
 * Per-repo settings. Everything here is server-persisted (nothing touches
 * localStorage): the local half lives beside the PR state on this machine, the
 * committed half lives in the target repo's `.purview/` folder and is shown
 * read-only, because the team maintains it through git.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { repoKey } from "../api/client";
import { errorText } from "../api/errors";
import { useRepoConfig, useSaveRepoConfig, useRepos } from "../api/hooks";
import type { RepoConfig } from "../api/types";
import { Markdown } from "../components/Markdown";
import { Modal, useCloseModal, useModalBackground } from "../components/Modal";
import { IconChevron, IconFile, IconSettings } from "../components/icons";

/** Long committed rubrics start collapsed; short ones are shown whole. */
const COLLAPSE_OVER_CHARS = 600;

/** Per-repo settings, floating over whatever route is underneath. */
export function RepoSettingsModal() {
  const params = useParams();
  const host = params.host ?? "";
  const owner = params.owner ?? "";
  const repo = params.repo ?? "";
  const rkey = repoKey({ host, owner, repo });

  const { data: config, isLoading, error } = useRepoConfig(rkey);
  const { data: repos } = useRepos();
  const summary = repos?.find((r) => repoKey(r) === rkey);

  const close = useCloseModal();
  const navigate = useNavigate();
  const background = useModalBackground();

  return (
    <Modal
      testId="repo-settings-modal"
      icon={<IconSettings width={14} height={14} className="flex-none" />}
      title={`${owner}/${repo}`}
      subtitle="Repo settings. Stored by the server, shared by every PR in this repo."
      onClose={close}
      actions={
        <button
          type="button"
          className="btn"
          data-testid="open-app-settings"
          // Same backdrop, replacing this entry so closing lands where the
          // user came from rather than back on the repo settings modal.
          onClick={() => navigate("/settings", { state: { background }, replace: true })}
        >
          app settings
        </button>
      }
    >
      {isLoading ? (
        <p className="surface rounded-md p-4 text-xs" style={{ color: "var(--fg-faint)" }}>
          Loading repo settings…
        </p>
      ) : error || !config ? (
        <p className="surface rounded-md p-4 text-xs" style={{ color: "var(--risk)" }}>
          {error ? errorText(error) : "This repo is not tracked locally."}
        </p>
      ) : (
        <RepoSettingsBody
          rkey={rkey}
          host={host}
          owner={owner}
          repo={repo}
          config={config}
          prCount={summary?.prCount}
          archivedCount={summary?.archivedCount}
        />
      )}
    </Modal>
  );
}

function RepoSettingsBody({
  rkey,
  host,
  owner,
  repo,
  config,
  prCount,
  archivedCount,
}: {
  rkey: string;
  host: string;
  owner: string;
  repo: string;
  config: RepoConfig;
  prCount?: number;
  archivedCount?: number;
}) {
  const save = useSaveRepoConfig(rkey);

  return (
    <>
      <Section title="Overview">
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          <Stat label="Repository">
            <span className="font-mono text-xs">
              {owner}/{repo}
            </span>
            {host !== "github.com" ? (
              <span className="ml-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                on {host}
              </span>
            ) : null}
          </Stat>
          <Stat label="Tracked PRs">
            <span className="text-xs tabular-nums">{prCount ?? "—"}</span>
            {archivedCount ? (
              <span className="ml-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
                + {archivedCount} archived
              </span>
            ) : null}
          </Stat>
          <Stat label="Team config">
            {config.committed.present ? (
              <span
                className="chip"
                style={{ color: "var(--ok)", background: "var(--ok-soft)" }}
                title="A .purview/ folder is committed in this repo"
              >
                team config present in repo
              </span>
            ) : (
              <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
                no <span className="font-mono">.purview/</span> folder committed
              </span>
            )}
          </Stat>
        </dl>
      </Section>

      <AnalysisSection config={config} save={save} />
      <CheckoutSection config={config} save={save} />
      <RubricSection config={config} save={save} />

      <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
        Saved on the server under <span className="font-mono">{rkey}</span>. The committed half is
        read-only here — edit it in the repo and commit.
      </p>
    </>
  );
}

/* --------------------------------------------------------------- analysis */

type Save = ReturnType<typeof useSaveRepoConfig>;

const AUTO_ANALYZE_OPTIONS = [
  { value: "inherit", label: "inherit default" },
  { value: "on", label: "on" },
  { value: "off", label: "off" },
];

const toOption = (v: boolean | null) => (v === null ? "inherit" : v ? "on" : "off");
const fromOption = (v: string): boolean | null => (v === "inherit" ? null : v === "on");

function AnalysisSection({ config, save }: { config: RepoConfig; save: Save }) {
  const [flash, setFlash] = useFlash();
  const local = config.local.autoAnalyze;
  const committedAuto = (config.committed.config as { autoAnalyze?: boolean } | null)?.autoAnalyze;

  const source =
    local !== null
      ? "this repo's local setting"
      : committedAuto !== undefined
        ? "the committed team config"
        : "the built-in default";

  return (
    <Section
      title="Analysis"
      hint="Whether a new revision is analyzed automatically as soon as it is fetched."
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Auto-analyze">
          <Segmented
            value={toOption(local)}
            options={AUTO_ANALYZE_OPTIONS}
            disabled={save.isPending}
            onChange={(v) =>
              save.mutate({ autoAnalyze: fromOption(v) }, { onSuccess: () => setFlash() })
            }
          />
        </Field>
        <p className="pb-1 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
          Effective:{" "}
          <span style={{ color: config.effective.autoAnalyze ? "var(--ok)" : "var(--fg-muted)" }}>
            {config.effective.autoAnalyze ? "on" : "off"}
          </span>{" "}
          — from {source}.
        </p>
        <SavedFlash shown={flash} error={save.error} />
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------- checkout */

function CheckoutSection({ config, save }: { config: RepoConfig; save: Save }) {
  const [flash, setFlash] = useFlash();
  const [path, setPath] = useState(config.local.repoPath ?? "");

  useEffect(() => {
    setPath(config.local.repoPath ?? "");
  }, [config.local.repoPath]);

  const dirty = path.trim() !== (config.local.repoPath ?? "");
  const commit = () => {
    if (!dirty) return;
    save.mutate({ repoPath: path.trim() || null }, { onSuccess: () => setFlash() });
  };

  return (
    <Section
      title="Local checkout"
      hint="Claude reads the working tree here to answer questions about code the diff only touches partially, and analysis uses it for context."
    >
      <div className="flex items-center gap-2">
        <IconFile width={12} height={12} />
        <input
          className="input font-mono text-xs"
          data-testid="repo-path"
          placeholder="/Users/you/code/repo"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <button
          type="button"
          className="btn flex-none"
          data-testid="repo-path-save"
          disabled={!dirty || save.isPending}
          onClick={commit}
        >
          {save.isPending ? "saving…" : "save"}
        </button>
        <SavedFlash shown={flash} error={save.error} />
      </div>
      <p className="mt-2 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
        A git worktree works too — point this at the worktree for the branch under review and the
        checkout stays on whatever you had open elsewhere. A relative path is resolved against the
        server's working directory.
      </p>
    </Section>
  );
}

/* ----------------------------------------------------------------- rubric */

function RubricSection({ config, save }: { config: RepoConfig; save: Save }) {
  const [flash, setFlash] = useFlash();
  const [rubric, setRubric] = useState(config.local.rubric ?? "");
  const committed = config.committed.rubric ?? "";
  const [expanded, setExpanded] = useState(committed.length <= COLLAPSE_OVER_CHARS);

  useEffect(() => {
    setRubric(config.local.rubric ?? "");
  }, [config.local.rubric]);

  const dirty = rubric !== (config.local.rubric ?? "");

  return (
    <Section
      title="Rubric"
      hint="What the analysis should treat as must-read, skim or skip in this repo. Layering: the local overlay refines the committed team rubric, which refines the built-in one."
    >
      <div className="flex flex-col gap-4">
        <div>
          <PaneLabel>
            team rubric (committed)
            {committed ? (
              <span className="ml-1.5 font-normal" style={{ color: "var(--fg-faint)" }}>
                read-only · <span className="font-mono">.purview/rubric.md</span>
              </span>
            ) : null}
          </PaneLabel>
          {committed ? (
            <div
              className="mt-1 rounded"
              style={{ border: "1px solid var(--border)", background: "var(--bg-inset)" }}
            >
              <button
                type="button"
                data-testid="committed-rubric-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-2xs transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--fg-faint)" }}
              >
                <IconChevron open={expanded} width={10} height={10} />
                {expanded ? "hide" : "show"} — {committed.split("\n").length} lines
              </button>
              {expanded ? (
                <div
                  className="max-h-80 overflow-y-auto px-2.5 pb-2.5"
                  data-testid="committed-rubric"
                >
                  <Markdown text={committed} />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
              No committed rubric. Add <span className="font-mono">.purview/rubric.md</span> to the
              repo and everyone on the team picks it up.
            </p>
          )}
        </div>

        <div>
          <PaneLabel>local rubric overlay</PaneLabel>
          <Autosize
            value={rubric}
            rows={12}
            onChange={setRubric}
            placeholder={"Anything under src/billing/ is must-read.\nGenerated clients are skip."}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              className="btn"
              data-testid="rubric-save"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate({ rubric }, { onSuccess: () => setFlash() })}
            >
              {save.isPending ? "saving…" : "save rubric"}
            </button>
            <SavedFlash shown={flash} error={save.error} />
          </div>
        </div>
      </div>
    </Section>
  );
}

/** Grows with its content, from `rows` lines up to a scrolling ceiling. */
function Autosize({
  value,
  rows,
  onChange,
  placeholder,
}: {
  value: string;
  rows: number;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = 18;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, rows * line), 40 * line)}px`;
  }, [value, rows]);

  return (
    <textarea
      ref={ref}
      className="input mt-1 resize-none font-mono text-xs leading-[18px]"
      data-testid="rubric-textarea"
      spellCheck={false}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* ------------------------------------------------------- small shared bits */

/** A "saved ✓" that shows for a beat and then fades out on its own. */
function useFlash(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    shown,
    () => {
      setShown(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), 1800);
    },
  ];
}

function SavedFlash({ shown, error }: { shown: boolean; error: unknown }) {
  if (error) {
    return (
      <span className="text-2xs" style={{ color: "var(--risk)" }} role="alert">
        {errorText(error)}
      </span>
    );
  }
  if (!shown) return null;
  return (
    <span className="text-2xs" style={{ color: "var(--ok)" }} data-testid="saved-flash">
      saved ✓
    </span>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface mb-4 rounded-md p-4">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {hint ? (
        <p className="mb-3 mt-0.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
          {hint}
        </p>
      ) : (
        <div className="mb-3" />
      )}
      {children}
    </section>
  );
}

function PaneLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xs font-medium uppercase tracking-wider" style={{ color: "var(--fg-muted)" }}>
      {children}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
        {label}
      </dt>
      <dd className="flex items-baseline">{children}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex flex-none items-center rounded p-px"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-testid={`opt-${o.value}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className="rounded-sm px-2 py-0.5 text-2xs font-medium transition-colors"
            style={{
              background: active ? "var(--bg-raised)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-faint)",
              boxShadow: active ? "0 0 0 1px var(--border-strong)" : undefined,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
