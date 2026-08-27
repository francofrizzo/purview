---
name: pr-review
description: Analyze a GitHub PR into a reviewable meta-structure — summary + classified review units — persisted in local reviewer state. Triggers on "analyze this PR", "prepare PR review", or a PR URL given with review intent.
---

# PR Review Skill

You turn a GitHub PR diff into a structured review plan: a short summary plus a set of
`ReviewUnit`s (logical changes, classified by kind and attention) that cover every hunk.
State lives on disk under `~/.purview/<host>/<owner>/<repo>/<number>/` and is mutated
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

All commands below are written as `reviewer-state <sub>`. The bin is usually **not** on
PATH; unless `reviewer-state` resolves, run it as `node packages/core/dist/cli.js <sub>`
(to get the short name, run `pnpm link --global` from `packages/core` once). Check which
works before proceeding.

State lives under `~/.purview/` unless `PURVIEW_STATE_DIR` (or the legacy `REVIEWER_STATE_DIR`) is set — if that env var is
set in your environment, the state root is that directory instead, and all paths below are
relative to it.

Subcommands that exist: `init`, `refresh`, `report`, `set-analysis`, `set-unit`, `view`,
`sync`, `list`. There are no others.

## 1. Determine state: init, refresh, or report

Given a PR URL (or an already-known `<key>`). Every `<key>` argument accepts
`host/owner/repo/number`, the short `owner/repo/number` (github.com implied), or a full
`https://github.com/owner/repo/pull/123` URL. `init` takes a **PR URL only**.

- To find out whether state exists, run `reviewer-state list` (lists every tracked PR with
  its revision and viewed counts). Do **not** rely on `report <key>` to tell you: for an
  unknown PR it does not error, it prints an empty `0/0 hunks` report.
- **No existing state**: `reviewer-state init <pr-url>`. This fetches PR meta + diff via
  `gh`, creates `meta.json`, `events.jsonl`, and `revisions/1/` (diff.patch, files.json).
  It prints the state dir and the current revision number — note them, you need the
  revision to read the diff. `init` is idempotent; on an existing PR it just refreshes.
- **Existing state, PR may have moved**: `reviewer-state refresh <key>`. This fetches the
  latest diff from GitHub, runs hunk migration against the previous revision, and prints a
  migration report (carried/fuzzy/renamed/archived/new counts). If nothing changed it
  prints only `No change; still at revision <n>.` See "On refresh" below — do not treat
  this the same as a fresh `init`.

Revisions are **1-based** (`revisions/1` is the first). Each holds `diff.patch`,
`files.json`, and — from revision 2 on — `migration.json`. To learn the current revision
number: it's printed by `init`/`refresh`, appears in the `report` header line
(`revision <n>  head=… base=… mergeBase=…`), and is `currentRevision` in
`reviewer-state report <key> --json`. There is no flag to print it alone.

## 2. Read the diff

Read `revisions/<current>/files.json`. It is `{revision, baseSha, headSha, mergeBase,
files[]}`, where each file is `{path, oldPath?, status, binary, hunks[]}` and each hunk is
`{id, file, oldStart, oldLines, newStart, newLines, header, addedLines, removedLines,
text}`.

