import { loadState, prDir, priorRevisions, readFilesJson, readMeta, type FileDiff, type Hunk, type PrKey } from "@reviewer/core";
import { getHarness } from "./agent/registry.js";
import { effectiveChatModel } from "./repo-config.js";
import { findAnchoringHunk, type Comment, type CommentSide } from "./comments.js";

/**
 * Agentic fallback for a draft comment `reanchorDraftComments` couldn't place
 * deterministically — its hunk changed shape or vanished, so there is no
 * exact offset to carry over. This never applies anything on its own: it asks
 * a one-shot agent run to propose a new file:line, validates the proposal
 * against the current diff itself (never trust the model on the invariant
 * that matters), and hands the proposal back for the reader to accept or
 * dismiss. Applying it is a separate PATCH (see app.ts).
 */

export interface ReanchorProposal {
  applicable: boolean;
  /** present only when applicable */
  file?: string;
  line?: number;
  side?: CommentSide;
  /** one-line explanation either way */
  reason: string;
}

export type ReanchorResult = { ok: true; proposal: ReanchorProposal } | { ok: false; reason: string };

const CONTEXT_RADIUS = 10;

interface ExpandedLine {
  oldLine: number | null;
  newLine: number | null;
  prefix: " " | "+" | "-";
  text: string;
}

/** A hunk's raw body, walked line by line with running old/new line numbers. */
function expandHunk(hunk: Hunk): ExpandedLine[] {
  const lines: ExpandedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const raw of hunk.text.split("\n")) {
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const prefix = raw.startsWith("+") ? "+" : raw.startsWith("-") ? "-" : " ";
    const text = raw.slice(1);
    if (prefix === "+") {
      lines.push({ oldLine: null, newLine, prefix, text });
      newLine++;
    } else if (prefix === "-") {
      lines.push({ oldLine, newLine: null, prefix, text });
      oldLine++;
    } else {
      lines.push({ oldLine, newLine, prefix, text });
      oldLine++;
      newLine++;
    }
  }
  return lines;
}

/** ~`CONTEXT_RADIUS` lines around the comment's anchored line, with it marked `>>`. */
function renderAnchoredContext(hunk: Hunk, line: number, side: CommentSide): string {
  const expanded = expandHunk(hunk);
  const idx = expanded.findIndex((l) => (side === "RIGHT" ? l.newLine : l.oldLine) === line);
  const lo = Math.max(0, idx - CONTEXT_RADIUS);
  const hi = Math.min(expanded.length, idx + CONTEXT_RADIUS + 1);
  const out: string[] = [`@@ ${hunk.header} @@`];
  for (let i = lo; i < hi; i++) {
    const l = expanded[i];
    const marker = i === idx ? ">>" : "  ";
    const ln = side === "RIGHT" ? l.newLine : l.oldLine;
    out.push(`${marker} ${String(ln ?? "").padStart(5)} ${l.prefix}${l.text}`);
  }
  return out.join("\n");
}

/** header + numbered new-side lines (context and additions; removals dropped). */
function renderCurrentHunk(hunk: Hunk): string {
  const out: string[] = [`@@ ${hunk.header} @@`];
  for (const l of expandHunk(hunk)) {
    if (l.prefix === "-") continue;
    out.push(`  ${String(l.newLine).padStart(5)} ${l.prefix}${l.text}`);
  }
  return out.join("\n");
}

