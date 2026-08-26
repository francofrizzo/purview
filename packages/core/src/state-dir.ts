import fs from "node:fs";
import path from "node:path";
import { legacyStateRoot, stateRoot, stateRootIsDefault } from "./paths.js";

/**
 * One-time move of the state directory after the `~/.reviewer` -> `~/.purview`
 * rename.
 *
 * Three cases, and only one of them touches the disk:
 *   - only the legacy dir exists  -> rename it, so nothing is lost and nothing
 *     has to be merged;
 *   - both exist                  -> the new one wins (it is what everything
 *     reads) and the leftover is reported, because silently ignoring a
 *     directory full of somebody's review state is worse than one warning;
 *   - neither / only the new one  -> nothing to do.
 *
 * It is deliberately non-fatal: a failed rename (permissions, a cross-device
 * `$HOME`) degrades to a warning and the app boots on the new, empty root.
 */
export interface StateDirMigration {
  from: string;
  to: string;
  moved: boolean;
  /** One line to log on success. */
  message?: string;
  /** One line to log when the move was skipped or failed. */
  warning?: string;
}

export function migrateStateDir(
  from: string = legacyStateRoot(),
  to: string = stateRoot(),
): StateDirMigration {
  const base: StateDirMigration = { from, to, moved: false };
  if (path.resolve(from) === path.resolve(to)) return base;
  if (!fs.existsSync(from)) return base;

  if (fs.existsSync(to)) {
    return {
      ...base,
      warning:
        `both ${to} and the legacy ${from} exist; using ${to}. ` +
        `Nothing was moved — merge or delete ${from} yourself.`,
    };
  }

  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { ...base, moved: true, message: `moved state directory ${from} -> ${to}` };
  } catch (err) {
    return {
      ...base,
      warning:
        `could not move the legacy state directory ${from} to ${to}: ` +
        `${(err as Error).message}. Move it by hand to keep your review state.`,
    };
  }
}

/**
 * Run the migration and log its one line. Called from both entry points (the
 * server and the CLI) before anything reads state.
 */
export function migrateStateDirOnStartup(
  log: { info: (s: string) => void; warn: (s: string) => void } = {
    info: (s) => console.log(s),
    warn: (s) => console.warn(s),
  },
): StateDirMigration {
  // An explicit root (tests, `PURVIEW_STATE_DIR`) is never migrated *into*:
  // moving somebody's real `~/.reviewer` into a scratch directory because an
  // env var was set would be catastrophic and silent.
  if (!stateRootIsDefault()) {
    return { from: legacyStateRoot(), to: stateRoot(), moved: false };
  }
  const result = migrateStateDir();
  if (result.message) log.info(`[purview] ${result.message}`);
  if (result.warning) log.warn(`[purview] ${result.warning}`);
  return result;
}
