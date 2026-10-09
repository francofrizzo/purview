/**
 * Renders the markdown subset parsed by lib/markdown.ts.
 *
 * Tuned for a dense editor sidebar rather than a document: tight leading, no
 * oversized headings, code in the app's own code font. Fenced blocks with a
 * language tag reuse the diff's shiki infrastructure, so a snippet in the chat
 * is coloured by exactly the same theme as the diff next to it.
 */

import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import { parseInline, parseMarkdown, type MdBlock, type MdInline } from "../lib/markdown";
import { cachedTokens, tokenizeLines, type Tok } from "../lib/highlight";
import { renderMermaid } from "../lib/mermaid";
import { useSettings } from "../lib/settings";
import { shikiThemeFor } from "../lib/themes";
import { IconCheck, IconChevron, IconCopy, IconExpand, IconWrap } from "./icons";
import { Modal } from "./Modal";

/** Stable, cheap cache key for a snippet (shiki's cache is keyed by string). */
function hashCode(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `md${(h >>> 0).toString(36)}`;
}

/** Markdown fence tags are not always shiki language ids. */
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  golang: "go",
  py: "python",
  rb: "ruby",
  "c++": "cpp",
  "c#": "csharp",
  console: "bash",
  text: "",
  plain: "",
  txt: "",
  // GitHub's ```suggestion: replacement lines for the commented code, in
  // whatever language that is — shown plain, under its own label.
  suggestion: "",
};

/** What a code span links to, when its text names something the page can open. */
export interface CodeLink {
  /** hover text, e.g. "Unit 3: Extract shared rollout selector" */
  title: string;
  onOpen: () => void;
  /** shown instead of the span's own text (a unit's number and title, not its id) */
  label?: { number?: number; text: string };
}

/**
 * Lets a surface turn code spans into in-app links: the chat recognizes this
 * PR's unit ids (the model writes them as `unit-id`) without the model having
 * to learn a link syntax, and older transcripts light up too. No provider,
 * no links.
 */
export const CodeLinkContext = createContext<((text: string) => CodeLink | null) | null>(null);

/** A picture the page may draw itself: the local copy of a comment attachment. */
export interface LocalMedia {
  src: string;
  kind: "image" | "video";
  name: string;
}

/**
 * Lets a surface draw images from the local attachment store (lib/attachments.ts):
 * a `purview-attachment:` reference, or the GitHub asset URL it became when the
 * comment was pushed, when a local copy exists. Everything else keeps the rule
 * below — images stay links, no remote content loads into the review page.
 */
export interface AttachmentScope {
  /** the PR whose attachment store editors upload into */
  prKey: string;
  resolve: (href: string) => LocalMedia | null;
}
export const AttachmentContext = createContext<AttachmentScope | null>(null);

