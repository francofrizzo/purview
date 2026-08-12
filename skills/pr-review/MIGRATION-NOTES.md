# Migration Notes

Operator doc for what happens on `reviewer-state refresh <key>`, and what the skill is
allowed to touch afterward. Read this before running `refresh` on a PR that already has an
analysis.

## When migration runs

Triggered by `refresh` when the PR's `headSha` or `mergeBase` has changed since the last
recorded revision. The CLI fetches the diff fresh from GitHub (`gh api ... v3.diff`) —
never from local git — and creates a new `revisions/<n+1>/` directory with its own
`diff.patch` and `files.json`. Old revisions are kept, not overwritten.

## What carried / fuzzy / renamed / archived / new mean

- **carried** — the new revision has a hunk with the exact same `hunkId` (content-derived,
  see SPEC's hunk identity formula) as an old hunk. All state (viewed, unit membership)
  moves over unchanged.
- **fuzzy** — same file, no exact `hunkId` match, but Jaccard similarity over
  added+removed lines ≥ 0.6 against an old hunk. State carries over, but
  `changedSinceViewed` is set to `true` if the old hunk was viewed, and the migration
  report flags it so a reviewer knows the content shifted.
- **renamed** — GitHub's diff rename detection identifies the file as a rename; the hunk
  is matched to its old counterpart under the new path and then treated as (a) or (b)
  above.
- **archived** — an old hunk with no match in the new revision (removed/superseded).
  Kept in `events.jsonl` for history, dropped from the current unit's active `hunkIds`,
  listed in the migration report. Don't reference an archived hunk id when patching units.
- **new** — a new-revision hunk with no old counterpart. Either auto-attached to an
  existing unit by file adjacency (if the migration engine judged it obvious) or left
  unassigned for the skill to classify.

## What the skill must do on refresh

1. Run `refresh`, read the printed migration report (carried/fuzzy/renamed/archived/new
   counts + per-hunk list).
2. Classify **only** hunks marked `new` or left unassigned. Do not re-examine or
   reclassify carried/fuzzy/renamed hunks — their unit membership and attention already
   reflect prior human review context (including any `classification-corrected` events),
   and re-deriving them from scratch risks contradicting that history.
3. Patch only the units affected by new hunks, via `reviewer-state set-unit <key>
   <unitId> --file patch.json`. A "patch" here means updating that one unit's `hunkIds`
   (adding the new hunk) and, only if the new hunk changes what's true about the unit,
   its `summary` / `attentionWhy` / `riskFlags`. Units untouched by new hunks are not
   patched at all.
4. **Never regenerate the whole analysis.** Do not re-run the full two-pass process from
   SKILL.md step 3 over the entire diff on a refresh — that would silently discard
   accumulated viewed-state semantics and reviewer trust in the existing structure. The
   only exception is the very first `set-analysis` call on a PR that has no prior
   analysis at all (that's `init`'s flow, not `refresh`'s).

## `baseOnly` revisions

If `headSha` is unchanged but `mergeBase` moved (target branch advanced under an
unchanged PR head), the revision is marked `baseOnly: true`. New hunks in such a revision
default to `attention: "skip"` with `attentionWhy: "base moved"` — this is deliberate,
since these hunks aren't part of the PR author's actual changes, just base drift.

**Exception**: if a new hunk in a `baseOnly` revision touches a file that an existing
`must-read` unit already covers, don't leave it at the default skip — classify it
normally and attach it to that unit (or a new one) instead, since it may interact with
code a reviewer is already scrutinizing closely.

## What the skill must never do on refresh

- Never hand-edit `events.jsonl`, `state.json`, or any `revisions/*/files.json` /
  `diff.patch` directly — only `reviewer-state` CLI commands mutate state.
- Never delete or re-home archived hunks yourself; the migration engine already moved
  them out of active unit membership.
- Never touch units that have no new/unassigned hunks in them.
- Never overwrite the whole `units` array with `set-analysis` on a refresh — that command
  is for the initial full analysis only. Use `set-unit` for incremental patches.
