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
Write it for the reader of the app: what changed in the review, not which file
moved. The parser ignores that heading, so unreleased bullets never reach the
app.

Do not cut a version on your own. Only when the user says to ship (or release,
or tag) a version:

1. Curate `## Unreleased` into release notes. The bullets accumulated one per
   change; the reader wants the version as a whole. Group them into a few
   themes, one bullet each with a bold lead-in (`**One panel on the
   right.**`), biggest change first. Fold a fix into the feature it belongs
   to, drop what the reader would not look for, and keep the reader's
   vocabulary (what they can do, see or configure). The parser only reads
   flat bullets with inline markdown under a version heading: no sub-lists,
   no sub-headings.
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

## Checks before pushing

- `packages/core`, `packages/server`: `npx vitest run`, `npm run build`.
- `packages/web`: `npx tsc -b`, `npx vitest run`, `npx vite build`, and
  `pnpm test:e2e` (Playwright against the mock app, `VITE_MOCK=1`).
- UI changes: look at them in both themes before pushing.

## Do not touch

- The user's running Purview on port 4779. Test on another port.
- `scripts/start.mjs`: it kills whatever is on its port.
- `~/.purview`: the user's real state. Copy it somewhere else to test against it.
