---
name: pr-review
description: Analyze a GitHub PR into a reviewable meta-structure — summary + classified review units — persisted in local reviewer state. Triggers on "analyze this PR", "prepare PR review", or a PR URL given with review intent.
---

# PR Review Skill

You turn a GitHub PR diff into a structured review plan: a short summary plus a set of
`ReviewUnit`s (logical changes, classified by kind and attention) that cover every hunk.
State lives on disk under `~/.purview/<host>/<owner>/<repo>/<number>/` and is mutated
only through the `reviewer-state` CLI — never edit state files directly.

<!-- Sections between `interactive-only` markers are for a person (or an interactive
agent) running this skill by hand; Purview's automatic analysis strips them and gives the
run the rest of this file, RUBRIC.md and (on a refresh) MIGRATION-NOTES.md inline.
`headless-only` comments hold the text that run gets instead. -->

<!-- interactive-only:start -->
Read `RUBRIC.md` in this directory before classifying anything. It holds the kind
definitions, worked examples, the attention ladder, risk-flag triggers, and learned
corrections. Update it (see "Learn from corrections" below) as you go.

Read `MIGRATION-NOTES.md` before touching an already-analyzed PR (refresh flow).

## 0. CLI setup (interactive only)

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

Subcommands that exist: `init`, `refresh`, `report`, `units`, `triage`, `show`, `changes`,
`base-file`, `set-analysis`, `set-unit`, `set-units`, `view`, `sync`, `list`,
`discard-revision`, `comment`. There are no others.

## 1. Determine state: init, refresh, or report (interactive only)

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
<!-- interactive-only:end -->

## 2. Read the diff

Run `reviewer-state triage <key>` first, in one Bash call. It prints a compact plain-text
overview built for exactly this: one line per file (path, status, hunk
count, +/- size, mechanical hints), one line per hunk (id, +/- size, truncated `@@` header,
moved-code marks), and a trailing `MOVED` section — readable whole even for a 450-hunk PR.
It ends with a `bodies:` line showing you the exact `show` invocation to fetch full hunk
text. This is Pass 1's raw material (see step 3). (`init`/`refresh` also save a copy as
`revisions/<n>/triage.txt`, but PRs initialized before that existed have none, and the
saved copy's `bodies:` line can't know your CLI path — prefer the command.)
On a refresh the hunks to classify are already known (see MIGRATION-NOTES.md), so `triage`
is optional there — run it only if you need the whole-PR overview.

When you need a hunk's full body (added/removed lines, complete text), fetch it with:

```
reviewer-state show <key> <selector...>
```

A selector is a hunk id (exact, or a unique prefix of 6+ chars — triage's ids are
already unique-prefix-friendly, and so are the 8-char short ids `units` and `changes`
print), an exact file path, a `*`/`**` glob over file paths, or `unit:<unitId>` (every hunk
that unit holds now). `--needs` adds every hunk that still needs classification (in no unit
and not explicitly unassigned) — on a refresh, that one flag fetches all the new hunks.
**Single-quote every glob selector** — unquoted, the shell expands it against your working
directory or fails outright (zsh: "no matches found") before `show` ever sees it:
`reviewer-state show <key> 'internal/**/*_test.go'`.
Pass every selector you need in **one call** — `show` is built to take many at once, so
batch Pass 2's whole selection into a single invocation rather than one hunk per call. Add
`--all` to dump every hunk of the revision when you genuinely need all of them.

Every body line carries a gutter with its real line numbers in the source file, old then new
(a context line has both, `-` only the old, `+` only the new):

```
=== internal/api/handler.go   3f9c2a1b   +1 -1   @@ func Handle(w http.ResponseWriter) {@@
88 90 │ 	if err != nil {
89    │-		return err
   91 │+		return fmt.Errorf("handle: %w", err)
```

Cite those numbers, not the position of a line in `show`'s output.

A result too big to print inline (over ~25 KB) is written to the PR's `scratch/` directory,
and `show` prints its path plus a table of contents: each file's line range in that file and
where each of its hunks starts (`3f9c2a1b@L120`). Read just the ranges you need with the
Read tool's offset/limit rather than paging through it; its lines carry the same gutter, and
a scratch file's own line numbers mean nothing.
Don't redirect `show` into a file yourself, and don't split one selection into several
small `show` calls to dodge the size: both just add turns.

**Never parse `files.json` or `diff.patch` with `python3 -c`, `node -e`, `jq`, or any other
ad-hoc one-liner.** `triage` and `show` already expose every field those hacks were
reaching for (path, status, hunk ids, headers, +/- sizes, full added/removed text, moved
marks) in one call each — reslicing the JSON
yourself is strictly more turns for the same information.

