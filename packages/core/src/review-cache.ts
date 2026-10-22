import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prDir, type PrKey } from "./paths.js";
import { readMeta } from "./store.js";

const author = z.object({ login: z.string(), bot: z.boolean().default(false) });
const comment = z.object({ author, isMine: z.boolean(), createdAt: z.string(), body: z.string() });
const cacheSchema = z.object({
  fetchedAt: z.string(),
  threads: z.array(z.object({ id: z.string(), path: z.string(), line: z.number().nullable(),
    side: z.enum(["LEFT", "RIGHT"]).optional(), subjectType: z.enum(["line", "file"]).optional(),
    startLine: z.number().nullable().optional(), originalLine: z.number().nullable().optional(),
    isResolved: z.boolean(), isOutdated: z.boolean(), comments: z.array(comment) })),
  reviews: z.array(z.object({ author, state: z.string(), submittedAt: z.string(), body: z.string() })).default([]),
});
const trimmed = (body: string) => ({ body: body.slice(0, 600), truncated: body.length > 600 });

/** Both chat harnesses report the same cached evidence, without fetching GitHub. */
export function compactThreads(raw: unknown, only: "mine" | "unresolved" | "all" = "all", file?: string) {
  const parsed = cacheSchema.safeParse(raw);
  if (!parsed.success) return { threads: [], reviews: undefined, error: "no_threads_cache" as const };
  const cache = parsed.data;
  return { fetchedAt: cache.fetchedAt,
    threads: cache.threads.filter(t => (!file || t.path === file) &&
      (only === "mine" ? t.comments.some(c => c.isMine) : only === "unresolved" ? !t.isResolved : true))
      .map(t => ({ id: t.id, path: t.path, line: t.line, side: t.side, subjectType: t.subjectType,
        startLine: t.startLine, originalLine: t.originalLine, resolved: t.isResolved, outdated: t.isOutdated,
        authorKinds: [...new Set(t.comments.map(c => c.author.bot ? "bot" : "human"))],
        comments: t.comments.map(c => ({ author: c.author.login, isMine: c.isMine, createdAt: c.createdAt, ...trimmed(c.body) })) })),
    ...(only === "all" && !file ? { reviews: cache.reviews.map(r => ({ author: r.author.login,
      state: r.state, submittedAt: r.submittedAt, ...trimmed(r.body) })) } : {}),
  };
}

export function cachedThreads(key: PrKey, only: "mine" | "unresolved" | "all" = "all", root?: string) {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(prDir(key, root), "threads.json"), "utf8")); } catch { /* Missing caches are normal before the first fetch. */ }
  return compactThreads(raw, only);
}

export function cachedCi(key: PrKey, root?: string) {
  const ci = readMeta(key, root).ci;
  if (!ci) return { state: null, checks: [], error: "no_ci_cache" as const };
  return { state: ci.state, headSha: ci.headSha, fetchedAt: ci.checkedAt,
    // The header cache retains normalized states, not raw conclusions or run times.
    checks: ci.checks.map(c => ({ ...c, conclusion: null, startedAt: null, completedAt: null })) };
}