function Inline({ nodes }: { nodes: MdInline[] }) {
  const linkFor = useContext(CodeLinkContext);
  const mediaFor = useContext(AttachmentContext)?.resolve;
  return (
    <>
      {nodes.map((node, i) => {
        const link = node.type === "code" ? linkFor?.(node.text) : null;
        if (node.type === "br") return <br key={i} />;
        if (node.type === "image") {
          const local = node.href ? mediaFor?.(node.href) : null;
          if (local) {
            // A comment's own picture, served by the local server.
            return local.kind === "video" ? (
              <video
                key={i}
                src={local.src}
                controls
                preload="metadata"
                data-testid="attachment-media"
                className="my-1 block max-h-80 max-w-full rounded"
                style={{ border: "1px solid var(--border)" }}
              />
            ) : (
              <a key={i} href={local.src} target="_blank" rel="noreferrer noopener" title={node.alt || local.name}>
                <img
                  src={local.src}
                  alt={node.alt || local.name}
                  data-testid="attachment-media"
                  className="my-1 block max-h-80 max-w-full rounded"
                  style={{ border: "1px solid var(--border)" }}
                />
              </a>
            );
          }
          // Other images stay links: a PR description's screenshots open on
          // GitHub rather than loading remote content into the review page.
          return node.href ? (
            <a
              key={i}
              href={node.href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
              style={{ color: "var(--accent)" }}
            >
              🖼 {node.alt || "image"}
            </a>
          ) : null;
        }
        if (node.type === "kbd") {
          return (
            <kbd
              key={i}
              className="rounded border px-1 font-mono"
              style={{ fontSize: "0.88em", borderColor: "var(--border-strong)", background: "var(--bg-raised)", color: "var(--fg)" }}
            >
              {node.text}
            </kbd>
          );
        }
        if (node.type === "del") return <del key={i} style={{ opacity: 0.75 }}>{node.text}</del>;
        if (node.type === "ins") return <ins key={i}>{node.text}</ins>;
        if (node.type === "sub") return <sub key={i}>{node.text}</sub>;
        if (node.type === "sup") return <sup key={i}>{node.text}</sup>;
        if (node.type === "mark") {
          return (
            <mark key={i} className="rounded-sm px-0.5" style={{ background: "var(--warn-soft)", color: "var(--fg)" }}>
              {node.text}
            </mark>
          );
        }
        if (link?.label) {
          return (
            <button
              key={i}
              type="button"
              className="inline rounded px-1 py-px text-left font-medium transition-colors hover:bg-[var(--accent-soft)]"
              style={{ color: "var(--accent)", boxShadow: "inset 0 -1px 0 var(--accent-soft)" }}
              title={`${link.title} (click to open)`}
              onClick={link.onOpen}
            >
              {link.label.number !== undefined ? (
                <span className="mr-1 tabular-nums" style={{ opacity: 0.65 }}>
                  {link.label.number}
                </span>
              ) : null}
              {link.label.text}
            </button>
          );
        }
        if (link) {
          return (
            <button
              key={i}
              type="button"
              className="inline rounded px-1 py-px text-left font-mono underline decoration-dotted underline-offset-2 transition-colors hover:bg-[var(--accent-soft)]"
              style={{
                color: "var(--accent)",
                fontSize: "0.92em",
                border: "1px solid var(--border)",
                background: "var(--bg-inset)",
              }}
              title={`${link.title} (click to open)`}
              onClick={link.onOpen}
            >
              {node.type === "code" ? node.text : null}
            </button>
          );
        }
        if (node.type === "code") {
          return (
            <code
              key={i}
              className="rounded px-1 py-px font-mono"
              style={{
                background: "var(--bg-inset)",
                color: "var(--fg)",
                fontSize: "0.92em",
                border: "1px solid var(--border)",
              }}
            >
              {node.text}
            </code>
          );
        }
        if (node.type === "strong") {
          return (
            <strong key={i} style={{ color: "var(--fg)" }}>
              {node.text}
            </strong>
          );
        }
        if (node.type === "em") {
          return <em key={i}>{node.text}</em>;
        }
        if (node.type === "link") {
          return (
            <a
              key={i}
              href={node.href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
              style={{ color: "var(--accent)" }}
            >
              {node.text}
            </a>
          );
        }
        return <span key={i}>{node.text}</span>;
      })}
    </>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const { appearance } = useSettings();
  const theme = shikiThemeFor(appearance.theme);
  const resolved = lang ? (LANG_ALIASES[lang] ?? lang) : null;
  const cacheKey = hashCode(code);
  const [tokens, setTokens] = useState<Tok[][] | null>(() =>
    resolved ? (cachedTokens(cacheKey, resolved, theme.name) ?? null) : null,
  );

  useEffect(() => {
    if (!resolved) {
      setTokens(null);
      return;
    }
    let alive = true;
    void tokenizeLines(cacheKey, code, resolved, theme).then((t) => {
      if (alive) setTokens(t);
    });
    return () => {
      alive = false;
    };
  }, [cacheKey, code, resolved, theme]);

  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  const lines = code.split("\n");
  return (
    <div
      className="my-1.5 rounded"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
    >
      <div
        className="flex items-center gap-1.5 border-b px-2 py-0.5 text-2xs"
        style={{ borderColor: "var(--border)", color: "var(--fg-faint)" }}
      >
        <span className={lang === "suggestion" ? "font-medium" : "font-mono"}>
          {lang === "suggestion" ? "suggested change" : (lang ?? "")}
        </span>
        <button
          type="button"
          data-testid="code-wrap"
          aria-pressed={wrap}
          aria-label={wrap ? "Don't wrap lines" : "Wrap lines"}
          title={wrap ? "Don't wrap lines" : "Wrap lines"}
          className="ml-auto inline-flex items-center rounded p-0.5 hover:!text-[var(--fg)]"
          style={{ color: wrap ? "var(--accent)" : "var(--fg-faint)" }}
          onClick={() => setWrap((v) => !v)}
        >
          <IconWrap width={12} height={12} />
        </button>
        <button
          type="button"
          data-testid="code-copy"
          aria-label="Copy code"
          title={copied ? "Copied" : "Copy code"}
          className="inline-flex items-center rounded p-0.5 hover:!text-[var(--fg)]"
          style={{ color: copied ? "var(--ok)" : "var(--fg-faint)" }}
          onClick={copy}
        >
          {copied ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
        </button>
      </div>
      <pre
        className={`px-2 py-1.5 font-mono ${wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"}`}
        style={{
          fontSize: "var(--code-font-size)",
          lineHeight: "var(--code-line-height)",
          tabSize: "var(--tab-size)" as unknown as number,
        }}
      >
        {lines.map((line, i) => (
          <div key={i}>
            {tokens?.[i]?.length
              ? tokens[i].map((t, j) => (
                  <span key={j} style={t.color ? { color: t.color } : undefined}>
                    {t.content}
                  </span>
                ))
              : line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

/**
 * A ```mermaid fence, rendered to inline SVG.
 *
 * `open` (still-streaming, unclosed fence) is forwarded straight to
 * lib/mermaid.ts, which resolves it to "pending" without ever touching the
 * mermaid module — so a diagram is only attempted once the fence closes, and
 * a half-arrived block just reads as the raw fenced code in the meantime.
 * The same raw-code render is also the error fallback: a parse/render
 * failure never leaves a blank diagram.
 */
function MermaidBlock({ code, open }: { code: string; open: boolean }) {
  const { appearance } = useSettings();
  const dark = appearance.theme.mode === "dark";
  const fontFamily = appearance.uiFont;
  const [result, setResult] = useState<{ status: "pending" | "ok" | "error"; svg?: string }>({
    status: "pending",
  });
  const [enlarged, setEnlarged] = useState(false);

  useEffect(() => {
    let alive = true;
    setResult({ status: "pending" });
    void renderMermaid(code, open, { dark, fontFamily }).then((r) => {
      if (alive) setResult(r);
    });
    return () => {
      alive = false;
    };
  }, [code, open, dark, fontFamily]);

  if (result.status !== "ok" || !result.svg) return <CodeBlock code={code} lang="mermaid" />;
  // mermaid runs under securityLevel "strict": no script/foreignObject
  // survives into this markup, so this is safe to inject as-is.
  const svg = { __html: result.svg };
  return (
    <div className="group relative my-1.5">
      <div
        className="overflow-x-auto rounded p-2"
        style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
        dangerouslySetInnerHTML={svg}
      />
      <button
        type="button"
        className="btn absolute right-1.5 top-1.5 px-1.5 py-0.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        title="Enlarge diagram"
        aria-label="Enlarge diagram"
        data-testid="mermaid-enlarge"
        onClick={() => setEnlarged(true)}
      >
        <IconExpand width={11} height={11} />
      </button>
      {enlarged ? (
        <Modal title="Diagram" maxWidth={1400} onClose={() => setEnlarged(false)} testId="mermaid-modal">
          {/* mermaid pins a max-width on its svg; here it fills the dialog's
              width, capped to its height so a tall chart scales to fit too */}
          <div
            className="p-4 [&_svg]:!h-auto [&_svg]:!max-h-[calc(85vh-6rem)] [&_svg]:!w-full [&_svg]:!max-w-none"
            dangerouslySetInnerHTML={svg}
          />
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * One line of prose that may carry inline markdown (`code`, **bold**, links) —
 * analysis titles, summaries and findings — rendered inline, without blocks.
 */
export function InlineMarkdown({ text }: { text: string }) {
  return <Inline nodes={parseInline(text)} />;
}

/** Body text size; the chat reads a step larger than the app's other prose. */
export const PROSE_TEXT = "text-xs leading-[19px]";
export const CHAT_TEXT = "text-[13px] leading-[21px]";

/** GitHub alerts: `> [!NOTE]` and friends, as a colored callout. */
const ALERT = /^\[!(note|tip|important|warning|caution)\]\s*/i;
const ALERTS: Record<string, { label: string; color: string }> = {
  NOTE: { label: "Note", color: "var(--accent)" },
  TIP: { label: "Tip", color: "var(--ok)" },
  IMPORTANT: { label: "Important", color: "var(--kind-core)" },
  WARNING: { label: "Warning", color: "var(--warn)" },
  CAUTION: { label: "Caution", color: "var(--risk)" },
};

/** A list item; `[ ]` / `[x]` at its start is a (read-only) task checkbox. */
function ListItem({ item }: { item: string }) {
  const task = /^\[([ xX])\]\s+/.exec(item);
  if (!task) {
    return (
      <li>
        <Inline nodes={parseInline(item)} />
      </li>
    );
  }
  const done = task[1] !== " ";
  return (
    <li className="-ml-4 flex list-none items-baseline gap-1.5">
      <input
        type="checkbox"
        checked={done}
        readOnly
        tabIndex={-1}
        aria-label={done ? "done" : "not done"}
        className="pointer-events-none relative top-px flex-none"
        style={{ accentColor: "var(--accent)" }}
      />
      <span>
        <Inline nodes={parseInline(item.slice(task[0].length))} />
      </span>
    </li>
  );
}

/** Rendered blocks; recursive, since a `<details>` holds blocks of its own. */
function BlockList({ blocks }: { blocks: MdBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "code":
            return block.lang === "mermaid" ? (
              <MermaidBlock key={i} code={block.code} open={block.open} />
            ) : (
              <CodeBlock key={i} code={block.code} lang={block.lang} />
            );
          case "table":
            return (
              <div key={i} className="my-1.5 overflow-x-auto">
                <table
                  className="w-full border-collapse text-xs tabular-nums"
                  style={{ border: "1px solid var(--border)" }}
                >
                  <thead>
                    <tr style={{ background: "var(--bg-raised)" }}>
                      {block.header.map((cell, c) => (
                        <th
                          key={c}
                          className="px-2 py-1 font-semibold"
                          style={{
                            color: "var(--fg)",
                            border: "1px solid var(--border)",
                            textAlign: block.align[c] ?? "left",
                          }}
                        >
                          <Inline nodes={parseInline(cell)} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            className="px-2 py-1 align-top"
                            style={{
                              border: "1px solid var(--border)",
                              textAlign: block.align[c] ?? "left",
                            }}
                          >
                            <Inline nodes={parseInline(cell)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "heading":
            return (
              <div
                key={i}
                className="mb-0.5 mt-2 font-semibold first:mt-0"
                style={{
                  color: "var(--fg)",
                  fontSize: block.level <= 2 ? "13px" : "12px",
                }}
              >
                <Inline nodes={parseInline(block.text)} />
              </div>
            );
          case "list":
            return block.ordered ? (
              <ol key={i} className="my-1 list-decimal space-y-0.5 pl-4">
                {block.items.map((item, j) => (
                  <ListItem key={j} item={item} />
                ))}
              </ol>
            ) : (
              <ul key={i} className="my-1 list-disc space-y-0.5 pl-4">
                {block.items.map((item, j) => (
                  <ListItem key={j} item={item} />
                ))}
              </ul>
            );
          case "quote": {
            const alert = ALERT.exec(block.text);
            if (alert) {
              const kind = ALERTS[alert[1].toUpperCase()];
              const first = block.blocks[0];
              // The `[!NOTE]` marker leads the first block; the rest of that
              // block (if any) is the callout's first line of content.
              const body =
                first && "text" in first && typeof first.text === "string"
                  ? [{ ...first, text: first.text.replace(ALERT, "") } as MdBlock, ...block.blocks.slice(1)].filter(
                      (b) => !("text" in b) || b.text.trim() !== "",
                    )
                  : block.blocks;
              return (
                <div
                  key={i}
                  data-testid="md-alert"
                  className="my-1.5 border-l-2 py-0.5 pl-2"
                  style={{ borderColor: kind.color }}
                >
                  <div className="font-semibold" style={{ color: kind.color }}>
                    {kind.label}
                  </div>
                  <BlockList blocks={body} />
                </div>
              );
            }
            return (
              <blockquote
                key={i}
                className="my-1 border-l-2 pl-2"
                style={{ borderColor: "var(--border-strong)", color: "var(--fg-faint)" }}
              >
                <BlockList blocks={block.blocks} />
              </blockquote>
            );
          }
          case "details":
            return (
              <details
                key={i}
                open={block.open}
                data-testid="md-details"
                className="group/details my-1.5 rounded border"
                style={{ borderColor: "var(--border)" }}
              >
                <summary
                  className="flex cursor-pointer select-none list-none items-center gap-1.5 px-2 py-1 [&::-webkit-details-marker]:hidden"
                  style={{ color: "var(--fg)" }}
                >
                  {/* The wrapper turns: IconChevron sets its own inline transform. */}
                  <span
                    className="inline-flex flex-none transition-transform group-open/details:rotate-90"
                    style={{ color: "var(--fg-faint)" }}
                  >
                    <IconChevron width={10} height={10} />
                  </span>
                  <span className="min-w-0">
                    <Inline nodes={parseInline(block.summary)} />
                  </span>
                </summary>
                <div className="border-t px-2 pb-1.5 pt-1" style={{ borderColor: "var(--border)" }}>
                  <BlockList blocks={block.blocks} />
                </div>
              </details>
            );
          case "hr":
            return (
              <hr key={i} className="my-2" style={{ borderColor: "var(--border)" }} />
            );
          default:
            return (
              <p key={i} className="my-1 first:mt-0">
                <Inline nodes={parseInline(block.text)} />
              </p>
            );
        }
      })}
    </>
  );
}

export const Markdown = memo(function Markdown({
  text,
  textClass = PROSE_TEXT,
  ink = "var(--fg-muted)",
}: {
  text: string;
  textClass?: string;
  /** body text color; prose is muted, a comment reads at full strength */
  ink?: string;
}) {
  const blocks = parseMarkdown(text);
  return (
    <div className={textClass} style={{ color: ink }}>
      <BlockList blocks={blocks} />
    </div>
  );
});
