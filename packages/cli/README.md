# Purview

A local-first pull request review assistant. Run it with no install:

```bash
npx @francofrizzo/purview
```

That runs a short terminal onboarding the first time (checks Node, `gh`, `claude`, and asks
for consent before anything can start a Claude analysis run on your account), then starts the
server at <http://localhost:4779>. Open it and paste a PR URL to start tracking one.

## Prerequisites

- Node.js >= 20
- [`gh`](https://cli.github.com/), authenticated (`gh auth login`) — every GitHub read and
  write goes through it.
- [`claude`](https://claude.com/claude-code), signed in, for the automatic analysis and the
  review chat (optional — everything else works without it).

## Options

- `PURVIEW_PORT` — run on a port other than 4779.
- `PURVIEW_STATE_DIR` — where PR state lives (default `~/.purview`).
- `npx @francofrizzo/purview --onboard` — re-run the onboarding at any time.

See the [full project README](https://github.com/francofrizzo/purview#readme) for the state
directory layout, per-repo configuration, the review-unit model, and everything else this
package doesn't repeat.

## Development

This package is the publishable wrapper around the [purview monorepo](https://github.com/francofrizzo/purview);
it doesn't contain its own source beyond a thin bundling script. To work on Purview itself,
clone the repo and see its root README instead.
