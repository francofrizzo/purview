# Reviewer — v1 Spec (contract for all packages)

A local-first PR code-review assistant. Two halves: a web app (diff viewer + GitHub sync) and a Claude skill (analysis). They couple through **files on disk**, not an API.

## Repo layout (pnpm workspaces, TypeScript, ESM, Node 20+)

```
packages/core     # schemas (zod), hunk identity, diff parsing, migration engine, state store. No I/O deps beyond node:fs.
packages/server   # Hono localhost server. Serves web build, exposes REST over state files, shells out to `gh` for GitHub.
packages/web      # React + Vite + TypeScript. Diff viewer UI. Talks only to packages/server REST API.
skills/pr-review  # Claude skill (SKILL.md + reference docs). Reads/writes state files directly via CLI from core.
```

`packages/core` also ships a small CLI (`reviewer-state`) used by the skill: `init`, `refresh`, `set-unit`, `report`, `sync`.

## State directory

`~/.purview/config.json` — global settings, written by the first-run onboarding (see "First-run onboarding"):

```jsonc
{
  "autoAnalyze": true,        // consent: start a Claude analysis run when a PR is added/refreshed
  "analysisModel": null,      // "sonnet" | "opus" | "haiku" | null (null = built-in default)
  "chatModel": null,          // same, for review-chat turns
  "onboardedAt": "<iso>",     // when onboarding produced this file
  "devOrigins": ["http://localhost:5179", "http://localhost:5173"]  // extra allowed request origins
}
```
Every field defaults; a missing or invalid file yields the defaults and is never fatal. `PURVIEW_AUTO_ANALYZE=0` (legacy: `REVIEWER_AUTO_ANALYZE=0`) overrides `autoAnalyze` for one run.

The root is `~/.purview`, overridable with `PURVIEW_STATE_DIR` (legacy alias: `REVIEWER_STATE_DIR`).
It was `~/.reviewer` before the rename: on server and CLI startup, if `~/.reviewer` exists and
`~/.purview` does not, the directory is moved (one log line). If both exist, `~/.purview` wins
and the leftover is reported as a warning — nothing is merged automatically. The move carries
the legacy `config.json` with it. A configured root (env var) is never migrated into.

`~/.purview/<host>/<owner>/<repo>/` — per-repo, beside the numbered PR dirs:

```
repo.json           # { autoAnalyze: boolean|null, repoPath: string|null,
                    #   analysisModel: Model|null, chatModel: Model|null }  (null = inherit)
RUBRIC.local.md     # free-form markdown overlay, may be absent
<number>/           # one directory per PR (always digits, so it can never collide
                    # with a repo-level file name)
```

`repo.json` is created empty (all nulls) with the first PR of a repo, and is parsed
tolerantly: a corrupt file or a field of the wrong type falls back to `null`.

`~/.purview/<host>/<owner>/<repo>/<number>/`

```
meta.json           # { host, owner, repo, number, url, createdAt, title?, headRef?, repoPath?,
                    #   prState?, reviewDecision?, archived }
events.jsonl        # append-only event log (source of truth)
state.json          # derived snapshot, rebuilt from events; safe to delete
comments.json       # local draft comments (draft -> pushed -> submitted)
review.json         # review body draft + pending review ids + last submission
analysis-job.json   # latest Claude analysis run for this PR (see "Claude integration")
chat.json           # review-chat session id + transcript summary + per-chat model pin
revisions/<n>/      # one per observed (baseSha, headSha, mergeBase)
  diff.patch        # the diff exactly as GitHub served it (v3.diff)
  files.json        # parsed: files -> hunks with ids
  team-config.json  # cached read of the repo's committed .purview/ config at this head sha
```

## Configuration layering

Four places can configure a review, highest precedence first:

1. **PR meta** — `meta.json.repoPath` only (the per-PR checkout override);
2. **repo local** — `~/.purview/<host>/<owner>/<repo>/repo.json`;
3. **committed team config** — `.purview/config.json` in the *target* repo
   (`{autoAnalyze?, analysisModel?, chatModel?}`, unknown keys ignored);
4. **global** — `~/.purview/config.json`;
5. **built-in defaults** — `autoAnalyze: true`, no repo path, `analysisModel`/`chatModel`
   both `"sonnet"`.

