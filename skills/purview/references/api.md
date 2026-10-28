# Purview API, the parts this skill uses

Base: `http://localhost:${PURVIEW_PORT:-4779}/api`. Loopback requests need no token.
JSON in, JSON out. `<key>` is `host/owner/repo/number` URL encoded (or an encoded PR URL).

## Errors

Every error is `{ "error": "<code>", "detail": "<sentence>" }` with an HTTP status:

| Status | Code | Meaning |
|---|---|---|
| 400 | `missing_url`, `invalid_body`, `invalid_revision` | the body or path was wrong; the message says what |
| 404 | `not_found` | the PR is not tracked (or the file/revision does not exist) |
| 409 | `no_analysis` | the PR has no analysis yet (export) |
| 409 | `analysis_in_progress` | a run is queued or running; cancel it or wait |
| 409 | `chat_busy` | a chat reply is streaming; wait |
| 502 | `gh_failed` | GitHub refused or `gh` is not logged in; relay the message |

A refused connection is not an error payload: Purview is not running.

## `GET /prs`

`{ prs: [item] }`, one item per tracked PR:

```
key              "github.com/acme/billing/482"
title            PR title
state            "open" | "closed" | "merged"
reviewDecision   GitHub's, or null
authoredByYou    boolean
archived         boolean (the PR), repoArchived (its whole repo)
currentRevision  number, the latest revision Purview holds
summary          the analysis's one-paragraph summary, "" before an analysis
progress         { hunks: {viewed,total}, units: {complete,total}, files: {viewed,total} }
analysisJob      job (below) or null
diffSize         { additions, deletions } or null
meta.tag         optional global tag, lowercase, normalized spaces, 1–24 characters
meta             { url, title, author, headRef, baseRef, createdAt, prState, ... }
```

Say "not analyzed" when `summary` is empty and no job is running.

## `POST /prs`  body `{ "url": "https://github.com/acme/billing/pull/482" }`

Tracks the PR and starts its analysis (unless auto-analysis is off in the user's
config). Append `?analyze=false` only when the user asked not to analyze. Returns:

```
key, created (false when it was already tracked), unarchived, revision,
state (the full state, large; you rarely need it),
analysisJob (null unless a run started), sharedAnalysis (set when a teammate's
analysis was imported from the PR instead of running one)
```

## `GET /prs/<key>`

`{ state, files, diff, meta, analysisJob, ... }`. Large: `diff` is the whole patch.
Prefer `GET /prs` for status and `analysis/export` for the analysis. Reach for this
only for `meta` of one PR or `state.revisions` (each `{ revision, headSha, baseSha,
mergeBase, summary? }`, where `summary` is the one-line note a refresh writes for
revisions after the first).

## `POST /prs/<key>/refresh`

Fetches the PR from GitHub. Returns `{ key, revision, added (a new revision was
recorded), baseOnly, report (what moved between revisions, or null), analysisJob
(a run started for the new work, or null), analysisSkipped ("archived" |
"disabled" | null) }`. "Nothing new" is `added: false`.

## `POST /prs/<key>/archive`  body `{ "archived": true | false }`

`{ ok, archived }`. Archiving keeps everything readable; it leaves the active list
and stops automatic runs. Adding an archived PR again unarchives it.

## `POST /prs/<key>/analyze`  body `{}` or `{ "fresh": true }`

`{ job }`. Without `fresh` the run is incremental (keeps units, classifies new
hunks). `fresh` discards the structure and starts over. 409 `analysis_in_progress`
when one is already running.

## `GET /prs/<key>/analysis-job`  ·  `DELETE /prs/<key>/analyze`

`{ job }` where job is

```
revision     number
status       "queued" | "running" | "done" | "failed" | "cancelled"
progress     text while running ("fetching the PR head", "Bash grep …")
error        text when failed
queuedAt, startedAt, finishedAt   ISO times
fresh        boolean
```

`job` is null when the PR never ran one. DELETE cancels a queued or running job and
returns its record.

## `GET /prs/<key>/analysis/export`

The analysis as a portable envelope:

```
version, revision, headSha, mergeBase, exportedAt
summary      one paragraph
units[]      { id, title, summary, kind, attention, attentionWhy,
               order, hunks[], findings[]?, changelog[]? }
```

`kind`: `core-logic`, `connective-tissue`, `refactor`, `data`, `wiring`, `ripple`, `tests`,
`docs` (and a few more; read it as a label). `attention`: `must-read`, `skim`, `skip`.
**`risks`** — place one to four marks `{ "flag": "money", "why": "A retry can charge the customer twice.", "lines": [21, 23] }` on the hunk and new-side inclusive lines concerned. Use only `auth`, `migration`, `concurrency`, `money`, `external-call`, or `security`. Each `why` is one sentence (the same length limit as heart why) saying what is at stake there. Ranges must stay inside the hunk and must not overlap other risk ranges; they may overlap hearts. Omit `lines` for a mark on the whole hunk; whole-hunk marks do not mix with ranged ones on the same hunk. Never mark a skip hunk. Unit `riskFlags` is computed from these marks: do not set it; incoming values are ignored. Legacy units without marks retain their existing flags.

`findings[]`: `{ severity: "warning" | "note", text, evidence }`,
verified against the code, `evidence` naming the files and lines; a `warning` is
something that looks wrong. `changelog[]`:
`{ revision, text }`, what each revision changed in this unit. `hunks[]` entries
are hunk ids or `{ id, label?, skip?, heart?, risks? }`; a `heart` marks the lines the
analysis says to read first.

## `POST /prs/<key>/repo-path`  body `{ "path": "/abs/path/to/clone" }`

