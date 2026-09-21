# Migration Notes

Operator doc for what happens on `reviewer-state refresh <key>`, and what the skill is
allowed to touch afterward. Read this before running `refresh` on a PR that already has an
analysis.

## When migration runs

Triggered by `refresh` when the PR's `baseSha`, `headSha` or `mergeBase` has changed since
the last recorded revision. The CLI fetches the diff fresh from GitHub (`gh api ... v3.diff`)
— never from local git — and creates a new `revisions/<n+1>/` directory with its own
`diff.patch`, `files.json` and `migration.json` (the machine-readable migration report).
Old revisions are kept, not overwritten. When nothing moved, `refresh` prints
`No change; still at revision <n>.` and does nothing else.

## What identical / fuzzy / renamed / archived / new mean

These are the five `status` values in `migration.json`. The report's header line groups the
first three as "carried".

- **identical** ("carried") — the new revision has a hunk with the exact same `hunkId`
  (content-derived, see SPEC's hunk identity formula) as an old hunk. All state (viewed,
  unit membership) moves over unchanged. Identical entries are **omitted** from the
  per-hunk list the CLI prints; only the counts line mentions them.
- **fuzzy** — same file, no exact `hunkId` match, but Jaccard similarity over
  added+removed lines ≥ 0.6 against an old hunk. State carries over, but
  `changedSinceViewed` is set to `true` if the old hunk was viewed, and the migration
  report flags it so a reviewer knows the content shifted.
- **renamed** — GitHub's diff rename detection identifies the file as a rename; the hunk
  is matched to its old counterpart under the new path and then treated as (a) or (b)
  above.
- **archived** — an old hunk with no match in the new revision (removed/superseded).
  Kept in `events.jsonl` for history, automatically dropped from every unit's active
  `hunkIds` (and from `unassignedHunkIds`) when the revision is folded into state, listed
  in the migration report and in `state.archived`. Don't reference an archived hunk id when
  patching units — `set-analysis` rejects unknown ids outright.
- **new** — a new-revision hunk with no old counterpart. It is **always left unassigned**;
  despite what SPEC suggests, the engine does no file-adjacency auto-attachment. Every new
  hunk is yours to classify, and shows up under "Needs classification" in
  `reviewer-state report <key>` until it's in a unit.

## What the skill must do on refresh

1. Run `refresh`, read the printed migration report (carried/fuzzy/renamed/archived/new
   counts + per-hunk list for everything except `identical`). The same report is on disk at
   `revisions/<n>/migration.json`, and `reviewer-state report <key>` reprints the current
   revision's one plus a "Needs classification" list.
2. `reviewer-state report <key>`'s "Needs classification" list is exactly the `new`/
   unassigned hunk ids. Fetch every one of their bodies with a **single**
   `reviewer-state show <key> <id1> <id2> ...` call, then classify those hunks. Do not
   re-group carried/fuzzy/renamed hunks — their unit membership and attention already
   reflect prior human review context (including any `classification-corrected` events),
   and re-deriving them from scratch risks contradicting that history.

   But **do** refresh the description of every *changed unit*. Run
   `reviewer-state changes <key>`: it lists each live unit (husks excluded) that this
   revision reworked — one of its current hunks migrated `fuzzy` (or `renamed` with
   different content), or a hunk it held was `archived` — with its current `summary` /
   `attentionWhy`, a compact before→after of each reworked hunk (diff of the old and new
   hunk bodies), the archived hunk ids with their old header and sizes, and new/unassigned
   hunks in the same files as hints only. A unit is also changed once you attach a `new`
   hunk to it. For each changed unit, in its one `set-unit` patch:
   - rewrite `title`, `summary` and `attentionWhy` to describe exactly the hunks the unit holds
     **now** (listed as "now holds" in the `changes` output). A unit that lost hunks is titled and
     summarized by what remains, not by what left; the history goes in the changelog only;
   - re-check `kind` / `attention` / `riskFlags` (a correction needs `--note`);
   - send a `changelogEntry`: a short note (a sentence or two) about what *this revision* changed in
     the unit (e.g. `"rounding switched to banker's; added a .5 test"`) — not a restatement
     of the summary. It is recorded under the state's current revision in the unit's
     `changelog`; re-sending replaces that revision's entry rather than adding another.
     Only runaway output is truncated;
   - re-verify its findings (see "What happens to findings").

   Units `changes` does not list and that take no new hunk are not patched at all.
