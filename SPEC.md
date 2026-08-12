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

`~/.reviewer/<host>/<owner>/<repo>/<number>/`

```
meta.json           # { host, owner, repo, number, url, createdAt }
events.jsonl        # append-only event log (source of truth)
state.json          # derived snapshot, rebuilt from events; safe to delete
comments.json       # local draft comments (draft -> pushed -> submitted)
review.json         # review body draft + pending review ids + last submission
revisions/<n>/      # one per observed (baseSha, headSha, mergeBase)
  diff.patch        # the diff exactly as GitHub served it (v3.diff)
  files.json        # parsed: files -> hunks with ids
```

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
`review-submitted` {event: APPROVE|REQUEST_CHANGES|COMMENT, url?, commentCount}

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

## Server REST (localhost:4779)

```
GET  /api/prs                          # list state dirs
POST /api/prs        {url}             # init: fetch PR meta + diff via gh, create state
POST /api/prs/:key/refresh             # fetch latest, run migration
GET  /api/prs/:key                     # state.json + current revision files.json + diff text
POST /api/prs/:key/hunks/:id/viewed    {viewed: bool}
POST /api/prs/:key/units/:id/viewed
POST /api/prs/:key/units/:id           # patch unit (reclassify -> also logs classification-corrected)
POST /api/prs/:key/sync                # push viewed files + un-pushed draft comments to GitHub
GET/POST /api/prs/:key/comments        # local drafts
PATCH /api/prs/:key/comments/:id  {body, confirm?}  # edit body: draft = local only; pushed/submitted = local + best-effort GraphQL remote update (submitted requires confirm: true)
DELETE /api/prs/:key/comments/:id      # delete locally; best-effort delete on GitHub if pushed
GET  /api/prs/:key/review              # local draft body + remote pending status + counts + readiness
POST /api/prs/:key/review   {body}     # save the review body locally
POST /api/prs/:key/review/submit       # {event, body?, confirm: true} -> submit on GitHub
DELETE /api/prs/:key/review/pending    # discard the remote pending review, reset comments to draft
```
`:key` = `host/owner/repo/number` URL-encoded. Server executes `gh` (assume authenticated); errors surface as JSON.

Review errors carry a specific `error` code rather than a generic gh failure:
`cannot_approve_own_pr` (422), `stale_commit_id` (422, force-push moved the head),
`comment_line_not_in_diff` (422), `pending_review_gone` (404), `confirmation_required` (400),
`invalid_event` (400).

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

## Non-goals for v1

No bidirectional comment-thread sync (drafts push-only; threads authored elsewhere are never read back), no stacked PRs, no multi-PR dashboards, no auth (localhost only), no GitLab.
