import { isGeneratedUnit, isRemovedUnit, type Attention, type FileEntry, type HunkState, type ReviewUnit } from "../api/types";

/**
 * How far the reading has come, weighed by changed lines: a one-line import
 * and an 80-line function are not the same amount of reading. Hunks of
 * generated files are not review work and count nowhere. A hunk no unit
 * claims reads as skim: it still wants a look, nothing said it matters. A
 * unit's own skipped hunks read as skip.
 */
export interface GroupProgress {
  attention: Attention;
  /** changed lines in the group, and of those: read, and read before a revision changed them */
  lines: number;
  read: number;
  reread: number;
  hunks: number;
  hunksRead: number;
  /** the group's units, and how many have every hunk read */
  units: number;
  unitsDone: number;
}

export interface ReviewProgress {
  groups: GroupProgress[];
  /** read share of must-read and skim lines, 0–100; skip is shown, never owed */
  percent: number;
  /** every must-read and skim hunk is read */
  done: boolean;
}

/** `+` and `-` lines; a hunk without its body (never in practice) weighs one. */
export function changedLines(h: { lines?: string[] }): number {
  if (!h.lines) return 1;
  let n = 0;
  for (const l of h.lines) if (l[0] === "+" || l[0] === "-") n++;
  return Math.max(1, n);
}

export function reviewProgressByAttention(
  files: { generated?: FileEntry["generated"]; hunks: { id: string; lines?: string[] }[] }[],
  hunks: Record<string, Pick<HunkState, "viewed" | "changedSinceViewed"> | undefined>,
  units: Pick<ReviewUnit, "id" | "attention" | "hunks" | "origin" | "removedAtRevision">[],
): ReviewProgress {
  const live = units.filter((u) => !isGeneratedUnit(u) && !isRemovedUnit(u));
  const attentionOf = new Map<string, Attention>();
  // A hunk the unit marks skip reads as skip, whatever the unit's attention.
  for (const u of live) {
    for (const e of u.hunks) if (!attentionOf.has(e.id)) attentionOf.set(e.id, e.skip ? "skip" : u.attention);
  }

  const blank = (attention: Attention): GroupProgress => ({
    attention, lines: 0, read: 0, reread: 0, hunks: 0, hunksRead: 0, units: 0, unitsDone: 0,
  });
  const groups: Record<Attention, GroupProgress> = {
    "must-read": blank("must-read"),
    skim: blank("skim"),
    skip: blank("skip"),
  };
  const counted = new Set<string>();
  for (const f of files) {
    if (f.generated) continue;
    for (const h of f.hunks) {
      counted.add(h.id);
      const g = groups[attentionOf.get(h.id) ?? "skim"];
      const weight = changedLines(h);
      const state = hunks[h.id];
      g.lines += weight;
      g.hunks++;
      if (state?.viewed) {
        g.read += weight;
        g.hunksRead++;
      } else if (state?.changedSinceViewed) {
        g.reread += weight;
      }
    }
  }
  for (const u of live) {
    const own = u.hunks.filter((e) => !e.skip && counted.has(e.id)).map((e) => e.id);
    if (!own.length) continue;
    const g = groups[u.attention];
    g.units++;
    if (own.every((id) => hunks[id]?.viewed)) g.unitsDone++;
  }

  const owed = groups["must-read"].lines + groups.skim.lines;
  const read = groups["must-read"].read + groups.skim.read;
  const done = groups["must-read"].hunksRead === groups["must-read"].hunks && groups.skim.hunksRead === groups.skim.hunks;
  return {
    groups: [groups["must-read"], groups.skim, groups.skip],
    // Floor, so 100% only ever means done.
    percent: owed ? (done ? 100 : Math.min(99, Math.floor((read / owed) * 100))) : 100,
    done,
  };
}
