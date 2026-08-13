import { useMemo, useState } from "react";
import type { ChatRef, PrDetail } from "../api/types";
import { QuoteButton } from "./ChatPanel";
import { IconChevron, IconFile } from "./icons";
import { MiddleTruncate } from "./Truncate";
import { MatchBadge } from "./UnitSidebar";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: { path: string; hunkCount: number };
}

function buildTree(paths: { path: string; hunkCount: number }[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of paths) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.file = f;
      node = child;
    });
  }
  // collapse single-child directory chains for density
  const collapse = (n: TreeNode): TreeNode => {
    const kids = [...n.children.values()].map(collapse);
    n.children = new Map(kids.map((k) => [k.name, k]));
    if (!n.file && kids.length === 1 && !kids[0].file && n.name) {
      const only = kids[0];
      return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return collapse(root);
}

export function FileTree({
  detail,
  selectedPath,
  onSelect,
  onQuote,
  matchCounts,
}: {
  detail: PrDetail;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onQuote?: (ref: ChatRef) => void;
  /** search hits per file path; files with none render unchanged */
  matchCounts?: Map<string, number>;
}) {
  const tree = useMemo(
    () =>
      buildTree(detail.files.files.map((f) => ({ path: f.path, hunkCount: f.hunks.length }))),
    [detail.files],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const renderNode = (node: TreeNode, depth: number): JSX.Element[] => {
    const out: JSX.Element[] = [];
    const kids = [...node.children.values()].sort((a, b) => {
      const aDir = a.children.size > 0 ? 0 : 1;
      const bDir = b.children.size > 0 ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    });
    for (const kid of kids) {
      if (kid.children.size > 0) {
        const isCollapsed = collapsed.has(kid.path);
        out.push(
          <button
            key={`d:${kid.path}`}
            type="button"
            onClick={() =>
              setCollapsed((s) => {
                const n = new Set(s);
                if (n.has(kid.path)) n.delete(kid.path);
                else n.add(kid.path);
                return n;
              })
            }
            className="flex w-full items-center gap-1 py-[3px] pr-2 text-left font-mono text-2xs"
            style={{ paddingLeft: 8 + depth * 10, color: "var(--fg-muted)" }}
          >
            <IconChevron open={!isCollapsed} width={9} height={9} />
            <MiddleTruncate text={kid.name} tail={10} title={kid.path} />
          </button>,
        );
        if (!isCollapsed) out.push(...renderNode(kid, depth + 1));
      } else if (kid.file) {
        const rollup = detail.state.files?.[kid.file.path];
        const selected = selectedPath === kid.file.path;
        const viewed = rollup?.viewed;
        out.push(
          <div key={`f:${kid.path}`} className="group relative flex items-center">
          <button
            type="button"
            onClick={() => onSelect(kid.file!.path)}
            className="flex w-full items-center gap-1.5 border-l-2 py-[3px] pr-2 text-left font-mono text-2xs"
            style={{
              paddingLeft: 6 + depth * 10,
              borderColor: selected ? "var(--accent)" : "transparent",
              background: selected ? "var(--accent-soft)" : "transparent",
              color: viewed ? "var(--fg-faint)" : "var(--fg)",
            }}
          >
            <IconFile width={10} height={10} style={{ opacity: 0.6, flex: "none" }} />
            <MiddleTruncate text={kid.name} tail={13} title={kid.file.path} />
            {matchCounts?.get(kid.file.path) ? (
              <MatchBadge count={matchCounts.get(kid.file.path)!} />
            ) : null}
            <span className="ml-auto flex-none tabular-nums" style={{ color: "var(--fg-faint)" }}>
              {rollup ? `${rollup.viewedHunks}/${rollup.totalHunks}` : kid.file.hunkCount}
            </span>
            <span
              className="h-1.5 w-1.5 flex-none rounded-full"
              title={viewed ? "all hunks viewed" : "not fully viewed"}
              style={{
                background: viewed ? "var(--ok)" : "var(--border-strong)",
              }}
            />
          </button>
          {onQuote ? (
            <span
              className="absolute right-1 hidden rounded px-0.5 group-hover:block"
              style={{ background: selected ? "var(--bg-hover)" : "var(--bg-raised)" }}
            >
              <QuoteButton
                title={`Ask Claude about ${kid.file!.path}`}
                onClick={() => onQuote({ kind: "file", path: kid.file!.path })}
              />
            </span>
          ) : null}
          </div>,
        );
      }
    }
    return out;
  };

  return <div className="py-1">{renderNode(tree, 0)}</div>;
}
