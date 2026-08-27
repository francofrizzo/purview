import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ClaudeModelSchema, configPath, stateRoot } from "@reviewer/core";

/**
 * `~/.purview/config.json` — the one piece of global (not per-PR) state.
 *
 * It is written by the first-run onboarding (see onboarding.ts) and read at
 * boot. Everything in it has a safe default, so a missing or corrupt file is
 * never fatal: the server behaves exactly as it did before the file existed.
 */

/**
 * Origins that are allowed to *send* state-changing requests even though they
 * are not the server's own origin. This exists for one case only: the Vite dev
 * server proxies `/api` to us, and http-proxy forwards the browser's original
 * `Origin` header (`changeOrigin` rewrites Host, not Origin), so a dev-mode
 * request arrives with the Vite origin on it.
 *
 * 5179 is this repo's configured Vite port; 5173 is Vite's own default, kept so
 * a stock `vite` invocation also works.
 */
export const DEFAULT_DEV_ORIGINS = ["http://localhost:5179", "http://localhost:5173"];

export const ConfigSchema = z.object({
  /** Consent for the automatic Claude analysis run on init/refresh. */
  autoAnalyze: z.boolean().default(true),
  /** ISO timestamp of the onboarding run that produced this file. */
  onboardedAt: z.string().optional(),
  /**
   * Extra origins accepted by the Origin check. This relaxes *who may send*
   * requests; it does not add any CORS response header, so it never lets a
   * foreign page read a response.
   */
  devOrigins: z.array(z.string()).default(DEFAULT_DEV_ORIGINS),
  /**
   * Machine-wide model defaults for the two kinds of Claude run. `null` means
   * "inherit", which at this (outermost) layer means the built-in default in
   * repo-config.ts — never the `claude` CLI's own default, which is exactly
   * what these settings exist to stop us from picking up.
   */
  analysisModel: ClaudeModelSchema.nullable().default(null),
  chatModel: ClaudeModelSchema.nullable().default(null),
});

export type ReviewerConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: ReviewerConfig = ConfigSchema.parse({});

export function configExists(root = stateRoot()): boolean {
  return fs.existsSync(configPath(root));
}

/**
 * Reads config.json, falling back to defaults for anything missing. A file that
 * is absent, unreadable or invalid yields the defaults rather than an error —
 * the server must always be able to boot.
 */
export function readConfig(root = stateRoot()): ReviewerConfig {
  const file = configPath(root);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[config] ignoring invalid ${file}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return { ...DEFAULT_CONFIG };
  }
  return parsed.data;
}

/** Merges `patch` over what is on disk (or the defaults) and writes it back. */
export function writeConfig(patch: Partial<ReviewerConfig>, root = stateRoot()): ReviewerConfig {
  const file = configPath(root);
  const next = ConfigSchema.parse({ ...(configExists(root) ? readConfig(root) : {}), ...patch });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * The env kill switch for automatic analysis. `PURVIEW_AUTO_ANALYZE=0` (or the
 * legacy `REVIEWER_AUTO_ANALYZE=0`) wins over every configuration layer, so a
 * user who wants a guaranteed-no-spend run gets one without editing any file.
 */
export function autoAnalyzeEnvAllows(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PURVIEW_AUTO_ANALYZE !== "0" && env.REVIEWER_AUTO_ANALYZE !== "0";
}

/**
 * Effective auto-analysis setting for the *global* layer alone. The per-repo
 * layering lives in repo-config.ts; this remains the answer for callers that
 * only have the global config in hand.
 */
export function resolveAutoAnalyze(
  config: Pick<ReviewerConfig, "autoAnalyze">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!autoAnalyzeEnvAllows(env)) return false;
  return config.autoAnalyze;
}
