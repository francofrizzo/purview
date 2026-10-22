# Working on Purview

Purview is a local PR review tool: a server (`packages/server`, Hono, `/api/*`),
a web app (`packages/web`, React + Vite + Tailwind), shared state and CLI
(`packages/core`, `reviewer-state`), and the analysis skill (`skills/pr-review`).

## Version and changelog

The version is defined by `CHANGELOG.md`: each `## YYYY.M.D.N` heading (the day,
then a counter within the day) is one shipped change, and the newest heading is
the version the app reports. "What's new" shows the entries above the one the
reader last closed.

When a change is visible to the person using the app, add a bullet under the
`## Unreleased` heading at the top of `CHANGELOG.md` (create it if missing).
The parser ignores that heading, so unreleased bullets never reach the app.

### How a bullet is written

Every bullet, unreleased or shipped, follows these rules. They come from the
changelogs people actually read (Linear, Raycast, Sketch, Zed, Keep a
Changelog): name the thing, say what you can do with it and where, stop.

1. One bullet per change the reader could notice on their own. Never join two
   changes with "and" or a semicolon. A fix is its own bullet.
2. The bold lead-in names the thing, two to five words, the way the UI or a
   user names it: "Reactions on GitHub comments", "Emoji picker in the comment
   box". A noun phrase: no verbs, no benefits, no wordplay, no slogans.
3. The first sentence says what you can now do, present tense, "you" as the
   reader, and where it is: the button, key, menu, panel or command. Under
   twenty words.
4. A second sentence only if the reader needs it to use the feature right: a
   condition, a limit, a key. Never a third.
5. A fix reads `**Fix:**` followed by the symptom that no longer happens, in
   the words the reader would have used to report it. Not the cause, not the
   file, not what was done.
6. Banned words: improvements, better, tidier, smoother, enhanced, various,
   now supports, seamless, we, excited. If a sentence could appear in any
   product's changelog, replace it with the specific thing in this one.
7. Test before saving: a reader with the app open must find the change in ten
   seconds from the bullet alone. If not, the bullet is missing the where.

Wrong (slogan lead-in, three changes, "tidier", no where):
"**What each revision changed.** A refresh writes one line per revision,
shown in the rev menu and on the chip. Moved code is tidier: one colour, one
band per block, a jump to the other end."

Right (three bullets):
"**Revision summaries.** The rev menu shows one line per revision saying what
it changed."
"**Moved-code blocks.** A moved block is one band in one colour, with a jump
to its other end."
"**Fix:** the 'since review' chip no longer lists every revision; it shows the
one line for the latest."

Wrong: "**The app tells you what it is doing.** Chat stop, review submit and
the summary save show their state." Right: "**Fix:** Stop in the chat, Submit
in finish review and the summary's Save show a spinner until done, and say
what failed instead of snapping back."

Do not cut a version on your own. Only when the user says to ship (or release,
or tag) a version:

1. Order `## Unreleased`: new things first, biggest first; then changes to
   existing behavior, each saying what to do about it; fixes last. Reread
   every bullet against the rules above and drop what the reader would not
   look for. Do not merge bullets into themes. The parser only reads flat
   bullets with inline markdown under a version heading: no sub-lists, no
   sub-headings.
2. Rename `## Unreleased` to the next version: today's date, then the next
   counter for the day (`## 2026.10.14.4`).
3. Commit, tag it (`git tag -a v2026.10.14.4 -m 2026.10.14.4`) and push with
   `--tags`.

If `## Unreleased` has bullets at the end of a turn, remind the user in one line
that there is unreleased work and offer to ship it.

Internal changes (documentation, tests, refactors, tooling) get no entry and no
version bump. Neither do small tweaks the reader would not look for in a
changelog: a label's wording, a spacing or color nudge, a tooltip. An entry is
for something the reader can do, see or configure that they could not before.

## Themes and contrast

`packages/web/src/lib/contrast.ts` lists every surface where one color is
painted on another (text on each pane, chips on their tints, code on diff
rows…) with the contrast floor that context needs. Two things read it:
`themes.test.ts` fails any theme that falls under a floor, and
`pnpm contrast-sheet` (in `packages/web`) renders the same list as a page to
look at. So:

- A new place where colors meet is a new entry in `contrast.ts`, nowhere
  else; the test and the sheet pick it up together.
- A new theme must clear every floor as is. A palette that cannot (a
  low-contrast one by design) declares it on the theme: `contrast.allow`
  names the surface and the floor it is held to instead, `contrast.floorScale`
  lowers every floor. The test also fails an allowance that is no longer
  needed, so the list stays honest.
- Before changing a token derivation or a theme, run the sheet and look.

## Schema changes

`packages/core/src/upcast.ts` brings every persisted event (`events.jsonl`) and
every incoming analysis or unit-patch payload to the current shape before the
schema sees it, so the schema, the reducer, the service and the web only ever
describe the shape of today. So:

- A schema change is one new upcast step plus a `STATE_SHAPE_VERSION` bump,
  never an alias or a fallback in the schema, the reducer or the service.
- Each step rewrites one old shape to the next, carries a test with a literal
  event from its era (`test/upcast.test.ts`), and is frozen once shipped: a
  later change is a later step.
- The event log is append-only and never rewritten. `state.json` is a derived
  snapshot: when the version goes up it is rebuilt from the log through the
  upcaster.

## Checks before pushing

- `packages/core`, `packages/server`: `npx vitest run`, `npm run build`.
- `packages/web`: `npx tsc -b`, `npx vitest run`, `npx vite build`, and
  `pnpm test:e2e` (Playwright against the mock app, `VITE_MOCK=1`).
- UI changes: look at them in both themes before pushing.

## Do not touch

- The user's running Purview on port 4779. Test on another port.
- `scripts/start.mjs`: it kills whatever is on its port.
- `~/.purview`: the user's real state. Copy it somewhere else to test against it.
