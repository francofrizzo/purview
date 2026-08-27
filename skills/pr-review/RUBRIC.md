# Classification Rubric

Iterable knowledge file for the pr-review skill. Read this before classifying hunks.
Update the "Learned corrections" section over time — see bottom.

## The six kinds

### core-logic

Behavior or domain decisions. Changes what the system *does*, not just how it's plumbed
together. If this hunk is wrong, output/behavior is wrong.

- A pricing function changes its discount formula.
- A new branch in a state machine handles a previously-unhandled transition.
- A validation rule gets stricter or looser (e.g. an email regex, an age check).
- A retry/backoff policy's parameters or trigger condition change.

**Boundary**: a one-line constant change (`MAX_RETRIES = 3` → `5`) is still core-logic if
it encodes a decision someone could get wrong — don't downgrade to skim just because it's
short. Size is not a proxy for importance.

### connective-tissue

Glue *with* logic in it: adapters, mappers, non-trivial plumbing that transforms or routes
data based on a condition. The distinguishing test: does this code make a decision, even a
small one, while connecting two things?

- A DTO mapper that has an `if (legacyFormat) {...} else {...}` branch — the branching is
  a decision, so this is connective-tissue, not wiring.
- An API client wrapper that translates a provider-specific error code into an internal
  error type — the translation table is a decision.
- A queue consumer that dedupes messages by a computed key before dispatching — the
  dedup key computation is logic.
- A React hook that derives loading/error UI state from two async calls' combined status.

**Boundary — mapper with a business rule inside is connective-tissue, not wiring.** A
mapper that just does `{ id: dto.id, name: dto.name }` field-for-field with no branching,
defaulting, or transformation is wiring. The moment it defaults a missing field, branches
on a type discriminant, or applies a unit conversion, it's connective-tissue.

### wiring

Registrations, DI, exports, imports, config plumbing with no logic. Mechanical connection,
zero decisions.

- Adding a new route to a router's route table (`router.get('/x', handler)`).
- Registering a new provider in a DI container.
- Adding an export to a barrel `index.ts`.
- A new field appended to a config object with a literal value, no computation.

**Boundary**: if the "registration" line includes a conditional (`if (env === 'prod')
register(x)`) that's connective-tissue — the condition is a decision.

### ripple

Mechanical fallout of a change elsewhere in the same PR: renames at call sites, signature
threading (a new parameter passed through five layers with no new logic at any layer),
import path updates because a file moved.

- A function is renamed; every call site updates the identifier only.
- A new required parameter is added to a function; every caller starts passing a
  hardcoded/forwarded value with no new branching.
- A type is moved to a new module; every importer's import path updates.

**Boundary**: if propagating the change requires the caller to *decide* what value to pass
(not just forward an existing one), that call site's hunk is connective-tissue or
core-logic instead — it's not mechanical anymore. Always name the driving unit in a ripple
unit's summary (see SKILL.md step 4).

### tests

Tests, evals, fixtures.

- A new test file for a function added elsewhere in the PR.
- Updated snapshot/fixture data reflecting a behavior change.
- A test *helper* with logic in it — e.g. a custom assertion, a fixture factory with
  conditional defaults, a mock server route matcher. **Boundary**: classify as `tests`
  (not connective-tissue) since it lives in test scope, but set `attention: must-read` —
  a buggy test helper silently weakens every test that uses it, which is exactly the kind
  of thing "reviewed by construction" assumptions miss.

### docs

Docs, comments-only changes, README, CHANGELOG.

- A README section rewritten to describe a new flag.
- A code comment corrected or expanded with no code change in the same hunk.
- API doc-comment (JSDoc/docstring) updated to match a signature change — classify the
  doc-comment hunk as docs even though it sits next to a core-logic hunk in the same file;
  they're still separate units unless trivially small (see below).

