import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnalysisEffortSchema, ClaudeModelSchema, configPath, stateRoot } from "@reviewer/core";

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
  /**
   * How many analysis runs may execute at once. Each run is its own `claude`
   * process, so this multiplies the *rate* of spend, never the total; 2 keeps
   * a big PR from making every later one wait out its whole wall time.
   * `PURVIEW_ANALYSIS_CONCURRENCY` overrides without editing the file.
   */
  analysisConcurrency: z.number().int().min(1).max(4).default(2),
  /**
   * Reasoning effort for analysis runs (`claude --effort`). Measured on a
   * 153-hunk PR: medium matched high's classification quality at ~10% less
   * wall time and ~15% less cost — thinking volume is the dominant cost of a
   * run, which is why "medium" (not the CLI's own default) is what a fresh
   * install gets.
   *
   * This is now a layered setting like `analysisModel` (see repo-config.ts):
   * `null` here means "inherit", which at this outermost layer resolves to
   * the built-in default above. To actually omit `--effort` — the escape
   * hatch for a `claude` CLI too old to know the flag — pin the value
   * `"none"` at whichever layer needs it; that is a real, distinct choice,
   * not the same thing as `null`.
   */
  analysisEffort: AnalysisEffortSchema.nullable().default("medium"),
  /**
   * Editor URL scheme for "open in editor" links from a definition peek (see
   * definitions.ts): `zed://file/<abs-path>:<line>` or
   * `vscode://file/<abs-path>:<line>`. Not layered like the model settings —
   * it is a machine preference, not something a repo or team would pin.
   */
  editor: z.enum(["zed", "vscode"]).default("zed"),
  /**
   * The secret for LAN access (`--lan`; see main.ts). *Whether* the server
   * listens on the network is a per-run decision and is deliberately not
   * stored — only the token is, because a device that scanned the QR code has
   * to keep working across restarts.
   *
   * It is the *whole* authentication for a LAN client: loopback is exempt (see
   * security.ts), so anything arriving over the network must present it. Minted
   * the first time `--lan` is used, and replaced only when the user asks.
   */
  lan: z.object({ token: z.string().nullable().default(null) }).default({}),
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
  // Once the file carries the LAN token it is a credential, so it must not be
  // world-readable. `mode` on writeFileSync only applies when the file is
  // created, hence the explicit chmod — and only ever downwards: a file that
  // never held a token keeps whatever permissions the user gave it.
  if (next.lan.token !== null) fs.chmodSync(file, 0o600);
  return next;
}

/**
 * Whether this run serves the LAN. A per-run decision on purpose: it changes
 * what the server binds to, so it belongs to the command that started it and
 * never to a file that could switch it on behind the user's back.
 * `PURVIEW_LAN=1` is the same switch for a non-interactive start.
 */
export function lanEnabled(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes("--lan") || env.PURVIEW_LAN === "1";
}

/**
 * The LAN token, minted and persisted the first time one is needed. A token
 * already on disk is never replaced here — devices that scanned an older QR
 * code must keep working across restarts; only an explicit regenerate
 * invalidates them.
 */
export function lanToken(root = stateRoot()): string {
  const existing = readConfig(root).lan.token;
  if (existing !== null) return existing;
  const token = generateLanToken();
  writeConfig({ lan: { token } }, root);
  return token;
}

/** 24 bytes of CSPRNG output — url-safe, so it survives a QR code and a query string. */
export function generateLanToken(): string {
  return crypto.randomBytes(24).toString("base64url");
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