`{ ok, path, warning, checkoutMismatch }`. Points this PR at a local clone so
analyses can verify against the code. The path must exist and be a git repo of
that project; `warning` explains a mismatch.

## `POST /prs/<key>/revisions/<n>/discard`

Throws away revision `n` (the latest) when a refresh caught the author
mid-rebase. 409 while a run or a chat is busy. Returns `{ key, discarded, revision,
state }`.

## `GET /repos`

`{ repos: [{ host, owner, repo, prCount, archivedCount, archived, repoPath,
hasLocalConfig, watchReviews, watchOwn }] }`.

## `GET /version`

`{ version, sha, latest, ... }`. The cheapest liveness check.

## Notes for the coding agent

`GET /api/prs/<key>/agent-notes` returns `{pending: Comment[], markdown: string}`.
This is a read-only peek at agent-audience notes without a pickup mark. No notes
means an empty array and empty markdown. GitHub-audience comments are excluded.

`POST /api/prs/<key>/agent-notes/pickup` takes `{"agent":"<your name>","wait":30}`.
`wait` is optional (default 0 seconds, capped at 30). It waits for pending notes,
marks them delivered, then returns `{notes: Comment[], markdown: string, revision: number}`.
On timeout it returns 200 with `notes: []`, `markdown: ""` and the current revision.
Loop until notes arrive, or use `purview notes <key> --wait`. Both routes return 404
for an untracked PR. The CLI takes the key or the PR URL.

Each delivered comment carries `pickedUp: {at: "<ISO timestamp>", by: "<agent name>"}`.
Editing its body clears that mark, making it pending again; moving it to GitHub
also clears the mark. `purview notes <key> --peek` reads without marking.

## Comments and drafts for the coding agent

These routes are yours; the plain `/comments` routes are not. Writes name you with
`agent`, a lowercase id (`claude-code`); it becomes the draft's `author: {agent}`. The
server refuses any change to a comment that is not your own draft. Nothing here
publishes: a draft waits in Purview until the user sends it.

`GET /prs/<key>/agent/comments` returns `{comments: Comment[]}`, every local comment:

```
id, file, subjectType ("line" | "file"), line, side ("LEFT" | "RIGHT"), startLine?,
body, status ("draft" | "pushed" | "submitted"), audience ("github" | "agent"),
author (absent or "you": the reader; {agent}: an agent), inReplyTo?, revision,
outdated?, createdAt, updatedAt?
```

`GET /prs/<key>/agent/threads` returns Purview's cached GitHub threads, never fetched
for you: `{fetchedAt, threads: [{id, path, line, side, startLine, resolved, outdated,
comments: [{author, isMine, createdAt, body, truncated}]}], reviews?: [{author, state,
submittedAt, body, truncated}]}`. `?only=mine|unresolved|all` and `?path=<file>` filter
threads; `reviews` comes only with neither. Bodies stop at 600 characters
(`truncated`). Without a cache: `{threads: [], error: "no_threads_cache"}`.

`POST /prs/<key>/agent/drafts` creates a draft, 201 `{comment}`:

```sh
curl -s -X POST "$P/prs/$(key github.com/acme/billing/482)/agent/drafts" \
  -H 'content-type: application/json' \
  -d '{"agent":"claude-code","file":"src/charge.ts","line":40,"body":"This retry can charge twice."}'
```

Body: `agent`, `file`, `body`, and `line` with `side` (`RIGHT`, the new code, when
omitted; `LEFT` for removed lines), `startLine` for a range inside one hunk, or no `line` for a file comment.
`audience` is `github` or `agent` (omitted: the reader's switch). `inReplyTo` with a
thread `id` makes a reply, always `github`, exempt from the diff check.

`PATCH /prs/<key>/agent/drafts/<id>` with `{"agent":"claude-code","body":"…"}` changes
the text, nothing else; returns `{comment}`. `DELETE /prs/<key>/agent/drafts/<id>?agent=claude-code`
(or `agent` in a JSON body) moves the draft to Purview's trash, where the user can
restore it; returns `{ok, trashed}`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_agent` | `agent` missing or not a lowercase id |
| 400 | `invalid_body`, `validation_error` | the body is wrong; an edit takes only `agent` and `body` |
| 403 | `consent_required` | the comment is the reader's; propose the change instead |
| 403 | `not_your_draft` | another agent wrote it |
| 409 | `not_draft` | it is pushed or submitted; only the user changes it now |
| 422 | `comment_outside_diff` | that file or line is not in the current diff |

## `POST /prs/<key>/tag`

`{ tag: string | null, stack?: boolean }`: set one tag or clear with null; `stack: true` applies it to every open PR linked to this one through base branches (the whole stack). Returns the updated meta plus `stack`, the keys touched. CLI: `reviewer-state tag <pr> <name>` or `tag <pr> --clear`, with `--stack` (through the server).

### Comment revision anchors

Each comment carries `revision: number`, the PR revision it was written on or last mapped to. Line comments can carry `outdated: { line: number; startLine?: number; revision: number }`, preserving the position before its code disappeared. Replies and file comments carry a revision but are not line-mapped. Refresh maps local display anchors for draft, pushed, and submitted comments; GitHub retains its own anchors.

## Open in editor

`GET /api/editors` returns cached `{ id, name, available, command }` entries. `POST /api/prs/:key/open-in-editor` prepares Purview's detached checkout at the current PR head, launches the selected editor and returns `{ path }`. It never opens the configured repository path. Errors: `409 no_editor`, `502 checkout_failed`, `500 editor_failed`. Choose via `PUT /api/config` with `editor: { id, command? }` (`custom` requires `{path}`, `none` disables, `null` automatically selects the sole available editor); `editorConfirmed` remembers the confirmation. Commands accept quoted arguments, without shell expansion or operators.
