---
name: pr-review
description: Analyze a GitHub PR into a reviewable meta-structure — summary + classified review units — persisted in local reviewer state. Triggers on "analyze this PR", "prepare PR review", or a PR URL given with review intent.
---

# PR Review Skill

You turn a GitHub PR diff into a structured review plan: a short summary plus a set of
`ReviewUnit`s (logical changes, classified by kind and attention) that cover every hunk.
State lives on disk under `~/.reviewer/<host>/<owner>/<repo>/<number>/` and is mutated
only through the `reviewer-state` CLI — never edit state files directly.

Read `RUBRIC.md` in this directory before classifying anything. It holds the kind
definitions, worked examples, the attention ladder, risk-flag triggers, and learned
corrections. Update it (see "Learn from corrections" below) as you go.

Read `MIGRATION-NOTES.md` before touching an already-analyzed PR (refresh flow).

## 0. CLI setup

The CLI ships from `@reviewer/core` (bin at `packages/core`). If `packages/core/dist` is
missing or stale, build it first:

```
pnpm --filter @reviewer/core build
```

All commands below assume `reviewer-state` resolves to that built CLI (workspace bin, or
`node packages/core/dist/cli.js` if not linked on PATH — check which works in this repo
before proceeding).

## 1. Determine state: init, refresh, or report

Given a PR URL (or an already-known `<key>` = `host/owner/repo/number`):

- If you don't know whether state exists, run `reviewer-state report <key>` first (or try
  it — a missing PR errors cleanly). Use this to check for an existing analysis before
  deciding your path.
- **No existing state**: `reviewer-state init <pr-url>`. This fetches PR meta + diff via
  `gh`, creates `meta.json`, `events.jsonl`, and `revisions/0/` (diff.patch, files.json).
- **Existing state, PR may have moved**: `reviewer-state refresh <key>`. This fetches the
  latest diff from GitHub, runs hunk migration against the previous revision, and prints a
  migration report (carried/fuzzy/renamed/archived/new counts). See "On refresh" below —
  do not treat this the same as a fresh `init`.

Both `init` and `refresh` create/select a revision directory:
`revisions/<n>/diff.patch` and `revisions/<n>/files.json`. `<n>` is the revision index —
resolve the latest one (check `reviewer-state report <key>` or the highest existing
`revisions/*` dir) before reading.

## 2. Read the diff

Read `revisions/<latest>/files.json` (parsed hunks with ids, per SPEC's `Hunk` shape:
`id, file, oldStart, oldLines, newStart, newLines, header`) and
`revisions/<latest>/diff.patch` (raw unified diff, exactly as GitHub served it).

`files.json` gives you hunk boundaries and identity; `diff.patch` gives you the actual
added/removed lines and surrounding context to read.

## 3. Cost-controlled two-pass analysis

Do not deep-read every hunk in a large PR. Two passes:

**Pass 1 — cheap bucketing.** Walk `files.json`: for every file+hunk, look only at the
path, the hunk header, and line-count stats (added/removed/context sizes). Using the
heuristics in `RUBRIC.md` (file path patterns, header keywords, size shape), bucket each
hunk into a *likely* kind and a *likely* attention. This pass should not require reading
full hunk bodies for hunks that are obviously wiring/docs/tests/generated/lockfile.

**Pass 2 — deep read.** Deep-read (full hunk body, plus surrounding function/file context
from the patch) for:
- every hunk bucketed as likely `core-logic` or `connective-tissue`,
- every hunk whose kind or attention is ambiguous after pass 1,
- every hunk that pass 1 flags as touching a risk-flag surface (auth, migrations,
  concurrency, money, external calls, secrets/crypto — see RUBRIC.md trigger list),
  regardless of its likely kind.

