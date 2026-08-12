# Reviewer

A local-first pull request review assistant. It splits a PR diff into **review units** —
logical changes, each classified by kind and by how much attention it deserves — and gives
you a diff viewer built around them instead of around files. Review state (what you've read,
what changed since you read it) lives on your disk as an append-only event log, and GitHub is
treated as a write-only projection.

Two halves that couple through files on disk, not an API:

- a **web app** (diff viewer + GitHub sync), and
- a **Claude skill** (`skills/pr-review`) that produces the analysis.

## Prerequisites

- Node.js >= 20
- pnpm
- [`gh`](https://cli.github.com/), authenticated (`gh auth login`) — every GitHub read and
  write goes through it; the app never shells out to `git`.

## Install and build

```bash
pnpm install
pnpm -r build
```

## Run

```bash
pnpm dev          # server on http://localhost:4779, serving the built web app
```

Open <http://localhost:4779> and paste a PR URL to start tracking it.

`pnpm dev` runs the server only, against `packages/web/dist` — so run `pnpm -r build` first,
or rebuild the web app after changing it. For UI work with hot reload, run the two halves
separately: `pnpm dev` in one shell and `pnpm --filter @reviewer/web dev` in another, then use
<http://localhost:5179> (Vite proxies `/api` to port 4779). `pnpm --filter @reviewer/web dev:mock`
runs the UI against fixture data with no server at all.

## The skill

`skills/pr-review` turns a PR into the analysis the UI renders. Point Claude at a PR
("analyze this PR" + a URL) and it will:

1. `reviewer-state init <pr-url>` (or `refresh` for one already tracked),
2. read `revisions/<n>/diff.patch` and `files.json`,
3. write back a summary plus review units covering **every** hunk via
   `reviewer-state set-analysis <key> --file <json>`.

Coverage is enforced: `set-analysis` rejects the whole payload unless every hunk of the
current revision is either claimed by a unit or listed in `unassigned`. On later refreshes
the skill only classifies `new`/unassigned hunks rather than regenerating everything, and it
honors `classification-corrected` events — reclassifying a unit in the UI feeds back into
future analyses. `RUBRIC.md` in the skill directory holds the category definitions and is the
file to iterate on over time.

The CLI (`reviewer-state`, shipped by `packages/core`) is also usable directly:
`init`, `refresh`, `set-analysis`, `set-unit`, `view`, `report`, `list`, `sync`.

## State directory

`~/.reviewer/<host>/<owner>/<repo>/<number>/` (override the root with `REVIEWER_STATE_DIR`):

```
meta.json           # { host, owner, repo, number, url, title, createdAt }
events.jsonl        # append-only event log — the source of truth
state.json          # derived snapshot, refolded from events; safe to delete
comments.json       # local comments (draft -> pushed -> submitted)
review.json         # review body draft + pending review ids + last submission
revisions/<n>/      # one per observed (baseSha, headSha, mergeBase), 1-based
  diff.patch        # the diff exactly as GitHub served it (v3.diff)
  files.json        # parsed: files -> hunks with ids, added/removed lines, body text
  migration.json    # how the previous revision's hunks map onto this one (from r2 on)
```

Only `events.jsonl` is authoritative. `state.json` is a fold of it and is rebuilt on demand,
so hand-editing it does nothing; edit nothing here by hand at all — use the CLI.

## The review-unit and attention model

A **hunk** is identified by its content, not its position:
`sha256(path + addedLines + removedLines)`, truncated. That single decision is what makes the
rest work — when a PR is force-pushed, an untouched hunk keeps its id and keeps everything you
knew about it. A **review unit** is a set of hunks that form one logical change, possibly
spanning several files, carrying a `kind` (core-logic, connective-tissue, wiring, ripple,
tests, docs), an `attention` level (must-read, skim, skip) with a one-line justification, and
any risk flags (auth, migration, concurrency, money, external-call, security) that push
attention upward. You read the PR unit by unit in the suggested order rather than file by
file, which is what the diff pane is organized around.

On **refresh**, the new diff is fetched from GitHub and old hunks are matched onto new ones:
identical ids carry all state; otherwise the best fuzzy match within the same file (Jaccard
over added+removed lines, threshold 0.6 — small hunks also get a word-token Jaccard blended
in, so a single edited line still matches) carries state and is marked `fuzzy`; renames are
followed so state survives a moved file; unmatched old hunks are archived and pruned out of
their units; unmatched new hunks arrive `new` and unassigned, waiting for the skill. A hunk
you had already viewed stays viewed but gains `changedSinceViewed`, which surfaces in the UI
as a badge plus a word-level **diff-of-diffs** — the difference between the hunk as you read
it and the hunk as it is now, baselined on the revision you actually viewed rather than on
the previous one. A file counts as viewed only when all of its hunks in the current revision
are; that rollup is what `sync` pushes to GitHub as `markFileAsViewed`. Local state is always
the source of truth — remote state is read only to report drift, never to overwrite you.

## Finishing a review

Comments you draft on a line stay on your disk until you sync. Syncing puts them into your
**pending review** on GitHub — private, visible to nobody else, and still revocable — so a
comment is in one of three states: `draft`, `pushed`, `submitted`.

GitHub only allows one pending review per person per PR, so every sync reconciles first: it
looks your pending review up, creates one if there is none, and otherwise *appends* to the
existing one instead of trying (and failing) to create a second. That reconciliation is why
syncing twice is safe.

**Finish review** in the top bar opens the panel that ends the round. It shows the review body,
every comment that will go out with it, and a readiness summary — how many must-read units you
still have not read — right next to the three verdicts: **Approve**, **Request changes**,
**Comment**. Choosing one does not post: it arms a confirmation step that restates what is
about to happen, because submitting is public and cannot be undone. The server enforces the
same thing, refusing any submit that does not carry `confirm: true`.

Submitting pushes anything still in `draft` first, so your comments and your verdict land as a
single review rather than a verdict plus loose threads. On success the panel links to the
review on GitHub and a `review-submitted` event goes into the log. If you change your mind
before submitting, **discard pending review** deletes it on GitHub and returns its comments to
local drafts — nothing you wrote is lost.

Known failures are reported specifically rather than as a raw `gh` error: approving your own
PR, a stale `commit_id` after a force-push (refresh and retry), a comment anchored to a line
that has left the diff, and a pending review deleted from under you (recovered automatically,
once).

## Settings

The gear in the header (both on the PR list and inside a PR) opens `/settings`, where the
appearance lives. Every control applies immediately — there is no save button — and is stored
in this browser under the single `reviewer.settings` localStorage key, so preferences survive
reloads and stay in sync across open tabs. **Reset to defaults** puts everything back. The two
older standalone preferences (diff layout and line wrapping) were folded into the same store
and are migrated on first load, so nothing you had chosen is lost.

**Typography.** Pick the family used for the diff and every other code surface, its size
(11–16px), and the tab width (2/4/8, default 8). A checkbox extends the same family to the UI
chrome. Whatever you pick is always followed by a sensible fallback chain, so a misspelled
family degrades to the built-in monospace stack instead of to Times.

**Choosing an installed font.** *Choose from installed fonts…* uses the Local Font Access API
(`window.queryLocalFonts()`), which exists only in Chromium 103+ over a secure context —
localhost counts — requires a click, and asks for permission the first time; you must confirm
that browser prompt yourself. When it succeeds you get a filterable list of your font families,
each name rendered in its own font. When the API is missing, the permission is denied, or the
list comes back empty, the page says so inline and you still have (a) a curated list of common
monospace families and (b) a free-text box that accepts any family installed on your machine
by name.

**Themes.** A theme is a single palette that drives *both* shiki's syntax colors and the app's
own CSS custom properties — backgrounds, borders, diff add/remove tints, chips — which are
derived from that palette with contrast floors, so nothing goes unreadable on a light or
low-contrast theme. Shipped: the app's own dark and light look plus **Follow system** (the
default, which keeps the old `prefers-color-scheme` behavior), a set of bundled editor themes
(GitHub Dark/Light, One Dark Pro, Dracula, Nord, Tokyo Night, Catppuccin Mocha, Solarized
Dark/Light, Monokai), and the five Monokai Pro variants.

**Monokai Pro caveat.** The official Monokai Pro theme files are a commercial product, so they
are neither vendored nor downloaded here. The Classic / Octagon / Machine / Ristretto /
Spectrum entries are hand-authored TextMate themes built from each variant's widely published
palette values, and are labelled *community palette* in the picker — approximations, not the
real thing. Shiki's bundled `monokai` (the original, freely licensed) is offered separately.