3. Patch only the units affected by new hunks, via
   `reviewer-state set-unit <key> --id <unitId> --file patch.json` (unit id is the `--id`
   flag or an `id` field in the JSON; write patch.json with the Write tool into the scratch
   directory — never stdin/heredoc; `--note "<why>"` annotates a
   kind/attention correction). A "patch" here means updating that one unit's `hunkIds`
   (adding the new hunk — send the **full** resulting array, the patch replaces the field,
   it does not append) and, only if the new hunk changes what's true about the unit, its
   `summary` / `attentionWhy` / `riskFlags`. Units untouched by new hunks and not listed by
   `changes` are not patched at all. A hunk belongs to one unit only: `set-unit` rejects a `hunkIds` array that takes
   a hunk another unit still owns. To move one, patch its current unit without it first,
   then add it to the new unit.

   Two `set-unit` behaviors to know: patching an existing unit's `kind` or `attention` also
   emits a `classification-corrected` event for each of its hunks (that's the learning
   loop — pass `--note`), and a `--id` that matches no existing unit **creates** one — but
   only if the JSON is a complete `ReviewUnit` (every required field present); the CLI
   rejects a create with a missing field (e.g. no `kind`) instead of silently filling in
   defaults. So when you create a unit this way, send all the fields. Only when the `--id`
   already exists does the JSON act as a partial patch of just the fields you send.
4. **Never regenerate the whole analysis.** Do not re-run the full two-pass process from
   SKILL.md step 3 over the entire diff on a refresh — that would silently discard
   accumulated viewed-state semantics and reviewer trust in the existing structure. The
   only exception is the very first `set-analysis` call on a PR that has no prior
   analysis at all (that's `init`'s flow, not `refresh`'s). `set-analysis` replaces units
   wholesale, so it also starts every unit's `changelog` fresh unless the payload carries
   it.

## What happens to findings

A unit's `findings` (see SKILL.md step 5) are claims verified against a *specific* hunk
body, so migration treats them as perishable:

- Every hunk of the unit carried over **`identical`** → the code is byte-for-byte what was
  verified, so the findings carry over with the unit, untouched.
- **Anything else** — one hunk came over `fuzzy` or `renamed`, one was `archived`, or the
  unit picked up a hunk the report never mentioned → the whole unit's `findings` are
  **dropped** when the revision folds into state.

The rule is deliberately blunt: per-finding staleness would need to know which lines each
finding depended on, which nothing records. Dropping the unit's findings and letting the
incremental re-analysis of the new hunks re-verify them is the simplest rule that can never
leave a stale claim on the reviewer's screen — and a stale `note` saying "all callers
handle it" after the callers changed is worse than no note at all.

For the skill this means: after a refresh, a unit you are patching may have lost findings
it had before. Re-run the verification pass for it (checkout permitting) and send the fresh
`findings` array in the `set-unit` patch. **Never re-assert a dropped finding from memory**
— re-check it, or leave it off. Units you are not patching keep whatever survived; don't
patch a unit just to restore findings on it.

## `baseOnly` revisions

If `headSha` is unchanged but `baseSha`/`mergeBase` moved (target branch advanced under an
unchanged PR head), the revision is marked `baseOnly: true`, and the CLI says
`(base moved only)`. New hunks in such a revision get `defaultAttention: "skip"` /
`defaultAttentionWhy: "base moved"` recorded on their **hunk state** — this is a hint, not
a unit assignment: they are still unassigned and still listed under "Needs classification".
The hint is deliberate, since these hunks aren't part of the PR author's actual changes,
just base drift.

A fuzzy rework in a `baseOnly` revision came from the base branch, not the PR author. Such
a unit still shows up in `changes`, but a refresh does not start an analysis for it alone
(the server's auto-trigger ignores fuzzy-only changes on `baseOnly` revisions), and it
needs no description rewrite unless the drift changes what is true about the unit.

**Exception**: if a new hunk in a `baseOnly` revision touches a file that an existing
`must-read` unit already covers, don't leave it at the default skip — classify it
normally and attach it to that unit (or a new one) instead, since it may interact with
code a reviewer is already scrutinizing closely.

## What the skill must never do on refresh

- Never hand-edit `events.jsonl`, `state.json`, or any `revisions/*/files.json` /
  `diff.patch` / `migration.json` directly — only `reviewer-state` CLI commands mutate
  state. (`state.json` is a derived snapshot, folded from `events.jsonl`; edits to it are
  silently discarded on the next rebuild.)
- Never run `reviewer-state sync` off your own initiative — it writes viewed-state to the
  real PR on GitHub.
- Never delete or re-home archived hunks yourself; the migration engine already moved
  them out of active unit membership.
- Never touch units that have no new/unassigned hunks in them and that `changes` does not
  list.
- Never overwrite the whole `units` array with `set-analysis` on a refresh — that command
  is for the initial full analysis only. Use `set-unit` for incremental patches.
