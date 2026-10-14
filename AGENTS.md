# Working on Purview

Purview is a local PR review tool: a server (`packages/server`, Hono, `/api/*`),
a web app (`packages/web`, React + Vite + Tailwind), shared state and CLI
(`packages/core`, `reviewer-state`), and the analysis skill (`skills/pr-review`).

## Version and changelog

The version is defined by `CHANGELOG.md`: each `## YYYY.M.D.N` heading (the day,
then a counter within the day) is one shipped change, and the newest heading is
the version the app reports. "What's new" shows the entries above the one the
reader last closed.

When a change is visible to the person using the app:

1. Add a bullet under today's heading in `CHANGELOG.md`, or start a new heading
   with the next counter. Write it for the reader of the app: what changed in the
   review, not which file moved.
2. Tag the commit with the version: `git tag -a v2026.10.14.2 -m 2026.10.14.2`
   and push with `--tags`.

Internal changes (documentation, tests, refactors, tooling) get no entry and no
version bump.

When the user asks for several changes in one go, ship them as one version: one
heading with one bullet per change, one tag, once the batch is done. Do not cut
a version after each change in the middle of a batch.

## Checks before pushing

- `packages/core`, `packages/server`: `npx vitest run`, `npm run build`.
- `packages/web`: `npx tsc -b`, `npx vitest run`, `npx vite build`, and
  `pnpm test:e2e` (Playwright against the mock app, `VITE_MOCK=1`).
- UI changes: look at them in both themes before pushing.

## Do not touch

- The user's running Purview on port 4779. Test on another port.
- `scripts/start.mjs`: it kills whatever is on its port.
- `~/.purview`: the user's real state. Copy it somewhere else to test against it.
