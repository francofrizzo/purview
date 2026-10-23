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
import { conceptTip, type Glossary } from "../lib/glossary";
import type { Concept } from "../api/types";
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

/**
 * The PR's concepts (lib/glossary.ts): prose under a provider marks the first
 * place in each block that names one, and the mark explains it on hover. No
 * provider, plain prose.
 */
export const GlossaryContext = createContext<Glossary | null>(null);

/** A word the PR's concepts explain: underlined with dots, its meaning on hover. */
function ConceptMark({ concept, children }: { concept: Concept; children: React.ReactNode }) {
  return (
    <span
      className="concept-mark"
      data-testid="concept-mark"
      data-concept={concept.term}
      data-tip={conceptTip(concept)}
    >
      {children}
    </span>
  );
}

/**
 * A picture the page may draw itself: the local copy of a comment attachment,
 * or a GitHub-hosted picture the local server proxies.
 */
export interface LocalMedia {
  src: string;
  kind: "image" | "video";
  name: string;
  /** fetched through the server's proxy: when that answers an error, the picture turns back into a link */
  remote?: boolean;
}

/**
 * Lets a surface draw images through the local server (lib/attachments.ts): a
 * `purview-attachment:` reference or the GitHub asset URL it became when the
 * comment was pushed, served from the local store; and any picture GitHub
 * hosts (a description's screenshots, an image in someone's comment), which
 * the server fetches with the reader's token (`/api/prs/:key/image`). The
 * rule below still holds: the page only ever talks to localhost, no remote
 * content loads into the review page. Everything else stays a link.
 */
export interface AttachmentScope {
  /** the PR whose attachment store editors upload into */
  prKey: string;
  resolve: (href: string) => LocalMedia | null;
}
export const AttachmentContext = createContext<AttachmentScope | null>(null);

/**
 * The lines a comment's ```suggestion blocks would replace: its anchor's
 * text, looked up by whoever draws the comment next to the diff (the card,
 * the thread, the composer's preview). Null where the anchor is unknown or
 * off the diff (the drawer, an outdated thread) — then a block shows only
 * what it suggests.
 */
export const SuggestionContext = createContext<string[] | null>(null);

/**
 * One `![alt](href)`. A picture the local server can serve (a comment's own
 * attachment, or a GitHub-hosted one it proxies) is drawn; when the proxy
 * answers an error the picture falls back to the link. Other images stay
 * links: they open on GitHub rather than loading remote content into the
 * review page.
 */
function MediaNode({ href, alt, local }: { href?: string; alt?: string; local: LocalMedia | null }) {
  const [failed, setFailed] = useState(false);
  if (local && !failed) {
    const onError = local.remote ? () => setFailed(true) : undefined;
    const link = local.remote && href ? href : local.src;
    return local.kind === "video" ? (
      <video
        src={local.src}
        controls
        preload="metadata"
        onError={onError}
        data-testid="attachment-media"
        className="my-1 block max-h-80 max-w-full rounded"
        style={{ border: "1px solid var(--border)" }}
      />
    ) : (
      <a href={link} target="_blank" rel="noreferrer noopener" data-tip={alt || local.name}>
        <img
          src={local.src}
          alt={alt || local.name}
          onError={onError}
          data-testid="attachment-media"
          className="my-1 block max-h-80 max-w-full rounded"
          style={{ border: "1px solid var(--border)" }}
        />
      </a>
    );
  }
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2"
      style={{ color: "var(--accent)" }}
    >
      🖼 {alt || "image"}
    </a>
  ) : null;
}