`null`/absent means "inherit", which is why `repo.json`'s fields are nullable rather than
optional-with-a-default. One resolver (`packages/server/src/repo-config.ts`,
`effectiveConfig`) implements this and is used by the auto-analysis triggers, the checkout
resolution for Claude runs, and the config endpoints. It never makes a network call: the
committed layer is read from the per-revision cache. `PURVIEW_AUTO_ANALYZE=0` still overrides
every layer, and an **archived** PR never auto-analyzes at all.

The committed config is read from the resolved local checkout when there is one (free, and
already the right revision), otherwise via `gh api repos/{o}/{r}/contents/.purview/...` at the
PR's head sha, and is cached in the revision dir as `team-config.json` — one fetch per
revision, refreshed when a refresh creates a new revision.

**Rubric layering.** The rubric handed to analysis and chat runs is a stack, delimited and
ordered in the prompt: (1) the built-in skill `RUBRIC.md`, referenced by path; (2) the
committed `.purview/RUBRIC.md` ("team rubric — refines the above"), inlined; (3)
`RUBRIC.local.md` ("local overlay — highest precedence"), inlined. Later layers win where they
disagree. With no overlays the block is empty and the prompt is unchanged.

**Model layering.** `analysisModel` and `chatModel` resolve through the same chain (repo
local > committed > global > built-in `"sonnet"`); they are independent of each other, and the
global layer is nullable, so it too can say "inherit". Values are the CLI's own aliases —
`sonnet` | `opus` | `haiku` — never full model ids, which change with every release. Anything
else is rejected at every entry point. A chat session may additionally pin its own model
(`chat.json.model`), which outranks all of the above for that conversation only.

## Hunk identity

```
hunkId = sha256( normalizedPath + "\0" + addedLines.join("\n") + "\0" + removedLines.join("\n") ).slice(0, 16)
```
Context lines excluded. `normalizedPath` = new path (or old path if deleted). Content-derived, never positional. Collisions within a revision (identical hunks in same file): disambiguate with `#2`, `#3` suffix by order of appearance.

## Core types (zod schemas in packages/core, exported)

```ts
type Kind = "core-logic" | "connective-tissue" | "wiring" | "ripple" | "tests" | "docs";
type Attention = "must-read" | "skim" | "skip";
type RiskFlag = "auth" | "migration" | "concurrency" | "money" | "external-call" | "security";

interface Hunk { id: string; file: string; oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; }
interface Finding {
  severity: "warning" | "note";
  text: string;          // <= 300 chars
  evidence: string;      // <= 200 chars, required non-empty: the location(s) checked
}
interface ReviewUnit {
  id: string;            // slug
  title: string;
  summary: string;       // 1-3 sentences
  kind: Kind;
  attention: Attention;
  attentionWhy: string;  // one line
  riskFlags: RiskFlag[];
  hunkIds: string[];     // may span files
  order: number;         // suggested reading order
  findings?: Finding[];  // <= 5; only ever produced with a local checkout
}
interface HunkState {
  viewed: boolean;
  viewedAtRevision?: number;
  changedSinceViewed: boolean;   // true if content changed after viewed; keeps viewed=true, badge in UI
  predecessorId?: string;        // hunk in previous revision this one migrated from
  migration?: "identical" | "fuzzy" | "renamed" | "new";
}
```

### Events (events.jsonl, one JSON per line)

`{ ts, type, ...payload }` with types:
`pr-initialized`, `revision-added` {revision, baseSha, headSha, mergeBase},
`analysis-set` {revision, summary, units: ReviewUnit[]},
`unit-updated` {unitId, patch},
`hunk-viewed` / `hunk-unviewed` {hunkId, revision},
`unit-viewed` {unitId} (expands to its hunks),
`classification-corrected` {hunkId, from, to, note}  // feedback loop for the skill
`file-synced-github` {file, viewed: boolean},
`review-submitted` {event: APPROVE|REQUEST_CHANGES|COMMENT, url?, commentCount},
`analysis-started` {revision},
`analysis-finished` {revision, status: done|failed|cancelled, error?}

`state.json` = fold of events: current revision, units, per-hunk state, per-file rollup.

