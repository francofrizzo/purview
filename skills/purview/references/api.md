# Purview API, the parts this skill uses

Base: `http://localhost:${PURVIEW_PORT:-4779}/api`. Loopback requests need no token.
JSON in, JSON out. `<key>` is `host/owner/repo/number` URL encoded (or an encoded PR URL).

## Errors

Every error is `{ "error": "<code>", "message": "<sentence>" }` with an HTTP status:

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
units[]      { id, title, summary, kind, attention, attentionWhy, riskFlags[],
               order, hunks[], findings[]?, changelog[]? }
```

`kind`: `core-logic`, `connective-tissue`, `wiring`, `ripple`, `tests`, `docs` (and a
few more; read it as a label). `attention`: `must-read`, `skim`, `skip`.
`riskFlags`: any of `money`, `auth`, `security`, `migration`, `concurrency`,
`external-call`. `findings[]`: `{ severity: "warning" | "note", text, evidence }`,
verified against the code, `evidence` naming the files and lines; a `warning` is
something that looks wrong. `changelog[]`:
`{ revision, text }`, what each revision changed in this unit. `hunks[]` entries
are hunk ids or `{ id, label?, skip?, heart? }`; a `heart` marks the lines the
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
hasLocalConfig, watchReviews }] }`.

## `GET /version`

`{ version, sha, latest, ... }`. The cheapest liveness check.