For very large PRs where a must-read hunk's correctness depends on code not shown in the
diff (e.g. a call site's full function, a type definition), read that surrounding context
from the repo. You do not need to check out the branch: use the diff's context lines first,
and fall back to `gh api repos/{owner}/{repo}/contents/{path}?ref={sha}` (or
`gh api repos/{owner}/{repo}/git/blobs/{sha}`) to fetch specific files at the PR's head SHA
when the diff's own context is insufficient. Don't fetch whole-file context for
skim/skip-bucketed hunks.

## 4. Build the analysis

Produce:

```json
{
  "summary": "short, plain-language overall summary",
  "units": [ /* ReviewUnit[] per SPEC */ ]
}
```

`ReviewUnit` fields (all required): `id` (slug), `title`, `summary` (1-3 sentences),
`kind`, `attention`, `attentionWhy` (always exactly one concrete line — say *what* to check,
not just the kind, e.g. "Changes the discount rounding rule — verify it matches finance's
spec" not "core logic"), `riskFlags` (array, may be empty), `hunkIds` (array), `order`
(integer, suggested reading order, starting at 0 or 1 — be consistent).

Rules, enforced by you before writing:

- **Every hunk in `files.json` is assigned to exactly one unit.** No hunk left out, no
  hunk in two units. Cross-check the union of all `hunkIds` against the full hunk id list
  before writing.
- Units are **logical changes**, not files. A unit may span multiple files (e.g. a
  function rename touches its definition and every call site as one unit) when they
  represent one decision.
- Grouping favors "one decision, one unit" — don't split a single behavior change into
  per-file units, and don't merge two unrelated decisions into one unit just because they
  touch the same file.
- **Ripple fallout** (mechanical consequences of another unit's change — renamed call
  sites, signature threading, updated imports because a type moved) gets its **own**
  `kind: "ripple"` unit. Its `summary` must name the driving unit by title so a reviewer
  knows why these hunks exist (e.g. "Call-site updates for the `renderTotal` signature
  change in 'Add currency parameter to renderTotal'").
- `order` should let a reviewer read core-logic and its direct dependents first, then
  connective-tissue, then wiring/ripple/tests/docs — dependency order, not file order.
- Risk flags can push `attention` up (see RUBRIC.md attention ladder) even for a unit
  that would otherwise be skim/skip — e.g. a one-line change to an auth check is
  must-read regardless of its size.

## 5. Learn from corrections

**Before classifying**, read `events.jsonl` for recent `classification-corrected` events
(`{hunkId, from, to, note}`). Treat each as authoritative precedent: if a new hunk looks
like one that was previously corrected, classify it the corrected way, not the way your
heuristics would naively suggest. If you see a pattern of similar corrections (same
mistake repeated), add a worked example to RUBRIC.md's "Learned corrections" section so
future runs don't repeat it — see RUBRIC.md for the format.

## 6. Write the analysis

Write the JSON from step 4 to a temp file, then:

```
reviewer-state set-analysis <key> --file analysis.json
```

If the CLI reports validation errors, fix the JSON and retry — do not hand-wave past a
validation failure. Common causes: a hunk id from `files.json` missing from every unit's
`hunkIds`, a hunk id appearing in two units, an invalid `kind`/`attention`/`riskFlags`
enum value, or a missing `attentionWhy`.

## 7. On refresh of an already-analyzed PR

See `MIGRATION-NOTES.md` for the full mechanics. In short:

1. Run `reviewer-state refresh <key>`. Read the printed migration report.
2. Classify **only** hunks the report marks `new` or unassigned. Carried, fuzzy-matched,
   and renamed hunks keep their existing unit membership — do not touch them.
3. Patch only the affected units with `reviewer-state set-unit <key> <unitId> --file
   patch.json` (add the new `hunkIds`, adjust `summary`/`attentionWhy`/`riskFlags` only if
   the new hunks change what's true about that unit). **Never regenerate the whole
   analysis** on a refresh.
4. If a revision is marked `baseOnly: true`, its new hunks default to `attention: "skip"`
   with `attentionWhy: "base moved"` — leave that default unless a new hunk in that
   revision touches the files of an existing `must-read` unit, in which case classify it
   normally and attach it to that unit (or a new one) instead of leaving it skip.
5. Unmatched old hunks are archived by the migration engine automatically — don't try to
   delete or re-home them yourself; just don't reference archived hunk ids in any unit you
   patch.

## 8. Report to the user

Finish every run (init or refresh) by printing, in the user's working language:

- The overall summary.
- A units table: `title | kind | attention | hunk count`, ordered by `order`.

Keep it scannable — this is the reviewer's map of the PR, not a restatement of the diff.