## Derived rules

- File is **viewed** iff all its hunks in current revision are viewed → then sync to GitHub (GraphQL `markFileAsViewed`). Local is source of truth; GitHub is a write-only projection (read on load only to detect drift, report it, don't overwrite local).
- Viewed hunk changes upstream → stays viewed, `changedSinceViewed: true`, UI shows badge + **diff-of-diffs** (old hunk content vs new hunk content, word-level).
- Unit completion = all its hunks viewed (changedSinceViewed hunks count as viewed but the unit shows a "changed" badge too).

## Migration (on refresh: new headSha or mergeBase)

1. Fetch new diff **from GitHub** (`gh api repos/{o}/{r}/pulls/{n} -H "Accept: application/vnd.github.v3.diff"`), store as new revision. Never use local `git diff`.
2. Match old hunks → new hunks: (a) identical hunkId → carry all state; (b) same file, best fuzzy match (Jaccard over added+removed lines, threshold 0.6; for small hunks — either side with ≤6 changed lines — blended with word-token Jaccard so single-line in-place edits still match) → carry, mark `fuzzy`, set changedSinceViewed if was viewed; (c) file renamed (GitHub rename detection in diff) → recompute with new path, treat as (a)/(b); (d) unmatched old → archive (kept in events, listed in report); (e) unmatched new → `new`, always left unassigned for the skill to classify.
3. Distinguish base-moved vs head-moved: if headSha unchanged but mergeBase moved, mark revision `baseOnly: true`; new hunks in such revisions default attention `skip` with why="base moved".
4. Emit migration report (carried/fuzzy/renamed/archived/new counts + per-hunk list) → stored in revision dir, printed by CLI.
5. **Findings staleness**: a unit keeps its `findings` only if *every* one of its hunks carried over `identical`. Any `fuzzy`/`renamed`/`archived` hunk (or a hunk the report never mentions) strips the whole unit's findings — the code they were verified against moved, and the incremental re-analysis of the changed hunks re-verifies what still holds. Per-finding staleness would need line provenance nothing records; this is the simplest rule that can never leave a stale claim on screen.

## Server REST (localhost:4779)

```
GET  /api/prs                          # list state dirs; items carry state/reviewDecision/
                                       # addedAt/archived/title alongside meta
POST /api/prs        {url}             # init: fetch PR meta + diff via gh, create state
POST /api/prs/:key/refresh             # fetch latest, run migration
GET  /api/prs/:key                     # state.json + current revision files.json + diff text
POST /api/prs/:key/hunks/:id/viewed    {viewed: bool}
POST /api/prs/:key/units/:id/viewed
POST /api/prs/:key/units/:id           # patch unit (reclassify -> also logs classification-corrected)
POST /api/prs/:key/archive {archived}  # shelve/unshelve a PR -> {ok, archived}
POST /api/prs/:key/sync                # push viewed files + un-pushed draft comments to GitHub
GET/POST /api/prs/:key/comments        # local drafts
PATCH /api/prs/:key/comments/:id  {body, confirm?}  # edit body: draft = local only; pushed/submitted = local + best-effort GraphQL remote update (submitted requires confirm: true)
DELETE /api/prs/:key/comments/:id      # delete locally; best-effort delete on GitHub if pushed
GET  /api/prs/:key/review              # local draft body + remote pending status + counts + readiness
POST /api/prs/:key/review   {body}     # save the review body locally
POST /api/prs/:key/review/submit       # {event, body?, confirm: true} -> submit on GitHub
DELETE /api/prs/:key/review/pending    # discard the remote pending review, reset comments to draft
```
```
GET  /api/repos                        # {repos: [{host, owner, repo, prCount, archivedCount,
                                       #  hasLocalConfig, hasCommittedConfig, repoPath}]}
GET  /api/config                       # {analysisModel, chatModel, defaults:{...}}
PUT  /api/config                       # {analysisModel?, chatModel?} -> same shape
GET  /api/repos/:rkey/config           # {local:{autoAnalyze, repoPath,
                                       #   analysisModel, chatModel, rubric},
                                       #  committed:{present, config, rubric},
                                       #  effective:{autoAnalyze, repoPath,
                                       #    analysisModel, chatModel}, sources}
PUT  /api/repos/:rkey/config           # {autoAnalyze?, repoPath?, analysisModel?,
                                       #  chatModel?, rubric?} -> same shape
```
`:rkey` = `host/owner/repo` URL-encoded. `local.rubric` is `RUBRIC.local.md` ("" when absent);
PUT with `rubric: ""` deletes the file, and `null` on a config field restores inheritance.
`GET /api/repos` is network-free, so `hasCommittedConfig` reflects the latest *cached* team
config. Note the split: `POST /api/prs/:key/repo-path` keeps writing the **PR-level**
override (unchanged, for compatibility), while `PUT /api/repos/:rkey/config` writes the
**repo-level** default.

`:key` = `host/owner/repo/number` URL-encoded. Server executes `gh` (assume authenticated); errors surface as JSON.

Review errors carry a specific `error` code rather than a generic gh failure:
`cannot_approve_own_pr` (422), `stale_commit_id` (422, force-push moved the head),
`comment_line_not_in_diff` (422), `pending_review_gone` (404), `confirmation_required` (400),
`invalid_event` (400).

### Hardening (all /api routes)

The API is unauthenticated, so access control is entirely "who may talk to it". CORS is not that: it gates response *reading*, not request *execution*, so a permissive CORS policy left every side effect (spawning Claude runs, posting comments, submitting a review) reachable from any web page. `confirm: true` is no defense — the attacker writes the body.

1. Bind `127.0.0.1` explicitly; never `0.0.0.0`.
2. `Host` must be `localhost` / `127.0.0.1` / `[::1]`, on the configured port or with no port. Anything else -> 403 `forbidden_host`, on every method (DNS-rebinding defense; covers the `/events` SSE GET too).
3. State-changing methods (POST/PATCH/PUT/DELETE): `Origin`, when present, must equal `http://localhost:<port>`, `http://127.0.0.1:<port>`, or a configured `devOrigins` entry -> else 403 `forbidden_origin`. Absent `Origin` passes (curl, the CLI). `Sec-Fetch-Site: cross-site|same-site` is rejected; `same-origin|none` corroborates a pass.
4. No CORS middleware: same-origin needs none, and emitting none is what keeps responses unreadable cross-origin. `devOrigins` relaxes only the Origin *check* — it adds no CORS response header. It exists because the Vite dev proxy forwards the browser's original `Origin` (`http://localhost:5179`) while `changeOrigin` rewrites only `Host`.
5. GETs carrying a foreign `Origin` are still served: they mutate nothing and, with no CORS headers, remain unreadable to the caller.

## First-run onboarding

`packages/server/src/onboarding.ts`. Runs before `serve()` when `~/.purview/config.json` is absent **and** stdout is a TTY; `--onboard` forces a re-run. Non-TTY or config present -> skipped silently, defaults apply.

Order: banner (3-line box, accent color) -> environment checks printed one line at a time (Node >= 20; `gh --version` + `gh auth status` with the detected login; `claude --version`; state dir writable), each failure carrying a one-line fix hint -> `gh` failing is a hard stop offering `Continue anyway? [y/N]`, `claude` failing is a warning only -> a plain statement that analysis and chat runs cost against the user's own Claude account, then a line saying analysis and chat both default to Sonnet and where to change it, then `Run an analysis automatically when you add a PR? [Y/n]` -> writes config.json -> summary box (state dir, port, URL, claude readiness).

node:readline + ANSI only, no TUI framework. Colors off under `NO_COLOR` or off a TTY. Check functions take an injected `Exec`; the prompt loop takes an injected `OnboardingIo`, so the whole flow is unit-testable without a terminal.

## Claude integration

The server drives the `claude` CLI headlessly for two features. One module
(`packages/server/src/claude-runner.ts`) owns every spawn; its stream-json output is parsed
into our own events, and the spawn itself is injectable so tests never call a model.

```
claude -p --output-format stream-json --verbose --safe-mode --strict-mcp-config \
       [--include-partial-messages] [--append-system-prompt <text>] [--add-dir <dir>]... \
       --tools <list> --allowedTools <rules>... --disallowedTools <rules>... \
       --model <sonnet|opus|haiku> \
       (--session-id <uuid> | --resume <uuid>)
```

**`--model` is always passed.** Inheriting the `claude` CLI's own default meant every analysis
and every chat turn silently billed at whatever model the user had configured, which for an
Opus default is an order of magnitude more than intended. Analysis uses the effective
`analysisModel`; chat uses the session's pin, else the effective `chatModel`. Verified against
the real CLI: the aliases resolve (`--model sonnet` -> `claude-sonnet-5`), and `--resume`
accepts a **different** `--model` than the session was started with, so switching a
conversation's model keeps its transcript.

The prompt goes over **stdin**, never argv (it can be large, and argv is logged). Auth is the
user's own Claude Code login; no API key is read, passed or stored. Runs are killable
(SIGTERM on cancel/timeout, SIGKILL 5s later); the analysis timeout is deliberately generous.

**Tool restriction.** Three mechanisms stack, verified against the real CLI:
`--tools` sets the built-in surface (`Read,Glob,Grep,Bash` — no Write/Edit anywhere);
`--allowedTools` allows Bash only for exact absolute-path prefixes of the `reviewer-state`
CLI; `--disallowedTools` denies the writing subcommands plus `gh`/`git`/`curl`/`wget` and the
web tools, and deny beats allow. In `-p` mode anything unmatched is denied outright (there is
no prompt to accept it), and a chained command (`node cli.js x; gh …`) is denied as a whole —
the permission parser does not match only the head. The analysis run therefore reaches the
CLI with heredoc-on-stdin (`--file -`) rather than writing a temp file.

**Analysis runs** use the PR state dir as cwd and may call `reviewer-state`
`report`/`list`/`set-analysis`/`set-unit`. **Chat runs** are read-only: `report`/`list` only.
Both prompts state that diff content is untrusted data whose embedded instructions must never
be followed; the chat system prompt additionally says the assistant has no write tools, may
draft comment text and reclassification proposals for the human to apply, and must never
claim to have posted anything.

**Analysis jobs.** One record per PR in `analysis-job.json`:
`{revision, status: queued|running|done|failed|cancelled, queuedAt?, startedAt?, finishedAt?,
error?, progress?}`. A single in-process slot runs them; on server start any record left
`running`/`queued` is closed out as `failed` with `error: "server restarted"`. Triggers: after
a successful `POST /api/prs` always, after `POST /api/prs/:key/refresh` only when the
migration left new/unassigned hunks, both skippable with `?analyze=false`.

**Chat.** One resumable CLI session per PR (`--session-id` on the first turn, `--resume`
after), with `chat.json` holding `{sessionId, model, messages: [{role, text, ts, refs?}]}`.
`model` (`null` = follow the layered `chatModel`) is the conversation's own pin; it takes
effect on the **next** message and does not restart the session. Requests
may carry typed refs — `unit`/`hunk`/`file`/`line-range`/`comment` — which the server resolves
against the current revision into a compact delimited block prepended to the message. An
unresolvable ref fails the send with `unresolvable_ref` and persists nothing. A turn outlives
its HTTP request: if the client disconnects, the run finishes and still writes `chat.json`.

**PR state.** `prState` (`open`/`draft`/`merged`/`closed`, collapsed from GitHub's
`state` + `merged` + `draft`) and `reviewDecision` (`approved`/`changes_requested`/
`review_required`/`null`) are captured into `meta.json` on init and on every refresh — there
is no background polling. REST does not expose a review decision, so it comes from one extra
cheap GraphQL query whose failure degrades to `null` rather than failing the refresh.

**Local repo path.** `meta.json.repoPath` (optional, back-compatible) points at any path
inside a checkout — main or worktree, validated with `git rev-parse --show-toplevel`, so a
`.git` *file* works — and is stored verbatim. Which checkout it means is resolved **per run**
(`git worktree list --porcelain`), so worktrees created or removed later are picked up: a
worktree whose branch is the PR's head ref (`meta.headRef`) wins, else one whose HEAD is the
current revision's `headSha`, else the stored checkout is used and flagged as
`checkoutMismatch: {checkedOutBranch, prHeadRef}` — surfaced on the repo-path response and
`GET /api/prs/:key`, and stated in the prompt ("surrounding code may not match the diff"). A
deleted or de-gitted path degrades to "no local checkout" with a warning; runs never fail over
it. When a checkout is used, chat runs take it as cwd with the state dir as an extra root.

## Server REST — Claude endpoints

```
GET    /api/prs/:key/analysis-job          -> {job: JobRecord | null}
POST   /api/prs/:key/analyze               -> {job}   409 if queued/running
DELETE /api/prs/:key/analyze               -> {job}   409 if nothing in progress
POST   /api/prs/:key/repo-path {path}      -> {ok, path, warning?}   400 if dir missing
GET    /api/prs/:key/chat                  -> {messages, sessionId, busy, model,
                                              configuredModel, configuredModelSource,
                                              sessionModel}
POST   /api/prs/:key/chat {text, refs?}    -> SSE stream
POST   /api/prs/:key/chat/model {model}    -> {model, configuredModel, configuredModelSource,
                                              sessionModel, restartedSession}
                                              model: alias | null (null = inherit); 400 otherwise
DELETE /api/prs/:key/chat                  -> {ok: true}   (drops the model pin too)
GET    /api/prs/:key/events                -> SSE {type:"analysis-job", job} per transition,
                                              heartbeat comment every 15s
```

Chat SSE events: `delta {text}` (append), `tool {name, detail}` (activity line),
`done {message:{role,text,ts}}`, `error {error}`. `GET /api/prs` items and `GET /api/prs/:key`
also carry `analysisJob: JobRecord|null`.

## Review lifecycle

A comment moves through three states, tracked in `comments.json`:

```
draft      local only, never sent anywhere
pushed     lives in the viewer's PENDING review on GitHub; private, still revocable
submitted  the review carrying it was submitted; public
```

GitHub allows **one pending review per user per PR**, so every push reconciles first:

1. resolve the viewer's login (`gh api user`, cached per host);
2. `GET /repos/{o}/{r}/pulls/{n}/reviews` and look for the viewer's `PENDING` review. REST is
   used rather than GraphQL because it returns both ids we need in one call — `id`
   (databaseId, taken by the submit/delete REST endpoints) and `node_id` (taken by the
   GraphQL append mutation);
3. **no pending review** -> `POST /pulls/{n}/reviews` with `{commit_id, comments}` and no
   `event`, creating one;
4. **pending review exists** -> append each draft with GraphQL
   `addPullRequestReviewThread(pullRequestReviewId, path, line, side, body)`. REST has no way
   to grow an existing pending review: creating another 422s, and `POST /pulls/{n}/comments`
   posts publicly outside the review.

Both ids, plus the review body, are persisted in `review.json`:

```json
{ "body": "", "pendingReviewId": "PRR_…", "pendingReviewDatabaseId": 123,
  "lastSyncedAt": "…", "submittedAt": "…", "submittedEvent": "APPROVE", "submittedUrl": "…" }
```

Submitting pushes any un-pushed drafts first (so comments and verdict land as one review),
then either `POST /pulls/{n}/reviews/{id}/events {event, body}` when a review is pending, or
`POST /pulls/{n}/reviews {event, body, commit_id}` when there is nothing pending and nothing
to attach. `confirm: true` is mandatory — submitting is public and irreversible. If GitHub
answers 404 because the pending review was deleted out of band, the cached id is dropped, the
comments revert to drafts and the submit is retried exactly once. On success every pushed
comment becomes `submitted` and a `review-submitted {event, url, commentCount}` event is
appended to the log.

Discarding (`DELETE /api/prs/:key/review/pending`) deletes the pending review on GitHub and
returns its comments to `draft`, so nothing the reader wrote is lost.

## Web UI (single PR view; PR list as landing)

- Left sidebar: review units ordered by `order`, grouped by attention (must-read / skim / skip collapsed), each with kind chip, risk flags, progress (viewed hunks / total), changed badge.
- Main: unit-centric diff view — clicking a unit shows its hunks (possibly from several files, with file headers), syntax-highlighted (shiki), word-level intra-line diff, virtualized list.
- Hunk actions: mark viewed (checkbox), view diff-of-diffs when changedSinceViewed, draft a comment on a line.
- File tree tab as alternate navigation with per-file viewed rollup.
- Top bar: PR title/link, refresh button (runs migration, shows migration report toast/panel), sync button, comments drawer, **finish review** panel, summary panel (skill's overall summary).
- Finish review panel: review body textarea, the comments that will be included (file:line + status), readiness summary ("2 must-read units still unviewed"), and Approve / Request changes / Comment. Picking a verdict only arms an explicit confirmation step — it never posts directly. Shows the submitted review's link on success, and surfaces + allows discarding a pending review.
- Keyboard: j/k next/prev hunk, v toggle viewed, space next unviewed.
- Settings route (`/settings`, gear in the header of both the list and the PR view): appearance preferences — code/UI font family (Local Font Access API when the browser offers it, curated list + free-text family otherwise), code font size, tab width, and the color theme. Every control applies live; a reset restores the defaults.
- Preferences store (`src/lib/settings.tsx`): one typed object under the `reviewer.settings` localStorage key, exposed via React context + `useSettings()`, parsed migration-tolerantly (unknown/invalid keys fall back to defaults), synced across tabs through the `storage` event. It subsumes the older standalone `reviewer.diffViewMode` / `reviewer.diffWrap` keys, whose values are migrated on first load.
- Themes (`src/lib/themes.ts`): one palette object per theme drives both shiki's syntax colors and the app-chrome CSS custom properties, which are derived from that palette (contrast-floored, so diff tints and chips stay legible on every theme). Ships the app's own dark/light pair (the default, following `prefers-color-scheme`), a handful of bundled editor themes, and hand-authored Monokai Pro palette approximations — the official Monokai Pro theme files are commercial and are not vendored.
- Style: clean, dense, dark-mode-first. No component library bloat; Tailwind ok.

## Skill (skills/pr-review/SKILL.md)

Trigger: user asks to analyze/review a PR. Flow:
1. `reviewer-state init <pr-url>` (or `refresh`).
2. Read `revisions/<n>/diff.patch` + `files.json`. For large diffs: cheap pass (paths, stats) to bucket, deep-read only likely must-read.
3. Produce analysis: overall summary (short, plain language) + ReviewUnits covering **every** hunk (spanning files where the change is one logical unit). Write via `reviewer-state set-unit` / `analysis-set` JSON.
4. On refresh with existing analysis: only classify `new`/unassigned hunks, adjust affected units, never regenerate everything.
5. Read `classification-corrected` events and honor them; `RUBRIC.md` in the skill dir holds category definitions + worked examples and is the file to iterate over time.

Classification rubric (seed for RUBRIC.md): core-logic = behavior/domain decisions; connective-tissue = glue with logic (adapters, mappers, non-trivial plumbing); wiring = registrations, DI, exports, imports, config plumbing with no logic; ripple = mechanical fallout of a change (renames at call sites, signature threading); tests = tests/evals/fixtures; docs = docs/comments/README.
Attention: must-read = wrong here breaks things or encodes decisions; skim = verify shape, don't trace; skip = mechanical, reviewed by construction. Risk flags override attention upward.

**Verification pass → findings.** Gated on a local checkout being resolvable for the run (the analysis prompt states the path, or states there is none). With one: for each must-read unit whose `attentionWhy` raises a question code can settle — do the callers handle the new error path, does anything else construct this shape, is the old path still referenced, was a parallel site missed — the skill actually checks it in the checkout and records the outcome as a `Finding` on the unit: a `note` when verified OK (and, if that question was the only reason the unit was must-read, `attention` drops to `skim` with `attentionWhy` rewritten), a `warning` when something is off. Without a checkout the pass is skipped entirely and **no** findings are produced; nothing is ever inferred from the diff alone. A finding must be verified, cite its evidence, and be material enough to change what the reviewer writes; style opinions, unchecked "might"s, restatements of the code and architecture editorializing are never findings, and a question code cannot settle stays a question in `attentionWhy`. Findings never block, approve, or post anywhere — they are local annotations. `attentionWhy` stays one line; verification outcomes live in `findings`.

## Non-goals for v1

No bidirectional comment-thread sync (drafts push-only; threads authored elsewhere are never read back), no stacked PRs, no multi-PR dashboards, no auth (localhost only), no GitLab.