**Boundary — generated files are ripple/skip, not docs, even if human-readable.** A
regenerated OpenAPI spec, a compiled `.d.ts`, a `CHANGELOG.md` entry appended by a release
tool — these are mechanical fallout of another change. Classify as `ripple` (or fold into
the driving unit's hunk list if trivial) with `attention: skip`, not `docs`.

**Boundary — lockfiles are skip, not any of the above as a meaningful category.**
`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, etc. Classify as `wiring` (they're
mechanical dependency bookkeeping) with `attention: skip` unless a dependency version bump
is the actual point of the PR, in which case fold the lockfile hunk into that unit instead
of giving it its own.

## The attention ladder

Three levels: `must-read` > `skim` > `skip`. Ask these questions in order; stop at the
first "yes":

1. **Does getting this hunk wrong break something or encode a decision a reviewer must
   validate?** → `must-read`. This includes core-logic almost always, connective-tissue
   often, and anything touching a risk-flag surface (see below) regardless of kind.
2. **Does this hunk need verifying that its *shape* is right, but not tracing its full
   logic?** (e.g. a wiring change that's easy to eyeball, a ripple hunk with several
   slightly-different call sites where one might have been missed) → `skim`.
3. **Is this hunk mechanical and correct by construction** (pure rename, generated file,
   lockfile, import path fix with no ambiguity)? → `skip`.

**Risk flags override attention upward.** A risk-flagged hunk is never `skip`, and is
`must-read` unless you have a specific reason it's merely `skim` (rare — document the
reason in `attentionWhy` if you downgrade a risk-flagged unit to skim).

## Risk-flag triggers

Attach a `RiskFlag` to a unit if any of its hunks touch:

- **auth** — authentication/authorization checks, session/token handling, permission
  gates, role checks, login/logout flows.
- **migration** — DB schema migrations, data backfills, any irreversible or
  hard-to-reverse data transformation.
- **concurrency** — locks, mutexes, semaphores, async race-prone code, queue
  consumers/producers, retries that could double-process, transactions.
- **money** — amounts, prices, currency conversion, rounding/truncation of numeric
  financial values, billing/invoicing logic.
- **external-call** — new or changed HTTP/gRPC/webhook calls to third-party or
  cross-service systems, especially ones with side effects (payments, emails, SMS).
- **security** — secrets, crypto (encryption, hashing, signing, key handling), input
  sanitization for injection-prone surfaces (SQL, shell, HTML), CORS/CSP config.

A unit can carry multiple risk flags. Risk flags are about the *surface area touched*, not
about whether the diff looks scary — a one-line change to a token expiry constant is
`auth` and `must-read` even though it "looks trivial."

## Findings discipline

Findings come out of the verification pass (SKILL.md step 5) and are the one place this
skill says something about the *code* rather than about how to read it. That is exactly
why they are the easiest thing here to get wrong: the pull toward "while I'm in here, let
me also mention…" is strong, and every sentence spent that way costs the reviewer trust in
all the others. These are hard rules, not preferences.

### The three tests every finding must pass

- **Verified.** You read the code, in the local checkout, and the finding states what you
  found there. Not what the diff implies, not what is usually true of code like this.
- **Sourced.** `evidence` names the concrete location(s) you actually read —
  `internal/api/handler.go:88, internal/vep/client.go:41`. Non-empty is enforced by the
  schema; *accurate* is on you.
- **Material.** It would change what the reviewer writes in their review. If knowing it
  changes nothing they would say or do, it is not a finding.

A candidate that fails any one of the three is not downgraded to a `note` — it is dropped.

### Never a finding

- **Style or taste.** Naming, formatting, "this could be a switch", preferred idioms,
  file organization. Not yours, not here.
- **Unchecked "might"/"could" concerns.** "This could race", "callers might not handle
  this" — if you did not go and look, it is not a finding. Either check it or leave it.
- **Restating the code.** "Adds a nil check before the write" is a summary, and the unit
  already has one.
- **Architecture editorializing.** "This would be cleaner as a middleware", "the repository
  pattern would fit better here." The PR's shape is the author's decision.
- **Anything the diff + checkout cannot demonstrate.** Runtime behavior you did not run,
  performance you did not measure, product intent you inferred, "does the team want this?"

**If a question cannot be settled by reading code — it needs runtime knowledge, data, or
product intent — it stays a question in `attentionWhy`. It never becomes a finding.** A
question in `attentionWhy` is honest work; the same question dressed as a finding is not.

### Volume

Cap: 5 findings per unit, enforced by the schema. If a unit has more than ~5 candidate
warnings, that is a signal in itself — keep the most material ones and end the last one
with "further issues of the same kind" rather than truncating silently. A unit with a
single sharp `warning` is worth more than one with five diluted ones.

A `note` earns its place only by closing a question the reviewer would otherwise have had
to chase. "Checked, looks fine" about something nobody was going to check is noise.

### Boundaries

- Findings are **local annotations for the human reader**. They never block, never approve,
  are never posted to GitHub, and are not review comments. Nothing downstream acts on them.
- **`attentionWhy` stays exactly ONE line.** Verification outcomes live in `findings`, not
  in the why. If a `note` answered the only question that made a unit `must-read`, downgrade
  the unit to `skim` and rewrite `attentionWhy` to describe what is left — do not append the
  verification result to it.
- A `warning` never lowers `attention`; it may raise it. A `note` may lower it, per above.
- No checkout, no findings. There is no partial credit for a well-reasoned guess.

## Learned corrections

*(Empty — populate as `classification-corrected` events accumulate.)*

When the skill reads `classification-corrected` events from `events.jsonl` (per SKILL.md
step 6) and finds a pattern — the same kind of hunk gets corrected the same way more than
once — add a worked example here, in this format:

```
### <short pattern name>

**Was classified**: <kind>/<attention> — **Corrected to**: <kind>/<attention>

<1-2 sentence description of the hunk shape that triggers this>

Example: <one concrete code-shape example, generic enough to recognize future instances>
```

Keep entries terse. This section exists to be read on every future run, so prune entries
that get subsumed by a more general one above once you've added enough examples to update
the main kind/attention sections instead.
