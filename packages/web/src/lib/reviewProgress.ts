import { isGeneratedUnit, isRemovedUnit, type Attention, type FileEntry, type HunkState, type ReviewUnit } from "../api/types";
import { CHANGE_KINDS, changeKindOf, type ChangeKind } from "./changeMix";

/**
 * How far the reading has come, weighed by changed lines: a one-line import
 * and an 80-line function are not the same amount of reading. Hunks of
 * generated files are not review work and count nowhere. A hunk no unit
 * claims reads as skim: it still wants a look, nothing said it matters. A
 * hunk its unit marks skip counts nowhere, as everywhere else (the unit's
 * ring, "mark unit viewed", Space): nothing ever marks it read.
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
  const skipped = new Set<string>();
  for (const u of live) {
    for (const e of u.hunks) {
      if (e.skip) skipped.add(e.id);
      else if (!attentionOf.has(e.id)) attentionOf.set(e.id, u.attention);
    }
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
      if (skipped.has(h.id) && !attentionOf.has(h.id)) continue;
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

export interface KindProgress {
  kind: ChangeKind;
  /** changed lines of the kind, and of those: read, and read before a revision changed them */
  lines: number;
  read: number;
  reread: number;
  hunks: number;
  hunksRead: number;
  /** its hunks still to read, in diff order */
  unread: { id: string; path: string }[];
}

/**
 * The same reading split by what the lines are, as the change mix sorts
 * them: implementation, tests, docs, generated. Generated files are shown
 * here (they are read like any other), never owed; skipped hunks count
 * nowhere, as by attention. Kinds with no lines are left out.
 */
export function reviewProgressByKind(
  files: FileEntry[],
  hunks: Record<string, Pick<HunkState, "viewed" | "changedSinceViewed"> | undefined>,
  units: Pick<ReviewUnit, "id" | "hunks" | "origin" | "removedAtRevision">[],
): KindProgress[] {
  const live = units.filter((u) => !isGeneratedUnit(u) && !isRemovedUnit(u));
  const claimed = new Set<string>();
  const skipped = new Set<string>();
  for (const u of live) for (const e of u.hunks) (e.skip ? skipped : claimed).add(e.id);
  const groups = new Map<ChangeKind, KindProgress>(
    CHANGE_KINDS.map((kind) => [kind, { kind, lines: 0, read: 0, reread: 0, hunks: 0, hunksRead: 0, unread: [] }]),
  );
  for (const f of files) {
    for (const h of f.hunks) {
      if (!f.generated && skipped.has(h.id) && !claimed.has(h.id)) continue;
      const g = groups.get(f.generated ? "generated" : changeKindOf(f, h))!;
      const weight = changedLines(h);
      const state = hunks[h.id];
      g.lines += weight;
      g.hunks++;
      if (state?.viewed) {
        g.read += weight;
        g.hunksRead++;
      } else {
        if (state?.changedSinceViewed) g.reread += weight;
        g.unread.push({ id: h.id, path: f.path });
      }
    }
  }
  return [...groups.values()].filter((g) => g.lines > 0);
}
