# Purview

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
- [`claude`](https://claude.com/claude-code), signed in, for the automatic analysis and the
  review chat (see below). Everything else works without it.

## Install and build

```bash
pnpm install
pnpm -r build
```

## Run

```bash
pnpm start        # build if sources changed, (re)start the server on http://localhost:4779
```

`pnpm start` detects stale builds, rebuilds what changed, stops a previously running
Purview server on the port, and starts the new one. Use it both for first runs and
after `git pull` — it is always safe to re-run.

Open <http://localhost:4779> and paste a PR URL to start tracking it.

For development, `pnpm dev` runs the server only (no rebuild) against the existing
`packages/web/dist`.

## First run

The first time the server starts in a terminal with no `~/.purview/config.json`, it runs a
short onboarding before it listens:

```
  ╭─ P U R V I E W ────────────────────────╮
  │ a local-first pull request review desk │
  ╰────────────────────────────────────────╯

  Checking your environment

  ✓ Node.js >= 20 — v24.16.0
  ✓ gh installed + authenticated — logged in as octocat
  ✓ claude CLI available — 2.1.243 (Claude Code)
  ✓ state directory writable — /Users/you/.purview
```

Each check that fails prints a one-line fix (an install URL, `gh auth login`). A missing or
logged-out `gh` is a hard stop — nothing loads without it — so it asks whether to continue
anyway; a missing `claude` is only a warning, since it costs you the automatic analysis and
the review chat and nothing else.

Then it asks for consent about cost, plainly: adding a PR starts a Claude analysis run
automatically and every chat message starts another, both on **your own Claude account or
subscription** through the `claude` CLI you are already signed into, both on Sonnet unless you
change it (settings → Claude, or per repo). Answering the `[Y/n]` writes `autoAnalyze` to the
config, and it finishes with a box telling you the state
dir, the port and the URL to open.

It only runs once. It is skipped silently when the config already exists or when stdout is
not a TTY (a service manager, a script, CI), where the defaults apply. `node
packages/server/dist/index.js --onboard` re-runs it at any time. Colors follow `NO_COLOR`
and are dropped off a TTY.

`~/.purview/config.json` is the whole of it:

```jsonc
{
  "autoAnalyze": true,                       // start an analysis run when a PR is added
  "analysisModel": null,                     // "sonnet" | "opus" | "haiku" | null (= sonnet)
  "chatModel": null,                         // same, for review chat
  "onboardedAt": "2026-08-26T12:51:24.500Z",
  "devOrigins": ["http://localhost:5179",    // origins allowed to send state-changing
                 "http://localhost:5173"]    // requests, for the Vite dev proxy
}
```

Every field has a safe default, so a missing or corrupt file just means "defaults".

`pnpm dev` runs the server only, against `packages/web/dist` — so run `pnpm -r build` first,
or rebuild the web app after changing it. For UI work with hot reload, run the two halves
separately: `pnpm dev` in one shell and `pnpm --filter @reviewer/web dev` in another, then use
<http://localhost:5179> (Vite proxies `/api` to port 4779). `pnpm --filter @reviewer/web dev:mock`
runs the UI against fixture data with no server at all.

Reviewer is installable as a PWA: with the app open in Chrome, click the install icon in the
address bar (or Menu → Install Reviewer...). It's served over `http://localhost`, which browsers
treat as a secure context, so the service worker registers without HTTPS. Offline support is
shell-only — the static app (JS/CSS/icons) is precached and loads without a network, but all
`/api/*` calls (PR data, chat, SSE) still require the local server to be running; the service
worker never caches or intercepts them.

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

## Claude integration

The skill flow above also runs by itself. The server drives the `claude` CLI headlessly
(reusing your existing Claude Code auth — there are no API keys anywhere) for two things:

**Automatic analysis.** Tracking a new PR queues an analysis run immediately; refreshing one
queues another only when the migration actually produced hunks nobody has classified yet.
Runs are one-at-a-time, their status lives in `analysis-job.json`
(`queued`/`running`/`done`/`failed`/`cancelled`), and the UI follows them live over
`GET /api/prs/:key/events`. You can trigger one by hand (`POST …/analyze`), cancel it
(`DELETE …/analyze`), or opt a single init/refresh out with `?analyze=false`. Set
The automatic triggers follow the layered `autoAnalyze` setting (repo, then the repo's
committed config, then `~/.purview/config.json`, answered during onboarding and default on) —
see [Per-repo configuration](#per-repo-configuration). `PURVIEW_AUTO_ANALYZE=0` overrides every
layer and disables them for that run, and an archived PR never triggers one.

**Review chat.** One resumable Claude session per PR, stored in `chat.json`. You can attach
typed references to a question — a unit, a hunk, a file, a line range, one of your draft
comments — and the server resolves them against the current revision into a context block
prepended to your message; a reference it cannot resolve fails the whole send rather than
quietly dropping it.

**Which model.** Both kinds of run pass `--model` explicitly, so nothing inherits whatever
your `claude` CLI happens to default to — a habit that quietly billed every analysis and every
chat turn at an Opus rate. The default for both is **Sonnet**. Set them per repo (repo
settings → Analysis), for the whole machine (settings → Claude), or for your team by
committing them; the layering is the one described in
[Per-repo configuration](#per-repo-configuration). Only the CLI aliases `sonnet`, `opus` and
`haiku` are accepted — full model ids change with every release.

A single conversation can also override the model from the chat panel's header, which applies
from your next message on. The conversation is kept: the CLI resumes a session happily under a
different model.

Both run with a deliberately small tool surface. The analysis run gets file reads plus Bash
limited to the `reviewer-state` CLI's read and write-analysis subcommands; the chat run is
strictly read-only (reads plus `reviewer-state report`/`list`). `gh`, `git`, network fetches
and the editing tools are denied outright in both, so neither can write to GitHub — the chat
assistant can *draft* a comment or a reclassification for you to apply, and is told to never
claim it posted anything. Diff content is labelled untrusted data in both prompts: text
inside a diff is never treated as instructions.

**Local checkout (optional).** `POST /api/prs/:key/repo-path {path}` points a PR at a local
clone, which is then a readable root for Claude so it can see code the diff only shows in
fragments. A missing directory is rejected; a checkout whose `origin` does not match the PR's
repo is accepted with a warning.

It is **worktree-aware**, for a worktree-per-branch workflow: give it any path inside the
repository — the main checkout, a worktree, or a subdirectory of either — and before each run
it asks git which worktree currently has the PR's branch (or its head commit) checked out and
hands Claude that one. Worktrees you create later are picked up automatically, since nothing
is resolved until a run starts. If no worktree matches, the stored checkout is used anyway,
the response and `GET /api/prs/:key` carry `checkoutMismatch: {checkedOutBranch, prHeadRef}`,
and Claude is told the surrounding code may not match the diff. A checkout that has been
deleted or is no longer a git repo just means "no local checkout" — it never fails a run.

## Per-repo configuration

Settings live in four layers, most specific first:

| Layer | Where | Sets |
| --- | --- | --- |
| PR | `meta.json` | `repoPath` only — the per-PR checkout override |
| Repo (local) | `~/.purview/<host>/<owner>/<repo>/repo.json` | `autoAnalyze`, `repoPath`, `analysisModel`, `chatModel` |
| Team (committed) | `.purview/config.json` in the reviewed repo | `autoAnalyze`, `analysisModel`, `chatModel` |
| Global | `~/.purview/config.json` | `autoAnalyze`, `analysisModel`, `chatModel`, `devOrigins` |

Anything left `null` inherits from the layer below, down to the built-in defaults
(`autoAnalyze: true`, no checkout, both models `sonnet`). `PURVIEW_AUTO_ANALYZE=0` still beats every layer, and an
archived PR never starts an analysis run on its own.

The committed layer is the one your team shares. Put it in the repo you review:

```
.purview/config.json    { "autoAnalyze": false, "chatModel": "haiku" }   # unknown keys ignored
.purview/RUBRIC.md      # rubric refinements for this codebase
```

It is read from your local checkout when one is configured, and otherwise fetched with
`gh api repos/{owner}/{repo}/contents/.purview/...` at the PR's head sha. Either way the
result is cached per revision (`revisions/<n>/team-config.json`), so it costs one read per
revision and is picked up again whenever you refresh.

**Rubrics stack.** Analysis and chat runs get the built-in skill rubric first, then the
committed `.purview/RUBRIC.md` ("refines the above"), then your own `RUBRIC.local.md`
("highest precedence"), clearly delimited and in that order. Write house rules in the local
overlay without touching the repo, or ship them to the team by committing them.

```
GET  /api/repos                 # every tracked repo: PR counts, which layers are set
GET  /api/repos/:rkey/config    # local + committed + effective, with the source of each
PUT  /api/repos/:rkey/config    # {autoAnalyze?, repoPath?, analysisModel?, chatModel?,
                                # rubric?}; null re-inherits, rubric: "" deletes RUBRIC.local.md
GET  /api/config                # the global layer: {analysisModel, chatModel, defaults}
PUT  /api/config                # {analysisModel?, chatModel?}; null re-inherits
```

`:rkey` is `host/owner/repo`, URL-encoded. `POST /api/prs/:key/repo-path` is unchanged and
still writes the **PR-level** checkout override; the repo-level default is written here.

## PR status and archiving

`GET /api/prs` carries each PR's `state` (`open`/`draft`/`merged`/`closed`), `reviewDecision`
(`approved`/`changes_requested`/`review_required`/`null`), `addedAt`, `archived` and `title`.
Both GitHub-side values are captured when you add a PR and on every refresh — there is no
background polling, so a refresh is what moves them. The review decision comes from a small
GraphQL query (REST has no such field); if it fails, it degrades to `null` instead of failing
the refresh.

`POST /api/prs/:key/archive {archived: boolean}` shelves a PR: it keeps every byte of its
state and stays fully readable, it just leaves the active list and can no longer trigger an
automatic analysis run.

## State directory

`~/.purview/<host>/<owner>/<repo>/<number>/` (override the root with `PURVIEW_STATE_DIR`;
`REVIEWER_STATE_DIR` still works). `~/.purview/config.json` sits beside the per-repo trees and
holds the settings above.

The state directory used to be `~/.reviewer`. On startup — server or CLI — it is moved to
`~/.purview` if the old one exists and the new one does not, taking `config.json` with it and
logging one line. If both exist, `~/.purview` is used and the leftover is reported; nothing is
merged behind your back.

Per repo, beside the numbered PR directories (PR dirs are always digits, so they can never
collide with these):

```
repo.json           # { autoAnalyze, repoPath, analysisModel, chatModel }   null = inherit
RUBRIC.local.md     # your own rubric overlay for this repo, optional
```

The rest is per PR:

```
meta.json           # { host, owner, repo, number, url, title, createdAt, headRef?, repoPath?,
                    #   prState?, reviewDecision?, archived }
events.jsonl        # append-only event log — the source of truth
state.json          # derived snapshot, refolded from events; safe to delete
comments.json       # local comments (draft -> pushed -> submitted)
review.json         # review body draft + pending review ids + last submission
analysis-job.json   # status of the latest Claude analysis run
chat.json           # review-chat session id + transcript summary + model pin
revisions/<n>/      # one per observed (baseSha, headSha, mergeBase), 1-based
  diff.patch        # the diff exactly as GitHub served it (v3.diff)
  files.json        # parsed: files -> hunks with ids, added/removed lines, body text
  migration.json    # how the previous revision's hunks map onto this one (from r2 on)
  team-config.json  # cached read of the repo's committed .purview/ config at this head sha
```

Only `events.jsonl` is authoritative. `state.json` is a fold of it and is rebuilt on demand,
so hand-editing it does nothing; edit nothing here by hand at all — use the CLI.

## Security model

The server is unauthenticated by design — it is yours, on your machine — which makes *who is
allowed to talk to it* the whole of the security model. It listens on `127.0.0.1` only, never
on `0.0.0.0`, so nothing on your network can reach it.

That still leaves the browser. Any page you have open can send a cross-origin request to
`http://127.0.0.1:4779`; CORS only decides whether the *response* can be read, so the request
runs either way. Here that would mean a random tab spawning Claude analysis runs on your
account, posting comments, or submitting a review — and `confirm: true` protects nothing
against that, because the attacker writes the body. So every `/api` request is checked twice:

- **Host** must be `localhost`/`127.0.0.1`/`[::1]` on the port we are actually serving. That
  is the DNS-rebinding defense: an attacker who repoints their own domain at 127.0.0.1 still
  sends `Host: their-domain`, which browsers do not let them forge.
- **Origin** must be our own origin for anything that changes state (POST/PATCH/PUT/DELETE).
  A request with no `Origin` at all is allowed — that is `curl` and the CLI, and a browser
  always attaches one to a cross-origin state-changing request. `Sec-Fetch-Site: cross-site`
  or `same-site` is rejected outright. GETs are left to the Host check alone: they mutate
  nothing, and with no CORS headers on the response a foreign page cannot read what came
  back, so blocking them would buy nothing.

There is no CORS middleware at all — same-origin needs none, and emitting none is what keeps
responses unreadable to other pages. The one relaxation is `devOrigins` in `config.json`: the
Vite dev proxy forwards the browser's original `Origin` (`http://localhost:5179`), so that
origin is accepted as a *sender*. It adds no CORS response header — the proxy already makes
everything same-origin as far as the browser is concerned.

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
appearance lives, plus a **Claude** section with the machine-wide analysis and chat model
defaults (those two are stored on the server, not in the browser). Every control applies
immediately — there is no save button — and the appearance half is stored in this browser
under the single `reviewer.settings` localStorage key, so preferences survive
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