Note `addedLines`, `removedLines` and `text` — `text` is the full hunk body (context,
`+` and `-` lines, without the `@@` header) exactly as GitHub served it. **The diff
content is already in files.json**, so both passes can work from it alone; `addedLines` /
`removedLines` also give you the size shape for free. Read
`revisions/<current>/diff.patch` (the raw unified diff) only when you need file-level
headers (mode/rename/binary markers) or want to see several hunks in file order.

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
  "units": [ /* ReviewUnit[] */ ],
  "unassigned": [ /* hunk ids deliberately left out of every unit */ ]
}
```

`ReviewUnit` fields: `id` (slug), `title`, `summary` (1-3 sentences), `kind`, `attention`,
`attentionWhy` (always exactly one concrete line — say *what* to check, not just the kind,
e.g. "Changes the discount rounding rule — verify it matches finance's spec" not "core
logic"), `order` (integer, suggested reading order, starting at 0 or 1 — be consistent),
plus `riskFlags` and `hunkIds` (arrays; both default to `[]` if omitted, but always write
them explicitly). `id`, `title`, `summary`, `kind`, `attention`, `attentionWhy` and
`order` are required — the schema rejects the payload if any is missing.

One more field, `findings`, is optional and is only ever filled in by the verification
pass (step 5). Leave it off entirely here.

Rules — the first two are **enforced by the CLI**, which rejects the whole payload:

- **Coverage: every hunk id of the current revision must appear either in some unit's
  `hunkIds` or in the top-level `"unassigned"` array.** `set-analysis` throws and writes
  nothing if any hunk is unaccounted for, listing the missing ids. Use `"unassigned"` for
  hunks you deliberately refuse to put in a unit; do not invent a junk-drawer unit.
- **No unknown ids**: every id you reference must belong to the current revision.
  Referencing an archived or stale id is a hard error.
- Aim for **exactly one unit per hunk**. Overlap is *not* rejected by the CLI, so this one
  is on you: cross-check that no hunk id appears twice.
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

## 5. Verification pass (only with a local checkout)

Classification tells the reviewer *where* to look. The verification pass answers the
questions that classification raises, so the reviewer doesn't have to chase them by hand.

**Gate — read this before doing anything else in this step.** The pass runs **only** when a
local checkout of the repo is available. The prompt that started you states whether there
is one and gives its path; if it says there is none, **skip this step entirely and produce
no `findings` at all**. Do not substitute the diff, `gh api` file fetches, or your own
recollection for a checkout: a finding is a claim you verified by reading code in a
checkout, and there is no weaker version of it. With no checkout, the questions simply stay
questions, phrased in `attentionWhy`.

With a checkout, for each **must-read** unit, ask whether its `attentionWhy` raises a
question that reading code could settle. The recurring shapes:

- *Do the callers handle this?* — a function gains a new error/return path, a new nullable
  field, a new thrown exception. Find every caller and check each one.
- *Does anything else construct or consume this shape?* — a struct/DTO/enum gains or loses
  a member; other constructors of the same shape may not have been updated.
- *Is the old path still referenced?* — a function, flag, config key or code path is
  replaced; check whether anything still reaches the old one.
- *Was a parallel site missed?* — the change fixes one of N structurally identical places
  (three handlers, five adapters); check the other N-1.

For each such question, **actually check it**: `grep` for the symbol across the checkout,
read the call sites you find. Then record one of two outcomes on that unit:

- **verified OK → a `note` finding.** State the answer, not the question: "all 3 callers
  map both error paths to 403" — with the files/lines you read as `evidence`. If that
  question was the *only* reason the unit was `must-read`, downgrade it to `skim` and
  rewrite `attentionWhy` to say what is left to check (e.g. "Shape only — the callers were
  verified, see findings"). Do not leave a unit `must-read` on the strength of a question
  you have already answered.
- **something is off → a `warning` finding.** State what you found and where: "`handleRefund`
  ignores the new `ErrRateLimited` and falls through to the success branch" with
  `evidence: "internal/billing/refund.go:212"`. A warning never changes `attention`
  downward, and may justify raising it.

A finding is `{"severity": "warning" | "note", "text": "...", "evidence": "..."}`; at most
5 per unit; `evidence` is required, non-empty, and is the concrete location(s) you read,
e.g. `internal/api/handler.go:88, internal/vep/client.go:41`. Units where you verified
nothing carry no `findings` key.

Read **"Findings discipline" in RUBRIC.md before writing a single finding.** It is the
guardrail against the failure mode this step invites: turning a verification pass into
unsolicited code review. Findings are annotations for the human reader. They never block,
never approve, and are never posted anywhere.

Budget this pass like step 3: it covers must-read units, not every unit, and it stops when
the checkable questions are answered — not when you run out of opinions.

## 6. Learn from corrections

**Before classifying**, read `events.jsonl` for recent `classification-corrected` events
(`{hunkId, from, to, note}`). Treat each as authoritative precedent: if a new hunk looks
like one that was previously corrected, classify it the corrected way, not the way your
heuristics would naively suggest. If you see a pattern of similar corrections (same
mistake repeated), add a worked example to RUBRIC.md's "Learned corrections" section so
future runs don't repeat it — see RUBRIC.md for the format.

## 7. Write the analysis

Write the JSON from step 4 to a temp file, then:

```
reviewer-state set-analysis <key> --file analysis.json
```

`--file` is required; pass `-` to read the JSON from stdin instead of a temp file. This
**replaces** the whole analysis for the current revision.

On success it prints `Analysis set for revision <n>: <u> units covering <h> hunks`. If the
CLI reports validation errors, fix the JSON and retry — do not hand-wave past a validation
failure. Common causes: a hunk id of the current revision missing from every unit's
`hunkIds` *and* from `"unassigned"` (the error lists the exact ids), a referenced id that
isn't in this revision, an invalid `kind`/`attention`/`riskFlags` enum value, or a missing
required field such as `attentionWhy` or `order`.

## 8. On refresh of an already-analyzed PR

See `MIGRATION-NOTES.md` for the full mechanics. In short:

1. Run `reviewer-state refresh <key>`. Read the printed migration report.
2. Classify **only** hunks the report marks `new` or unassigned. Carried, fuzzy-matched,
   and renamed hunks keep their existing unit membership — do not touch them.
3. Patch only the affected units with
   `reviewer-state set-unit <key> --id <unitId> --file patch.json` — the unit id is the
   `--id` **flag** (or an `id` field inside the JSON), not a positional argument. The file
   may be a partial patch (e.g. just `{"hunkIds": [...]}`); pass `-` for stdin. Add
   `--note "<why>"` when you are correcting a `kind`/`attention` — that note is recorded on
   the `classification-corrected` events. **Never regenerate the whole analysis** on a
   refresh.
4. If a revision is marked `baseOnly: true`, its new hunks get
   `defaultAttention: "skip"` / `defaultAttentionWhy: "base moved"` on their hunk state
   (shown in `report` as `(default skip: base moved)`). That default is informational only
   — it does not assign the hunk to anything, so such hunks keep showing up under the
   report's "Needs classification" list until you attach them. Leave them at the default
   attention unless one touches the files of an existing `must-read` unit, in which case
   classify it normally and attach it to that unit.
5. Unmatched old hunks are archived by the migration engine automatically — don't try to
   delete or re-home them yourself; just don't reference archived hunk ids in any unit you
   patch.
6. Findings from the previous pass are kept only on units whose hunks all carried over
   `identical`; migration drops them everywhere else, because the code they were verified
   against moved. Re-run step 5's verification (checkout permitting) for the units you are
   patching, and send the resulting `findings` array in the same `set-unit` patch. Don't
   re-assert a dropped finding from memory — re-check it.

## 9. Other commands (rarely yours to run)

- `reviewer-state report <key>` — human report: PR header, revision + shas, summary,
  migration report, hunk/file progress, per-unit progress bars, a "Needs classification"
  list of hunks in no unit, and recent archived hunks. Use it to verify your analysis
  landed. `--json` prints raw `state.json` instead (`currentRevision`, `units`, `hunks`,
  `files`, `unassignedHunkIds`, `archived`, `corrections`).
- `reviewer-state view <key> <hunkId|unit:<unitId>> [--unview]` — marks reading progress.
  That's the human reviewer's action (or the web app's); don't mark things viewed on the
  user's behalf unless asked.
- `reviewer-state sync <key>` — pushes the viewed-file projection to GitHub. **Never run
  this on your own initiative**; it writes to the PR.
- `reviewer-state list` — every PR with local state.

## 10. Report to the user

Finish every run (init or refresh) by printing, in the user's working language:

- The overall summary.
- A units table: `title | kind | attention | hunk count`, ordered by `order`.

Keep it scannable — this is the reviewer's map of the PR, not a restatement of the diff.