function Inline({ nodes, marked: shared }: { nodes: MdInline[]; marked?: Set<Concept> }) {
  const linkFor = useContext(CodeLinkContext);
  const mediaFor = useContext(AttachmentContext)?.resolve;
  const glossary = useContext(GlossaryContext);
  // Once per concept per block: the first use is explained, the rest read
  // plain. A bold or an italic inside the block shares the block's count.
  const marked = shared ?? new Set<Concept>();
  const markOnce = (c: Concept | null): c is Concept => (c && !marked.has(c) ? (marked.add(c), true) : false);
  const withConcepts = (text: string) => {
    if (!glossary) return text;
    const out: React.ReactNode[] = [];
    let at = 0;
    for (const hit of glossary.find(text)) {
      if (!markOnce(hit.concept)) continue;
      if (hit.start > at) out.push(text.slice(at, hit.start));
      out.push(
        <ConceptMark key={hit.start} concept={hit.concept}>
          {text.slice(hit.start, hit.end)}
        </ConceptMark>,
      );
      at = hit.end;
    }
    if (!out.length) return text;
    if (at < text.length) out.push(text.slice(at));
    return out;
  };
  return (
    <>
      {nodes.map((node, i) => {
        const link = node.type === "code" ? linkFor?.(node.text) : null;
        if (node.type === "br") return <br key={i} />;
        if (node.type === "image") {
          const local = node.href ? mediaFor?.(node.href) : null;
          return <MediaNode key={i} href={node.href} alt={node.alt} local={local ?? null} />;
        }
        if (node.type === "kbd") {
          return (
            <kbd key={i}>{node.text}</kbd>
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
              data-tip={link.title}
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
              data-tip={link.title}
              onClick={link.onOpen}
            >
              {node.type === "code" ? node.text : null}
            </button>
          );
        }
        if (node.type === "code") {
          const concept = glossary?.forCode(node.text) ?? null;
          const code = (
            <code
              key={i}
              className="rounded px-1 py-px font-mono"
              style={{
                background: "var(--bg-inset)",
                color: "var(--fg)",
                fontSize: "0.92em",
                border: "1px solid var(--border)",
                // A long identifier (`Factory.BuildAssociator`) has no break
                // point of its own: let it wrap rather than run past its box,
                // and keep the chip's edges on every line it spans.
                overflowWrap: "anywhere",
                boxDecorationBreak: "clone",
                WebkitBoxDecorationBreak: "clone",
              }}
            >
              {node.text}
            </code>
          );
          return markOnce(concept) ? (
            <ConceptMark key={i} concept={concept}>
              {code}
            </ConceptMark>
          ) : (
            code
          );
        }
        if (node.type === "strong") {
          return (
            <strong key={i} style={{ color: "var(--fg)" }}>
              {node.children ? <Inline nodes={node.children} marked={marked} /> : node.text}
            </strong>
          );
        }
        if (node.type === "em") {
          return <em key={i}>{node.children ? <Inline nodes={node.children} marked={marked} /> : node.text}</em>;
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
        return <span key={i}>{withConcepts(node.text)}</span>;
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
        <span className="font-mono">{lang ?? ""}</span>
        <button
          type="button"
          data-testid="code-wrap"
          aria-pressed={wrap}
          aria-label={wrap ? "Don't wrap lines" : "Wrap lines"}
          data-tip={wrap ? "Don't wrap lines" : "Wrap lines"}
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
          data-tip={copied ? "Copied" : "Copy code"}
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
 * A ```suggestion fence, as GitHub draws it: the commented lines as removed,
 * the block's lines as added. One panel per block; several blocks in one
 * comment all stand against the same lines, as on GitHub.
 */
function SuggestionBlock({ code }: { code: string }) {
  const original = useContext(SuggestionContext);
  const added = code.split("\n");
  const codeStyle = {
    fontSize: "var(--code-font-size)",
    lineHeight: "var(--code-line-height)",
    tabSize: "var(--tab-size)" as unknown as number,
  };
  const side = (lines: string[], kind: "del" | "add") => (
    <pre
      data-testid={`suggestion-${kind}`}
      className="overflow-x-auto px-2 py-1 font-mono"
      style={{ ...codeStyle, background: `var(--${kind}-bg)`, color: "var(--fg)" }}
    >
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-3 flex-none select-none" style={{ color: "var(--fg-faint)" }} aria-hidden>
            {kind === "del" ? "-" : "+"}
          </span>
          <span className="whitespace-pre">{line || " "}</span>
        </div>
      ))}
    </pre>
  );
  return (
    <div
      data-testid="suggestion-block"
      className="my-1.5 overflow-hidden rounded"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
    >
      <div
        className="border-b px-2 py-0.5 text-2xs font-medium"
        style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
      >
        Suggested change
      </div>
      {original ? side(original, "del") : null}
      {side(added, "add")}
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
const MERMAID_RETRIES = 3;
const MERMAID_RETRY_MS = 3000;

function MermaidBlock({ code, open }: { code: string; open: boolean }) {
  const { appearance } = useSettings();
  const dark = appearance.theme.mode === "dark";
  const fontFamily = appearance.uiFont;
  const [result, setResult] = useState<{ status: "pending" | "ok" | "error" | "unavailable"; svg?: string }>({
    status: "pending",
  });
  const [enlarged, setEnlarged] = useState(false);
  // Counts the retries after the module failed to load (see lib/mermaid.ts):
  // a few, spaced out, cover the rebuild window without hammering the server.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult({ status: "pending" });
    void renderMermaid(code, open, { dark, fontFamily }).then((r) => {
      if (!alive) return;
      setResult(r);
      if (r.status === "unavailable" && attempt < MERMAID_RETRIES) {
        timer = setTimeout(() => setAttempt((n) => n + 1), MERMAID_RETRY_MS * (attempt + 1));
      }
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [code, open, dark, fontFamily, attempt]);

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
        data-tip="Enlarge diagram"
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

/**
 * A list item: its first line inline, then whatever nested content the
 * parser kept under it (a sub-list, another paragraph) as blocks. `[ ]` /
 * `[x]` at its start is a (read-only) task checkbox.
 */
function ListItem({ item }: { item: string }) {
  const nl = item.indexOf("\n");
  const head = nl === -1 ? item : item.slice(0, nl);
  const rest = nl === -1 ? "" : item.slice(nl + 1);
  const nested = rest.trim() ? <BlockList blocks={parseMarkdown(rest)} /> : null;
  const task = /^\[([ xX])\]\s+/.exec(head);
  if (!task) {
    return (
      <li>
        <Inline nodes={parseInline(head)} />
        {nested}
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
        <Inline nodes={parseInline(head.slice(task[0].length))} />
        {nested}
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
            if (block.lang === "mermaid") return <MermaidBlock key={i} code={block.code} open={block.open} />;
            if (block.lang === "suggestion") return <SuggestionBlock key={i} code={block.code} />;
            return <CodeBlock key={i} code={block.code} lang={block.lang} />;
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
              <ol key={i} className="my-1 list-decimal space-y-0.5 pl-4" start={block.start}>
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
