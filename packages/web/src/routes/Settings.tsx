import { useEffect, useMemo, useState } from "react";
import { errorText } from "../api/errors";
import {
  useAgents,
  useGlobalConfig,
  useLanAccess,
  useRegenerateLanToken,
  useSaveGlobalConfig,
} from "../api/hooks";
import type { AgentSelection, AgentsInfo, ResolvedAgent } from "../api/types";
import {
  editSelection,
  effortOptions,
  harnessOptions,
  inheritedHarness,
  manifestOf,
  modelLabel,
  modelOptions,
  offersHarnessChoice,
} from "../lib/agentSelection";
import { AttentionChip, ChangedBadge, KindChip, Progress } from "../components/Chips";
import { Modal, useCloseModal } from "../components/Modal";
import { IconSettings } from "../components/icons";
import { tokenizeLines, type Tok } from "../lib/highlight";
import {
  CURATED_MONO_FONTS,
  UNSUPPORTED_MESSAGE,
  filterFamilies,
  localFontsSupported,
  queryLocalFontFamilies,
  type LocalFontResult,
} from "../lib/localFonts";
import {
  MAX_CODE_FONT_SIZE,
  MAX_REQUEST_AGE_DAYS,
  MIN_CODE_FONT_SIZE,
  TAB_SIZES,
  useSettings,
  type RequestAgeDays,
  type Settings as SettingsShape,
} from "../lib/settings";
import { parseLoginList } from "../lib/threads";
import { MONOKAI_PRO_NOTE, THEMES, previewColors, shikiThemeFor } from "../lib/themes";