`files.json` (`{revision, baseSha, headSha, mergeBase, files[]}`, each file
`{path, oldPath?, status, binary, hunks[]}`, each hunk `{id, file, oldStart, oldLines,
newStart, newLines, header, addedLines, removedLines, text}`) is still the machine format
underneath `triage`/`show` and what `set-analysis`/`set-unit` validate hunk ids
against — but it is not the thing to read directly. Read `revisions/<current>/diff.patch`
(the raw unified diff) only when you need file-level headers (mode/rename/binary markers).

## Batching (applies to every investigation step below — 3, 5 and 8)

**Why: every extra assistant turn re-sends the whole accumulated context to the model.
Turn count, not tool time, is what an analysis run costs — batching your reads is the
single biggest lever on that cost.** A measured run spent 83% of its wall time waiting on
model latency across 130 turns while the tools themselves took ~23 seconds total.

Rules:

- **Plan the questions for a unit first, then answer as many as possible in ONE Bash
  call.** Join them with `&&` or `;`, use `grep -n -e pat1 -e pat2`, pass several files to
  one `grep`, stack several `sed -n '<a>,<b>p' file` ranges. Read the combined output in a
  single turn. Prefer over-fetching a little to paying a second round-trip: a few hundred
  extra output lines are far cheaper than another turn.
- **Never `cd`. Always use absolute paths.** Each Bash call is a fresh shell, so `cd` buys
  nothing and costs characters.
  - Bad (three turns, three `cd`s):
    ```
    cd /repo && grep -rn "renderTotal" src/
    cd /repo && sed -n '40,80p' src/billing/total.ts
    cd /repo && grep -rn "ErrRateLimited" src/
    ```
  - Good (one turn):
    ```
    grep -rn -e "renderTotal" -e "ErrRateLimited" /repo/src/; sed -n '40,80p' /repo/src/billing/total.ts
    ```
- **Group by file, not by unit.** When several units need checks in the same file (or the
  same symbol set), do them together in one pass instead of revisiting the file per unit.
- **Exploratory paging of `diff.patch` (or `files.json`) is a smell.** The full hunk text
  is one `reviewer-state show <key> <selectors>` call away — batch every hunk you need into
  that single call instead of re-slicing the patch or the JSON by hand. Go to `diff.patch`
  only for file-level headers (mode/rename/binary).
- Chained read-only commands (`grep`, `rg`, `sed -n`, `ls`, `cat`, `head`, `tail`, `wc`, plus
  the `reviewer-state` CLI) pass the permission allowlist. A chain that mixes in anything
  else (`git`, `gh`, `curl`, `python3`, `node`, `jq`, `rm`, a redirect that writes) is denied
  **as a whole** — so never put one of those in a chain, they will take the rest of the batch
  down with them.
- Type the CLI's full path in every call. Never store it (or any command) in a shell
  variable: `$CLI report` is not on the allowlist, and in zsh it does not even run.
- **Soft budget: finish a typical incremental analysis in under ~40 assistant turns.** If
  you are past that and still exploring, stop: write the analysis with what you have and
  record the unresolved question in that unit's `attentionWhy` (a question is a perfectly
  good deliverable — an unverified finding is not). Digging past the budget buys the
  reviewer less than getting the map on time.

## 3. Cost-controlled two-pass analysis

Do not deep-read every hunk in a large PR. Two passes:

**Pass 1 — cheap bucketing.** Walk the `triage` output: for every file+hunk line, look only at
the path, the mechanical hints (`lock`/`gen`/`docs`/`tests`/`snap`/`mig`), the truncated
`@@` header, the +/- size shape, and any `mv-in`/`mv-out` moved-code mark. Using the
heuristics in `RUBRIC.md` (file path patterns, header keywords, size shape), bucket each
hunk into a *likely* kind and a *likely* attention. This pass should not require reading
full hunk bodies for hunks that are obviously wiring/docs/tests/generated/lockfile — a
hint on the triage line is often enough on its own.

**Pass 2 — deep read.** Collect every selector Pass 1 flagged (see below) and fetch them
all with **one** `reviewer-state show <key> <selector...>` call. Deep-read (full hunk
body, plus surrounding function/file context from the patch) for:
- every hunk bucketed as likely `core-logic` or `connective-tissue`,
- every hunk whose kind or attention is ambiguous after pass 1,
- every hunk that pass 1 flags as touching a risk-flag surface (auth, migrations,
  concurrency, money, external calls, secrets/crypto — see RUBRIC.md trigger list),
  regardless of its likely kind.

