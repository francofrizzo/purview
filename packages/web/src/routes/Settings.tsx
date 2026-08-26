import { useEffect, useMemo, useState } from "react";
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
  MIN_CODE_FONT_SIZE,
  TAB_SIZES,
  useSettings,
  type Settings as SettingsShape,
} from "../lib/settings";
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
      subtitle="Appearance only, for now. Every change applies immediately and is stored in this browser."
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
        </div>
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

// ---------------------------------------------------------------------------
// small shared bits
// ---------------------------------------------------------------------------

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