/** App-wide appearance settings, floating over whatever route is underneath. */
export function SettingsModal() {
  const { settings, appearance, update, reset } = useSettings();
  const close = useCloseModal();

  return (
    <Modal
      testId="settings-modal"
      icon={<IconSettings width={14} height={14} />}
      title="Settings"
      subtitle="Appearance is stored in this browser; the agent defaults are stored on the server. Every change applies immediately."
      onClose={close}
      actions={
        <button type="button" className="btn" onClick={reset}>
          reset to defaults
        </button>
      }
    >
      <Section
        title="Typography"
        hint="Applies to the diff and every other code surface. The UI font follows it only if you ask it to."
      >
        <FontSection settings={settings} update={update} />
      </Section>

      <Section title="Theme" hint={MONOKAI_PRO_NOTE}>
        <ThemeSection themeId={settings.themeId} update={update} />
        <ThemePreview />
      </Section>

      <AgentsSection />

      <ReviewThreadsSection settings={settings} update={update} />

      <NetworkSection />

      <Section title="Diff defaults" hint="The same preferences the d / w keys toggle while reviewing.">
        <div className="flex flex-wrap items-center gap-6">
          <Field label="Layout">
            <Segmented
              value={settings.diffViewMode}
              options={[
                { value: "unified", label: "unified" },
                { value: "split", label: "side-by-side" },
              ]}
              onChange={(v) => update({ diffViewMode: v as SettingsShape["diffViewMode"] })}
            />
          </Field>
          <Field label="Long lines">
            <Segmented
              value={settings.diffWrap ? "wrap" : "scroll"}
              options={[
                { value: "wrap", label: "wrap" },
                { value: "scroll", label: "scroll" },
              ]}
              onChange={(v) => update({ diffWrap: v === "wrap" })}
            />
          </Field>
          <Field label="Viewed hunks">
            <Segmented
              value={settings.autoCollapseViewedHunks ? "fold" : "keep"}
              options={[
                { value: "fold", label: "fold shut" },
                { value: "keep", label: "leave open" },
              ]}
              onChange={(v) => update({ autoCollapseViewedHunks: v === "fold" })}
            />
          </Field>
        </div>
        <p className="mt-2 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
          Folding a viewed hunk clears it out of the way; un-viewing brings it back. You can always
          fold or unfold a hunk by hand from its <span className="font-mono">@@</span> header, and
          that choice sticks until its viewed state next changes.
        </p>
      </Section>

      <Section
        title="PR list"
        hint={`How long a review request may wait before "asked you 3d ago" changes color.`}
      >
        <RequestAgeFields days={settings.requestAgeDays} update={update} />
      </Section>

      <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
        Stored under <span className="font-mono">reviewer.settings</span> in localStorage · active
        theme <span className="font-mono">{appearance.theme.id}</span>
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// typography
// ---------------------------------------------------------------------------

function FontSection({
  settings,
  update,
}: {
  settings: SettingsShape;
  update: (patch: Partial<SettingsShape>) => void;
}) {
  const [result, setResult] = useState<LocalFontResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const supported = localFontsSupported();

  const shown = useMemo(
    () => (result?.families.length ? filterFamilies(result.families, query) : []),
    [result, query],
  );

  const pick = async () => {
    setLoading(true);
    const r = await queryLocalFontFamilies();
    setResult(r);
    setLoading(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Code font family">
          <input
            className="input font-mono text-xs"
            style={{ width: "18rem", fontFamily: "var(--font-code)" }}
            placeholder="default monospace stack"
            value={settings.codeFont}
            onChange={(e) => update({ codeFont: e.target.value })}
          />
        </Field>
        <Field label={`Size — ${settings.codeFontSize}px`}>
          <input
            type="range"
            min={MIN_CODE_FONT_SIZE}
            max={MAX_CODE_FONT_SIZE}
            step={1}
            value={settings.codeFontSize}
            onChange={(e) => update({ codeFontSize: Number(e.target.value) })}
            style={{ width: "10rem", accentColor: "var(--accent)" }}
          />
        </Field>
        <Field label="Tab width">
          <Segmented
            value={String(settings.tabSize)}
            options={TAB_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => update({ tabSize: Number(v) as SettingsShape["tabSize"] })}
          />
        </Field>
      </div>

      <label className="flex w-fit items-center gap-2 text-xs" style={{ color: "var(--fg-muted)" }}>
        <input
          type="checkbox"
          checked={settings.useCodeFontForUi}
          onChange={(e) => update({ useCodeFontForUi: e.target.checked })}
          style={{ accentColor: "var(--accent)" }}
        />
        Use the same font for the UI
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={pick} disabled={loading}>
          {loading ? "waiting for permission…" : "Choose from installed fonts…"}
        </button>
        {settings.codeFont ? (
          <button type="button" className="btn" onClick={() => update({ codeFont: "" })}>
            use default stack
          </button>
        ) : null}
        {!supported ? (
          <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            {UNSUPPORTED_MESSAGE}
          </span>
        ) : null}
      </div>

      {result && result.status !== "ok" ? (
        <p
          className="rounded px-2.5 py-1.5 text-2xs leading-4"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          {result.message}
        </p>
      ) : null}

      {result?.status === "ok" ? (
        <div className="flex flex-col gap-2">
          <input
            className="input text-xs"
            placeholder={`Filter ${result.families.length} families…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div
            className="max-h-56 overflow-y-auto rounded"
            style={{ border: "1px solid var(--border)", background: "var(--bg-inset)" }}
          >
            {shown.map((family) => (
              <button
                key={family}
                type="button"
                onClick={() => update({ codeFont: family })}
                className="flex w-full items-baseline gap-3 px-2.5 py-1 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  color: settings.codeFont === family ? "var(--accent)" : "var(--fg)",
                  background:
                    settings.codeFont === family ? "var(--accent-soft)" : undefined,
                }}
              >
                {/* each name rendered in its own family */}
                <span style={{ fontFamily: `"${family}"` }}>{family}</span>
                <span className="ml-auto text-2xs" style={{ fontFamily: `"${family}"`, color: "var(--fg-faint)" }}>
                  const x = 42;
                </span>
              </button>
            ))}
            {!shown.length ? (
              <p className="px-2.5 py-2 text-2xs" style={{ color: "var(--fg-faint)" }}>
                No family matches “{query}”.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
          Common monospace families
        </span>
        <div className="flex flex-wrap gap-1.5">
          {CURATED_MONO_FONTS.map((family) => {
            const active = settings.codeFont === family;
            return (
              <button
                key={family}
                type="button"
                onClick={() => update({ codeFont: family })}
                className="rounded px-2 py-1 text-2xs transition-colors"
                style={{
                  fontFamily: `"${family}", monospace`,
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active ? "var(--accent-soft)" : "var(--bg-raised)",
                  color: active ? "var(--accent)" : "var(--fg-muted)",
                }}
              >
                {family}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------

const THEME_GROUPS = ["Reviewer", "Editor themes", "Monokai"];

function ThemeSection({
  themeId,
  update,
}: {
  themeId: string;
  update: (patch: Partial<SettingsShape>) => void;
}) {
  const groups = THEME_GROUPS.map((group) => ({
    group,
    themes: THEMES.filter((t) => t.group === group),
  }));

  return (
    <div className="flex flex-col gap-3">
      <div>
        <GroupLabel>System</GroupLabel>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          <ThemeCard
            active={themeId === "system"}
            label="Follow system"
            sub="dark / light"
            colors={["#0c0d10", "#fbfbfc", "#7aa2f7", "#4ec27f", "#f0787a", "#c4a7ff"]}
            onClick={() => update({ themeId: "system" })}
          />
        </div>
      </div>
      {groups.map(({ group, themes }) => (
        <div key={group}>
          <GroupLabel>{group}</GroupLabel>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {themes.map((t) => (
              <ThemeCard
                key={t.id}
                active={themeId === t.id}
                label={t.label}
                sub={t.mode}
                colors={previewColors(t)}
                onClick={() => update({ themeId: t.id })}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
      {children}
    </span>
  );
}

function ThemeCard({
  active,
  label,
  sub,
  colors,
  onClick,
}: {
  active: boolean;
  label: string;
  sub: string;
  colors: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`theme-${label}`}
      onClick={onClick}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors"
      style={{
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--accent-soft)" : "var(--bg-raised)",
      }}
    >
      <span
        className="flex h-6 w-6 flex-none flex-wrap overflow-hidden rounded"
        style={{ border: "1px solid var(--border)" }}
      >
        {colors.slice(0, 6).map((c, i) => (
          <span key={i} style={{ background: c, width: "50%", height: "33.333%" }} />
        ))}
      </span>
      <span className="min-w-0">
        <span
          className="block truncate text-2xs font-medium"
          style={{ color: active ? "var(--accent)" : "var(--fg)" }}
        >
          {label}
        </span>
        <span className="block text-2xs" style={{ color: "var(--fg-faint)" }}>
          {sub}
        </span>
      </span>
    </button>
  );
}

const PREVIEW_LINES: { type: "add" | "del" | "ctx"; text: string }[] = [
  { type: "ctx", text: "export function riskFor(unit: ReviewUnit): number {" },
  { type: "del", text: '  const weight = unit.attention === "skim" ? 1 : 2; // old' },
  { type: "add", text: '  const weight = unit.attention === "must-read" ? 3 : 1;' },
  { type: "ctx", text: "  return weight * unit.riskFlags.length;" },
  { type: "ctx", text: "}" },
];

/** Live sample: chrome tokens, syntax colors and diff tints in one place. */
function ThemePreview() {
  const { appearance } = useSettings();
  const shiki = shikiThemeFor(appearance.theme);
  const [tokens, setTokens] = useState<Tok[][] | null>(null);

  useEffect(() => {
    let alive = true;
    const code = PREVIEW_LINES.map((l) => l.text).join("\n");
    void tokenizeLines("settings-preview", code, "typescript", shiki).then((t) => {
      if (alive) setTokens(t);
    });
    return () => {
      alive = false;
    };
  }, [shiki]);

  return (
    // Sticky: the theme grid is taller than the modal, and the point of the
    // grid is watching this card change.
    <div
      className="sticky bottom-0 mt-4 overflow-hidden rounded"
      style={{ border: "1px solid var(--border)", background: "var(--bg-raised)" }}
    >
      <div
        className="flex items-center gap-2 border-b px-2.5 py-1.5"
        style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
      >
        <span className="text-2xs" style={{ color: "var(--fg-muted)" }}>
          preview
        </span>
        <KindChip kind="core-logic" />
        <AttentionChip attention="must-read" />
        <ChangedBadge />
        <span className="ml-auto">
          <Progress viewed={3} total={5} />
        </span>
      </div>
      <div style={{ background: "var(--bg)" }}>
        {PREVIEW_LINES.map((line, i) => (
          <div
            key={i}
            className="diff-line"
            data-type={line.type === "ctx" ? "ctx" : line.type}
            style={{
              background:
                line.type === "add"
                  ? "var(--add-bg)"
                  : line.type === "del"
                    ? "var(--del-bg)"
                    : "transparent",
            }}
          >
            <span className="diff-gutter">{i + 1}</span>
            <span
              className="diff-marker"
              style={{
                color:
                  line.type === "add"
                    ? "var(--ok)"
                    : line.type === "del"
                      ? "var(--risk)"
                      : "var(--fg-faint)",
              }}
            >
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            <span className="diff-code min-w-0 flex-1 pr-4">
              {tokens?.[i]
                ? tokens[i].map((t, j) => (
                    <span key={j} style={t.color ? { color: t.color } : undefined}>
                      {t.content}
                    </span>
                  ))
                : line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Reaching this Purview from another device on the same network. Nothing here
 * switches it on — that is the `--lan` flag on the command that started the
 * server, because it decides what the server binds to. This section only shows
 * what the running process is doing, and what the token behind it is worth.
 */
function NetworkSection() {
  const lan = useLanAccess();
  const regenerate = useRegenerateLanToken();
  const data = lan.data;

  return (
    <Section
      title="Network access"
      hint="Read a PR from the couch: your iPad or phone on the same network can open this Purview, with a QR code to get it onto the device."
    >
      {lan.isLoading ? (
        <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
          Loading…
        </p>
      ) : lan.error || !data ? (
        <p className="text-2xs" style={{ color: "var(--risk)" }}>
          {errorText(lan.error) ||
            "Could not read the network settings. They are only available on the machine Purview runs on."}
        </p>
      ) : !data.active || !data.url ? (
        <p className="text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
          Off for this run. Start Purview with <span className="font-mono">--lan</span> —{" "}
          <span className="font-mono">pnpm start --lan</span> from a checkout, or{" "}
          <span className="font-mono">purview --lan</span> — and the QR code to scan appears both
          here and in the startup log. Only do it on a network you trust: the access token it
          hands out is the only thing between that network and a Purview that can run agents on
          your account and post to GitHub as you.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start gap-4">
            {data.qrSvg ? (
              <span
                className="flex h-36 w-36 flex-none items-center justify-center rounded bg-white p-1.5"
                style={{ border: "1px solid var(--border)" }}
                // The SVG comes from our own server's QR renderer.
                dangerouslySetInnerHTML={{ __html: data.qrSvg }}
              />
            ) : null}
            <div className="flex min-w-0 flex-col gap-2">
              <span
                className="text-2xs uppercase tracking-wider"
                style={{ color: "var(--fg-faint)" }}
              >
                Scan, or open this address
              </span>
              <code
                className="break-all rounded px-2 py-1 font-mono text-2xs"
                style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
              >
                {data.url}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn"
                  disabled={regenerate.isPending}
                  onClick={() => regenerate.mutate()}
                >
                  {regenerate.isPending ? "regenerating…" : "Regenerate token"}
                </button>
                <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
                  Takes effect at once: every device that scanned an older code loses access and
                  has to scan again.
                </span>
              </div>
            </div>
          </div>

          <p className="text-2xs leading-4" style={{ color: "var(--risk)" }}>
            {data.warning} Only stay on a network you trust.
          </p>

          {regenerate.error ? (
            <p className="text-2xs" style={{ color: "var(--risk)" }}>
              {errorText(regenerate.error)}
            </p>
          ) : null}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// small shared bits
// ---------------------------------------------------------------------------

/**
 * The machine-wide half of the agent layering: what every repo inherits when
 * it, and the team's committed config, say nothing. "inherit" here is the end
 * of the chain — it means the harness's own defaults, from its manifest.
 */
function AgentsSection() {
  const config = useGlobalConfig();
  const save = useSaveGlobalConfig();
  const agents = useAgents();

  return (
    <Section
      title="Agents"
      hint="Which agent and model analysis runs and review chats use, for every repo that does not override it. Runs go through the agent's own CLI on this machine, so this is what they cost you."
    >
      {config.isLoading || agents.isLoading ? (
        <p className="text-2xs" style={{ color: "var(--fg-faint)" }}>
          Loading…
        </p>
      ) : config.error || !config.data ? (
        <p className="text-2xs" style={{ color: "var(--risk)" }}>
          {errorText(config.error) || "Could not read the server's settings."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-6">
            <GlobalAgentFields
              kind="analysis"
              agents={agents.data}
              layer={config.data.analysisAgent}
              resolved={config.data.effective.analysisAgent}
              disabled={save.isPending}
              onChange={(analysisAgent) => save.mutate({ analysisAgent })}
            />
            <GlobalAgentFields
              kind="chat"
              agents={agents.data}
              layer={config.data.chatAgent}
              resolved={config.data.effective.chatAgent}
              disabled={save.isPending}
              onChange={(chatAgent) => save.mutate({ chatAgent })}
            />
            {save.error ? (
              <p className="pb-1 text-2xs" style={{ color: "var(--risk)" }}>
                {errorText(save.error)}
              </p>
            ) : null}
          </div>
          <label className="flex w-fit items-center gap-2 text-xs" style={{ color: "var(--fg-muted)" }}>
            <input
              type="checkbox"
              data-testid="global-managed-checkouts"
              checked={config.data.managedCheckouts}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ managedCheckouts: e.target.checked })}
              style={{ accentColor: "var(--accent)" }}
            />
            Managed checkouts — give runs an exact checkout of the PR head under ~/.purview/checkouts
          </label>
        </div>
      )}
    </Section>
  );
}

/**
 * GitHub review threads: which logins count as AI reviewers (server-side, so
 * the threads come back already labelled) and what this browser shows.
 */
function ReviewThreadsSection({
  settings,
  update,
}: {
  settings: SettingsShape;
  update: (patch: Partial<SettingsShape>) => void;
}) {
  const config = useGlobalConfig();
  const save = useSaveGlobalConfig();
  const saved = (config.data?.aiReviewers ?? []).join(", ");
  const [text, setText] = useState<string | null>(null);
  const value = text ?? saved;
  const commit = () => {
    if (text === null) return;
    const next = parseLoginList(text);
    setText(null);
    if (next.join(", ") !== saved) save.mutate({ aiReviewers: next });
  };
  return (
    <Section
      title="GitHub review threads"
      hint="Everyone's review comments on the PR show inline next to yours. GitHub's own bots are recognized as AI reviewers; list any other logins that should count too."
    >
      <div className="flex flex-col gap-3">
        {/* A form, so Enter saves: the modal stops keydown before React sees it,
            but the implicit submit that Enter triggers still arrives. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <Field label="Extra AI reviewers">
            <input
              className="input max-w-md px-2 py-1 font-mono text-xs"
              data-testid="ai-reviewers"
              placeholder="e.g. acme-review-bot, sweep-ai"
              value={value}
              disabled={!config.data || save.isPending}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
            />
          </Field>
        </form>
        {config.error ? (
          <p className="text-2xs" style={{ color: "var(--risk)" }}>
            {errorText(config.error) || "Could not read the server's settings."}
          </p>
        ) : save.error ? (
          <p className="text-2xs" style={{ color: "var(--risk)" }}>
            {errorText(save.error)}
          </p>
        ) : (
          <p className="-mt-2 text-2xs" style={{ color: "var(--fg-faint)" }}>
            Comma or space separated · stored on the server · applies on the next refresh of a PR's threads
          </p>
        )}
        <div className="flex flex-wrap items-center gap-6">
          <Field label="Resolved threads">
            <Segmented
              value={settings.showResolvedThreads ? "show" : "hide"}
              options={[
                { value: "show", label: "collapsed" },
                { value: "hide", label: "hidden" },
              ]}
              onChange={(v) => update({ showResolvedThreads: v === "show" })}
            />
          </Field>
          <Field label="AI reviewers">
            <Segmented
              value={settings.showAiReviewers ? "show" : "hide"}
              options={[
                { value: "show", label: "show" },
                { value: "hide", label: "hide" },
              ]}
              onChange={(v) => update({ showAiReviewers: v === "show" })}
            />
          </Field>
          {settings.hiddenBots.length ? (
            <div className="flex flex-col gap-1">
              <span className="text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
                Hidden one by one
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {settings.hiddenBots.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className="chip"
                    style={{ background: "var(--bot-soft)", color: "var(--bot)" }}
                    title={`Show ${b}'s threads again`}
                    onClick={() => update({ hiddenBots: settings.hiddenBots.filter((x) => x !== b) })}
                  >
                    {b} ×
                  </button>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/**
 * The global-layer sibling of RepoSettings' `SelectField`: same "inherit vs.
 * pinned value" shape, but "inherit" here is the *end* of the chain, so the
 * hint shows the built-in default inline in the option rather than a source.
 */
function GlobalSelectField({
  label,
  testId,
  value,
  fallback,
  shown,
  disabled,
  options,
  onChange,
}: {
  label: string;
  testId: string;
  value: string | null;
  /** what inheriting means here, as shown */
  fallback: string;
  /** the pinned value, as shown */
  shown?: string;
  disabled?: boolean;
  options: { value: string; label: string; title?: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Field label={label}>
        <select
          data-testid={`${testId}-select`}
          className="rounded px-2 py-1 text-xs outline-none"
          value={value ?? "inherit"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "inherit" ? null : e.target.value)}
          style={{
            background: "var(--bg-inset)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
          }}
        >
          <option value="inherit">inherit ({fallback})</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} title={o.title}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
        {value ? `Every repo without its own setting uses ${shown ?? value}.` : `Built-in default: ${fallback}.`}
      </p>
    </div>
  );
}

/**
 * One kind of work's agent at the global layer. Inheriting falls through to
 * the default harness and, for a model or effort, to the harness's manifest
 * defaults.
 */
function GlobalAgentFields<T extends AgentSelection>({
  kind,
  agents,
  layer,
  resolved,
  disabled,
  onChange,
}: {
  kind: "analysis" | "chat";
  agents: AgentsInfo | undefined;
  layer: T | null;
  resolved: ResolvedAgent;
  disabled?: boolean;
  onChange: (selection: T | null) => void;
}) {
  const manifest = manifestOf(agents, resolved.harness);
  const inherited = inheritedHarness(agents, layer, resolved.harness);
  const edit = (field: "harness" | "model" | "effort", value: string | null) =>
    onChange(editSelection(layer, field, value, resolved.harness, inherited));
  const title = kind === "analysis" ? "Analysis" : "Chat";
  const prefix = `global-${kind}`;
  return (
    <>
      {offersHarnessChoice(agents) ? (
        <GlobalSelectField
          label={`${title} agent`}
          testId={`${prefix}-harness`}
          value={layer?.harness ?? null}
          fallback={manifestOf(agents, agents!.default)?.name ?? agents!.default}
          shown={manifest?.name}
          disabled={disabled}
          options={harnessOptions(agents)}
          onChange={(v) => edit("harness", v)}
        />
      ) : null}
      <GlobalSelectField
        label={`${title} model`}
        testId={`${prefix}-model`}
        value={layer?.model ?? null}
        fallback={modelLabel(manifest, manifest?.defaults.model ?? resolved.model)}
        shown={layer?.model ? modelLabel(manifest, layer.model) : undefined}
        disabled={disabled}
        options={modelOptions(manifest)}
        onChange={(v) => edit("model", v)}
      />
      {kind === "analysis" ? (
        <GlobalSelectField
          label="Effort"
          testId={`${prefix}-effort`}
          value={layer?.effort ?? null}
          fallback={manifest?.defaults.effort ?? resolved.effort ?? ""}
          disabled={disabled}
          options={effortOptions(manifest)}
          onChange={(v) => edit("effort", v)}
        />
      ) : null}
      {resolved.problem ? (
        <p className="pb-1 max-w-xs text-2xs leading-4" style={{ color: "var(--risk)" }}>
          {resolved.problem}
        </p>
      ) : null}
    </>
  );
}

const REQUEST_AGE_LEVELS = [
  { name: "yellow", color: "var(--age-1)" },
  { name: "orange", color: "var(--age-2)" },
  { name: "red", color: "var(--age-3)" },
] as const;

function RequestAgeFields({
  days,
  update,
}: {
  days: RequestAgeDays;
  update: (patch: Partial<SettingsShape>) => void;
}) {
  const set = (i: number, value: number) => {
    const next = [...days] as RequestAgeDays;
    next[i] = value;
    update({ requestAgeDays: next });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-xs">
      {REQUEST_AGE_LEVELS.map((level, i) => (
        <label
          key={level.name}
          className="flex items-center gap-2"
          data-testid={`request-age-${level.name}`}
        >
          <span
            aria-hidden
            className="h-2 w-2 flex-none rounded-full"
            style={{ background: level.color }}
          />
          <span style={{ color: level.color }}>{level.name}</span>
          <span style={{ color: "var(--fg-faint)" }}>after</span>
          <input
            type="number"
            min={0}
            max={MAX_REQUEST_AGE_DAYS}
            className="input w-14 px-1.5 py-0.5 text-2xs tabular-nums"
            value={days[i]}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) set(i, n);
            }}
          />
          <span style={{ color: "var(--fg-faint)" }}>{days[i] === 1 ? "day" : "days"}</span>
        </label>
      ))}
    </div>
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
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
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