For very large PRs where a must-read hunk's correctness depends on code not shown in the
diff (e.g. a call site's full function, a type definition), read that surrounding context
from the repo. Collect the whole pass's context needs first and fetch them in as few calls
as possible (see "Batching" above) rather than one file per turn. When the prompt names an
**exact checkout of the PR head**, read from it directly: it is the code exactly as this PR
leaves it, not a branch that may have drifted. For a file as it was *before* the PR, run
`reviewer-state base-file <key> <path>` (a renamed file may be given by its new or old
path; a file the PR added exits 1 with "not present at base"). Without such a checkout, use
the diff's context lines<!-- interactive-only:start --> first, and fall back to
`gh api repos/{owner}/{repo}/contents/{path}?ref={sha}` (or
`gh api repos/{owner}/{repo}/git/blobs/{sha}`) to fetch specific files at the PR's head SHA
when the diff's own context is insufficient<!-- interactive-only:end -->. Don't fetch whole-file context for
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

Rules — the first three are **enforced by the CLI**, which rejects the whole payload:

- **Coverage: every hunk id of the current revision must appear either in some unit's
  `hunkIds` or in the top-level `"unassigned"` array.** `set-analysis` throws and writes
  nothing if any hunk is unaccounted for, listing the missing ids. Use `"unassigned"` for
  hunks you deliberately refuse to put in a unit; do not invent a junk-drawer unit.
- **No unknown ids**: every id you reference must belong to the current revision.
  Referencing an archived or stale id is a hard error.
- **Exactly one unit per hunk**: a hunk id may appear in only one unit's `hunkIds` (and not
  also in `"unassigned"`). `set-analysis` rejects a duplicate, listing each id and the units
  it appears in. `set-unit` rejects a `hunkIds` patch that takes a hunk another unit already
  owns — to move a hunk, remove it from its current unit and add it to the new one in the
  same `set-units` batch (see MIGRATION-NOTES.md).
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
is one and gives its path — usually an exact checkout of the PR head, which is the best
case: what you read there is the code under review, and `reviewer-state base-file <key>
<path>` shows any file as it was before the PR. If the prompt says the checkout is on another
branch, treat what you read as possibly stale. If it says there is none, **skip this step
entirely and produce no `findings` at all**. Do not substitute the diff, `gh api` file fetches, or your own
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
read the call sites you find.

Do this in batches, not one grep per turn (see "Batching" above). Concretely: list the
symbols every must-read unit raises, `grep -rn` for all of them in **one** call
(`-e sym1 -e sym2 …`), then in a **second** call `sed -n` the line ranges around every hit
you need to read — several ranges, several files, one command. Two or three turns should
cover the evidence for a whole verification pass; a dozen means you are round-tripping.
Thoroughness is unaffected — check every question you would have checked, just fetch the
answers together.

Then record one of two outcomes on that unit:

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
e.g. `internal/api/handler.go:88, internal/vep/client.go:41`. A `path:line` is always the
**source file's** line — the new-side number from the `show` gutter, or the line in the
checkout file — never a line in a `scratch/` file. Units where you verified nothing carry no
`findings` key.

Limits: `text` 300 chars, `evidence` 200. The CLI truncates anything longer at a word
boundary and prints one warning line per truncated finding; it never rejects the payload
for length, so don't spend turns trimming.

Read **"Findings discipline" in RUBRIC.md before writing a single finding.** It is the
guardrail against the failure mode this step invites: turning a verification pass into
unsolicited code review. Findings are annotations for the human reader. They never block,
never approve, and are never posted anywhere.

Budget this pass like step 3: it covers must-read units, not every unit, and it stops when
the checkable questions are answered — not when you run out of opinions, and not past the
~40-turn soft budget.

## 6. Learn from corrections

<!-- interactive-only:start -->
**Before classifying**, read `events.jsonl` for recent `classification-corrected` events
(`{hunkId, from, to, note}`). Treat each as authoritative precedent: if a new hunk looks
like one that was previously corrected, classify it the corrected way, not the way your
heuristics would naively suggest. If you see a pattern of similar corrections (same
mistake repeated), add a worked example to RUBRIC.md's "Learned corrections" section so
future runs don't repeat it — see RUBRIC.md for the format.
<!-- interactive-only:end -->
<!-- headless-only
The run prompt lists this PR's `classification-corrected` events under CORRECTIONS (or says
there are none) — already extracted, so don't read `events.jsonl`. Treat each as
authoritative precedent: if a hunk looks like one that was previously corrected, classify it
the corrected way, not the way your heuristics would naively suggest.
-->

## 7. Write the analysis