function buildPrompt(input: {
  comment: Comment;
  previousContext?: string;
  currentSection: string;
}): string {
  const { comment, previousContext, currentSection } = input;
  return [
    `You are helping re-anchor a code review draft comment after the pull request it targets changed.`,
    ``,
    `The comment's body:`,
    `"""`,
    comment.body,
    `"""`,
    ``,
    previousContext
      ? `Where the comment used to sit, in the newest prior revision of the diff where it still anchored ` +
        `(">>" marks the commented line):\n${previousContext}`
      : `The comment's original position could not be located in any earlier revision of the diff.`,
    ``,
    `The CURRENT diff for "${comment.file}":`,
    currentSection,
    ``,
    `Decide whether the comment still applies to a specific line in the CURRENT diff shown above.`,
    `If it does, respond with STRICT JSON only, no other text:`,
    `{"applicable": true, "file": "<path>", "line": <line number>, "side": "RIGHT", "reason": "<one line>"}`,
    `The line MUST be a new-side line number (context or "+") that appears in one of the current hunks shown above.`,
    `If the comment no longer applies — the code it discussed is gone, or you cannot confidently place it — respond with:`,
    `{"applicable": false, "reason": "<one line>"}`,
    `Respond with JSON only, nothing else.`,
  ].join("\n");
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    /* the model may have wrapped it in prose or a fenced block; fall through */
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Propose a new anchor for a draft line comment. Only ever reads state and
 * spawns a tool-less one-shot agent run — nothing is applied here; see
 * `updateCommentPosition` in comments.ts for the apply step.
 */
export async function proposeCommentReanchor(
  key: PrKey,
  comment: Comment,
  root?: string,
): Promise<ReanchorResult> {
  let prior: number[];
  let currentFiles: FileDiff[];
  try {
    const state = loadState(key, root);
    prior = priorRevisions(state);
    currentFiles = readFilesJson(key, state.currentRevision, root).files;
  } catch (err) {
    return { ok: false, reason: `Could not read the current diff: ${(err as Error).message}` };
  }

  const line = comment.line!;
  const side = comment.side!;

  let previousContext: string | undefined;
  for (const rev of prior) {
    let files: FileDiff[];
    try {
      files = readFilesJson(key, rev, root).files;
    } catch {
      continue; // tolerate a missing files.json for an intermediate revision
    }
    const hunk = findAnchoringHunk(files, comment.file, line, side);
    if (hunk) {
      previousContext = renderAnchoredContext(hunk, line, side);
      break;
    }
  }

  const currentFile = currentFiles.find((f) => f.path === comment.file);
  const currentSection = currentFile
    ? currentFile.hunks.map(renderCurrentHunk).join("\n\n")
    : [
        `The file "${comment.file}" is no longer part of the diff.`,
        `Files currently in the diff:`,
        ...currentFiles.map((f) => `- ${f.path}`),
      ].join("\n");

  const prompt = buildPrompt({ comment, previousContext, currentSection });

  const meta = readMeta(key, root);
  const model = effectiveChatModel(key, root, { meta });

  const run = getHarness().run({
    task: { kind: "reanchor" },
    prompt,
    cwd: prDir(key, root),
    model,
    timeoutMs: 90_000,
  });

  let text = "";
  let ok = false;
  let error: string | undefined;
  try {
    for await (const event of run.events) {
      if (event.type === "output") text += event.text;
      else if (event.type === "completed") {
        ok = event.ok;
        error = event.error;
      }
    }
  } catch (err) {
    return { ok: false, reason: `agent run failed: ${(err as Error).message}` };
  }
  if (!ok) {
    return { ok: false, reason: error ?? "the agent exited without a result" };
  }

  const parsed = extractJson(text);
  if (!parsed) {
    return { ok: false, reason: "Could not parse a JSON proposal out of the model's response" };
  }

  if (parsed.applicable !== true) {
    return {
      ok: true,
      proposal: {
        applicable: false,
        reason: typeof parsed.reason === "string" ? parsed.reason : "Not applicable",
      },
    };
  }

  const file = typeof parsed.file === "string" && parsed.file.trim() ? parsed.file : comment.file;
  const proposedLine = typeof parsed.line === "number" ? parsed.line : undefined;
  if (proposedLine === undefined || !Number.isInteger(proposedLine)) {
    return { ok: true, proposal: { applicable: false, reason: "Model did not return a valid line" } };
  }

  // Server-side validation: the model's own "applicable" claim is never
  // trusted for the invariant that matters — only a new-side line inside a
  // hunk of the CURRENT diff is a legal target.
  const hunk = findAnchoringHunk(currentFiles, file, proposedLine, "RIGHT");
  if (!hunk) {
    return {
      ok: true,
      proposal: {
        applicable: false,
        reason: `Model proposed ${file}:${proposedLine}, which is not part of the current diff`,
      },
    };
  }

  return {
    ok: true,
    proposal: {
      applicable: true,
      file,
      line: proposedLine,
      side: "RIGHT",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    },
  };
}
