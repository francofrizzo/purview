# Writing the analysis

How every prose field of the analysis is written. It applies in whatever language the
analysis uses.

**Lead the reader in from broad to narrow.** Whoever reads this may not live in this
code. They meet, in order: the overall `summary` (why the PR exists), the `concepts` (the
words it leans on), where it lands (the `fileNotes`, as a shallow tree), then the units, and only inside a unit the identifiers
and the lines. Each level answers one question and is
readable without the next; none of them repeats another.

**Write every prose field so it reads one way.** The reader has no author to ask: an
ambiguous sentence costs a re-read at best and a wrong verdict at worst. These rules come
from ASD-STE100 (Simplified Technical English), the standard written so that a technician
cannot misread a maintenance manual. Its English word list stays out, so the rules hold in
the analysis's language, whatever it is. Apply them as you write; do not write a dense
draft and clean it up afterward.

| Rule | Do | Do not |
| --- | --- | --- |
| One name for each thing | Once a thing has a name (a concept's `term` or `aka`, an identifier), use it every time | "the charge key" in one field, "the idempotency token" in the next |
| One verb for each action | "rejects" every time the code turns a request away | "rejects", "refuses" and "blocks" for the same check |
| Active voice | "The engine writes `EXPIRED`." | "`EXPIRED` is written." |
| Simple tenses | Present for what the code does; past only for how it was before the PR | "will have retried", "has been retrying" |
| One idea per sentence | "The ledger stores the key. A retry finds it there." | "The ledger stores the key and a retry finds it, so the gateway is skipped." |
| 25 words at most | Split at "and", "but" or a semicolon | Chains of subordinate clauses |
| Noun clusters of 3 words at most | "the ledger row for each charge key" | "charge key ledger row lookup result" |
| No missing words | Keep the subject, the verb and the article | "Rows not migrated dropped", which hides which rows and who drops them |
| One hedge at most | "The cache is probably stale here." | "This may possibly cause an issue that could…" |
| Jargon defined once | Keep the term the reader needs, and define it once as a concept | An internal name the reader has never seen |

Purview explains a concept only where the text uses its `term` or an `aka`, so a synonym
also costs the reader the explanation. A hunk `label` and a skip reason are names, not
sentences: the sentence rules do not apply to them, the naming rules do. Identifiers,
paths and quoted code stay as written. Precision beats brevity: if a shorter sentence
would drop a condition, a scope or a number, keep the longer one.

Before you write the payload, read your prose once and ask:

- Does any sentence run past 25 words, or carry two facts?
- Does one thing or one action appear under two names?
- Can a passive sentence name its actor?
- Would a reviewer who reads only this field know what it means?

**The overall `summary`** is what the PR is about, in **plain words with no `code` spans**
: three to six short sentences, 100 words at most, on
the problem it solves in the system's terms, the idea of the change, and the one or two
decisions the reviewer has to judge. Use the concepts' terms; identifiers belong in the
units.

- Good: `"Snapshot sources stored a full copy of every installment on each ingestion, even
  an unchanged one. The engine had to work out which copy was current. Now the store keeps
  each installment once. Each ingestion records only the installments it brought. What to
  judge: how the engine computes the current set from that, and the one-time cleanup of
  the old copies."`
- Bad: `"SNAPSHOT sources stop reinserting the full snapshot: an installment becomes one
  record per (workflow, source, tpk) and reconciliation_ingestion_records stores the
  members; persist runs in persistBatchSize batches…"` (the code's vocabulary, no problem,
  nothing to judge).

**A unit's `summary`** is one to three short sentences, 40 words in all. They **say what
changes in the system's behavior, in the concepts' words and without `code`**; a last one,
only if the reader needs it, says where in the code. When the unit's rule turns on values
(a date, an amount, a threshold), one sentence may run a concrete case through it: "A
mail from September 1 with an e-cheq paid on September 18 counts from the 18th." It does not list who is affected or what is at
stake (that is the `attentionWhy`), and it does not walk the hunks (that is what the
heart and the labels do).

- Good: `"To find the current installments, an incremental source counts every one. A
  snapshot source counts only what its last snapshot brought. The manual match refuses the
  rest."`
- Bad: `"ApplicableRecordsForConfig replaces the list of ingestion ids with INCREMENTAL keys
  plus the ids of the SNAPSHOT ingestions used. Used by the engine's working set
  (GetApplicableRecords, which already brings the source_key), the counts and listing and
  the manual match…"` (identifiers first, and the consumers belong to the attentionWhy).

**One fact, one place.** The unit `summary` says what changes, the `attentionWhy` what is
at stake, a heart `why` what those particular lines do, a `label` what one hunk is. If a
sentence you are about to write is already true of another field, leave it out: the reader
sees all of them together, and the same fact three times reads as three things to check.

A heart `why` does not restate the unit `summary` for one file ("splits the sources:
snapshot brings its ingestion ids, incremental its key" under a summary that says exactly
that). Say what these lines do that the summary leaves out: the condition, the order, the
edge case.

<!-- experiment:unitDiagrams -->
### Unit diagrams

A small Mermaid diagram on a unit, shown under its summary, for logic that prose struggles
with: a sequence of calls across components (client, API, ledger, gateway), a state
machine (a charge goes pending, settled, refunded), or the relationships between records
a migration introduces. Most units get none; a PR gets a few at most. A unit that is a
single function, a rename, wiring, tests or docs never needs one, and a diagram that says
what the summary already says is noise.

```json
"diagram": {
  "kind": "sequence",
  "title": "Retrying a charge",
  "mermaid": "sequenceDiagram\n  participant Client\n  participant API\n  participant Ledger\n  participant Gateway\n  Client->>API: charge(order)\n  API->>Ledger: look up charge key\n  alt first attempt\n    API->>Gateway: charge card\n    Gateway-->>API: result\n    API->>Ledger: store result\n  else retry\n    Ledger-->>API: first result\n  end\n  API-->>Client: result"
}
```

- `kind` and the first line of `mermaid` agree: `sequence` is `sequenceDiagram`, `state`
  is `stateDiagram-v2`, `flow` is `flowchart TD`, `er` is `erDiagram`. Purview refuses
  anything else.
- The diagram sits in the guide's narrow column: draw a flowchart top to bottom (`TD`),
  never left to right, and keep a sequence diagram to four participants.
- Name participants, states and entities in the reader's words, the concepts' terms where
  there are some ("Ledger", "Pending charge"), not class or function names. Messages are a
  few words; in the analysis's language.
- Twelve nodes or participants at most; one diagram per unit. If it needs more, the unit
  is two decisions or the diagram is the wrong tool.
- `title`: a short caption, under 60 characters, saying what the diagram shows.
- No styling, no configuration, no links: `%%{init}`, `style`, `linkStyle`, `classDef`,
  `class`, `:::`, `click`, `link` and HTML tags are refused. Purview themes the diagram
  itself.
- On a refresh, a patch that sends `diagram` replaces it whole; `"diagram": null` drops it.
  Redraw or drop a diagram the revision made wrong.
<!-- /experiment:unitDiagrams -->

## The shape of the change

Units cut the PR into decisions; the reader reads them one at a time and loses how the
pieces fit. Two top-level views give that back: one for a reader new to this code, in
plain words, and one anchored to the code (real paths). Purview draws them; you only
write the data.

- **`concepts`** (when the PR leans on terms an outsider would not know): the words to
  read it with.
- **`fileNotes`** (write it on every analysis): where the change lands, as a shallow tree
  of the folders and files that carry it.
- **`behaviorChanges`** (write it on every analysis): each behavior the running system
  changes, before and after; `[]` when it changes none.

Each view costs the reader attention. Draw what this PR needs, not what the format allows.

### Concepts

Three to five terms the PR leans on that a reviewer from another part of the codebase
would not know: the fewest that let them follow the summary and the units. Leave
`concepts` off for a change that needs no vocabulary (a dependency bump, a generic fix).

```json
"concepts": [
  { "term": "Charge key", "means": "What makes two charge attempts the same charge: the order, the amount and the currency.", "aka": ["idempotencyKey", "idempotency key"], "isNew": true },
  { "term": "Charge ledger", "means": "A table that remembers each charge's outcome by its key, so a retry gets the first result back.", "aka": ["charge_ledger"], "isNew": true }
]
```

- `term`: the reader's words for it, in the analysis's language, as a colleague would say
  it; not the identifier.
- `means`: one plain sentence on what it is in the system, and for a new one why it
  exists. No `code` spans.
- `aka`: one to three names the code and your own text use for it, the ones a reader
  will actually meet in the units: enum values, table names, abbreviations
  (`UNRECONCILED`, `tpk`, `working_set`), as written; the most common first. Not every
  function that touches it. Purview marks
  them wherever the guide uses them and shows `means` on hover, so the units can stay
  exact without leaving the reader behind.
- `isNew`: the concept exists nowhere at the merge base; search the base for it and its
  `aka` before setting it. A concept the PR extends or brings into another part of the
  code is not new, even when the PR adds names for it (an enum value, a flavor): leave
  `isNew` off and let `means` say what the PR adds to it.
- Not general programming terms (cache, migration, retry), and not something only one unit
  mentions: explain that in the unit.

### Behavior changes

What the running system does differently once the PR merges, one row per behavior, each
with how it behaved and how it behaves. Purview shows them as a table under the summary:
the reviewer checks each row against the code, and notices the change nobody asked for.
A PR that changes no behavior (a refactor, tests, docs, tooling) writes `"behaviorChanges": []`:
Purview says so, and that tells the reviewer it is a refactor. Never a row saying "nothing
changes".

```json
"behaviorChanges": [
  { "what": "Retry after a timeout", "before": "Charges the card again.", "after": "Returns the first charge's result; the card is charged once.", "unit": "charge-once" },
  { "what": "Two orders, same amount, same minute", "before": "Two charges: the key includes the order id.", "after": "=", "unit": "charge-key" },
  { "what": "Charge ledger", "before": "—", "after": "Keeps each charge's outcome for 30 days.", "unit": "ledger-table" }
]
```

- `what`: the behavior as the people who use or operate the system would name it, under
  60 characters. A situation ("Retry after a timeout", "A batch arriving after the
  25th"), not a function.
- `before` and `after`: one plain sentence each, under 160 characters, no `code`. Concrete
  where the rule turns on values: the date, the amount, the threshold. `—` for a behavior
  that did not exist (before) or no longer does (after).
- A behavior that stays the same is worth a row when a reviewer would fear it changed
  (the second row above): it says the edge case was thought about. Its `before` says what
  it does, and `after` is `=`. Never restate it in `after` ("The same: …").
- `unit`: the id of the unit whose code makes the change, so the row opens it. Leave it
  out when the change spreads across several.
- Two to six rows, ten at most. Order by what a user would notice first.

### File notes

`fileNotes` is where the change lands, as a shallow tree: it maps a folder or a file of
this revision to one line on what it does in this change. Purview draws the tree in the
Overview, after the concepts, the way a design doc shows where a change lands: a noted
folder is one line, with only its new, deleted and separately noted files under it; the
rest is counted, and tests, docs and generated files are counted at the foot. In the
Files view each file shows its own note, or its folder's.

```json
"fileNotes": {
  "src/billing": "Charges once per key: derives it, looks it up, records the outcome.",
  "src/billing/idempotency.ts": "Derives the charge key from order id, amount and currency.",
  "migrations/0042_charge_ledger.sql": "Creates `charge_ledger`, unique on the key.",
  "src/api/orders": "Passes the order's amount and currency through to `charge()`."
}
```

- Note at the level where the role lives. A folder whose changed files share one role
  gets one note on the folder (`src/billing`), not one per file. A file gets its own note
  only when its role differs from its folder's: a new file, the heart of the change, a
  migration, a config that takes a new value.
- Aim for four to ten notes: the tree reads in one glance, like the architecture of the
  change, not its file list (the Files view has that).
- A note says what the folder or file *does in this change*, not what it is in general and
  not what to check. Under 15 words; a code span for the identifier it is about.
- Skip tests, docs, fixtures and mechanical call-site edits unless they matter; never note
  generated files.
- Keys are exact paths of this revision, a folder's without its trailing slash; Purview
  refuses any other, and caps the notes at 40.