Write the JSON from step 4 with the **Write tool** into the run's scratch directory
(`<state-dir>/scratch/` — the only writable location; the run prompt gives the absolute
path), then hand the CLI the file path:

```
reviewer-state set-analysis <key> --file <state-dir>/scratch/analysis.json
```

**Never inline JSON into a Bash command** — no heredocs, no `echo '{...}'`, no `--file -`
with piped input. The permission layer rejects any Bash command containing quoted braces
("expansion obfuscation"), and each rejected attempt wastes a full turn re-sending your
whole context. A file written once is also cheap to retry: the save command is one short
line.

This **replaces** the whole analysis for the current revision. Units are replaced
wholesale, so a unit's `changelog` (the per-revision "what changed" lines written on
refresh, see step 8) starts fresh unless the payload carries it.

On success it prints `Analysis set for revision <n>: <u> units covering <h> hunks`, then
what is left (hunks still needing classification, or "All hunks assigned") — no follow-up
`report` is needed to check. If the
CLI reports validation errors, fix the file with the **Edit tool** — a targeted edit, not
a rewrite — and re-run the same command. Do not hand-wave past a validation failure.
Common causes: a hunk id of the current revision missing from every unit's
`hunkIds` *and* from `"unassigned"` (the error lists the exact ids), a hunk id listed in
two units (the error names the units), a referenced id that isn't in this revision, an invalid `kind`/`attention`/`riskFlags` enum value, or a missing
required field such as `attentionWhy` or `order`.

## 8. On refresh of an already-analyzed PR

`MIGRATION-NOTES.md` is the one statement of the refresh flow — which hunks to classify,
which units to patch and with what, how to write the patches (`set-units`, one batch), and
what never to touch. Follow it; this skill's other steps apply to the hunks and units it
names. This is the flow the ~40-turn budget in "Batching" is sized for — an incremental run
touches a handful of units, so batch its reads and its re-verification the same way.

<!-- interactive-only:start -->
## 9. Other commands (interactive only; rarely yours to run)

- `reviewer-state units <key> [unitId...]` — compact listing of the units: id,
  attention/kind, title, hunk count, findings count, and each unit's hunk ids grouped by
  file (8-char short ids, accepted wherever a hunk id is). Husks are marked `~`.
- `reviewer-state set-unit <key> --id <unitId> --file patch.json` /
  `reviewer-state set-units <key> --file patches.json` — patch one unit, or several in one
  all-or-nothing batch; see MIGRATION-NOTES.md.
- `reviewer-state report <key>` — human report: PR header, revision + shas, summary,
  migration report, hunk/file progress, per-unit progress bars, a "Needs classification"
  list of hunks in no unit, and recent archived hunks. Use it to verify your analysis
  landed. `--json` prints raw `state.json` instead (`currentRevision`, `units`, `hunks`,
  `files`, `unassignedHunkIds`, `archived`, `corrections`).
- `reviewer-state triage <key> [--rev <n>]` — reprints `revisions/<n>/triage.txt` on
  demand (useful if you want a revision other than the current one; the file on disk
  always covers the current revision already).
- `reviewer-state show <key> <selector...> [--needs] [--rev <n>] [--all]` — prints full hunk
  bodies for the given selectors (hunk id/prefix, file path, single-quoted glob, or
  `unit:<id>`; `--needs` adds every hunk still needing classification), batched in one call,
  each line behind an old/new source line-number gutter.
- `reviewer-state changes <key> [--rev <n>]` — the changed units of a revision (see step 8):
  each one's current description, the hunk ids it holds now (by file), a compact
  before→after of its fuzzy/renamed hunks (diff of the two hunk bodies, `was│`/`now│` lines,
  capped at 30 lines per hunk — `show <id>` for the rest), its archived hunks with their old
  header and sizes, and related new/unassigned hunks as hints. Large output goes to a
  scratch file with a table of contents, like `show`.
- `reviewer-state view <key> <hunkId|unit:<unitId>> [--unview]` — marks reading progress.
  That's the human reviewer's action (or the web app's); don't mark things viewed on the
  user's behalf unless asked.
- `reviewer-state sync <key>` — pushes the viewed-file projection to GitHub. **Never run
  this on your own initiative**; it writes to the PR.
- `reviewer-state list` — every PR with local state.

## 10. Report to the user (interactive only)

Finish every run (init or refresh) by printing, in the user's working language:

- The overall summary.
- A units table: `title | kind | attention | hunk count`, ordered by `order`.

Keep it scannable — this is the reviewer's map of the PR, not a restatement of the diff.
<!-- interactive-only:end -->
