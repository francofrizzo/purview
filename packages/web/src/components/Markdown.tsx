/**
 * Renders the markdown subset parsed by lib/markdown.ts.
 *
 * Tuned for a dense editor sidebar rather than a document: tight leading, no
 * oversized headings, code in the app's own code font. Fenced blocks with a
 * language tag reuse the diff's shiki infrastructure, so a snippet in the chat
 * is coloured by exactly the same theme as the diff next to it.
 */

import { memo, useEffect, useState } from "react";
import { parseInline, parseMarkdown, type MdInline } from "../lib/markdown";
import { cachedTokens, tokenizeLines, type Tok } from "../lib/highlight";
import { renderMermaid } from "../lib/mermaid";
import { useSettings } from "../lib/settings";
import { shikiThemeFor } from "../lib/themes";

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

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
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

  const lines = code.split("\n");
  return (
    <div
      className="my-1.5 overflow-x-auto rounded"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
    >
      {lang ? (
        <div
          className="border-b px-2 py-0.5 font-mono text-2xs"
          style={{ borderColor: "var(--border)", color: "var(--fg-faint)" }}
        >
          {lang}
        </div>
      ) : null}
      <pre
        className="px-2 py-1.5 font-mono"
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
  return (
    <div
      className="my-1.5 overflow-x-auto rounded p-2"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
      // mermaid runs under securityLevel "strict": no script/foreignObject
      // survives into this markup, so this is safe to inject as-is.
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="text-xs leading-[19px]" style={{ color: "var(--fg-muted)" }}>
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
                  <li key={j}>
                    <Inline nodes={parseInline(item)} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="my-1 list-disc space-y-0.5 pl-4">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline nodes={parseInline(item)} />
                  </li>
                ))}
              </ul>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="my-1 border-l-2 pl-2"
                style={{ borderColor: "var(--border-strong)", color: "var(--fg-faint)" }}
              >
                <Inline nodes={parseInline(block.text)} />
              </blockquote>
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
    </div>
  );
});
