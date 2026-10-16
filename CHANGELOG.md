# Changelog

Each heading is a version: the day, then a counter within the day. The newest
heading is the version Purview reports, and the entries above the last one you
saw are what "What's new" shows after an update. Written for the reader of the
app, not for git: say what changed in the review, not which file moved.

## Unreleased

- "Analyze from scratch" in the PR's ⋯ menu drops every unit and the summary and runs the first analysis again on this revision. "Analyze again" keeps what is classified and only picks up what is new, so on an unchanged revision it has nothing to do.
- The collapsed summary strip renders the summary's inline markdown, so identifiers and paths read as code there too.
- Every unit has a heart: the one to three hunks where its logic lives, named by the analysis with a line on what to look for. In the diff those hunks carry a filled heart, a tinted header, the why right under it and a bar down their left edge; the other hunks stay fully visible and say what they are (tests, docs, imports only…). `h` / `H` jump between heart hunks, the sidebar counts them, and the unit brief lists them with jumps. A unit's hunks now always follow the diff's order.
- The unit brief leads with why the unit matters: the attention line is full size with its chip and icon, and the checks fold to one line of counts (warnings in color) until you open them.

## 2026.10.16.1

- **One panel on the right.** Comments, chat and review are tabs in a single panel with one width (drag its left edge) and one close. `m` / `c` / `r` jump to a tab or close it again; "finish review" and "send to chat" switch tabs. The top bar keeps one button for the panel, which reopens the last tab, plus "finish review".
- **Comments know who they are for.** On your own PRs a new comment is a note for the agent; on anyone else's it is part of your GitHub review. The switch now flips one PR and is remembered there. A new comment always carries its audience and its full line range to the server (before, a multi-line comment could land as one line in the default audience).
- **Reading the analysis.** Summaries, "why" lines and findings use inline markdown, so identifiers, paths and values come as code. The revision menu (click "rev N") lights up what each revision changed, the same highlight the unit's changelog offers. The summary strip leads with its chevron, and "description" and "reviews" on it open the panel straight onto that section. Keyboard shortcuts open as a card over the diff instead of growing the sidebar.
- **Tooltips are the app's own.** They open fast in the app's typeface, show the shortcut as a key, and go away as soon as you click, scroll or press Escape. Every hint in the app went through them.

## 2026.10.15.1

- Comments now have an audience. A global switch (in the top bar, the composer and the comments panel, or press `a`) decides whether a new comment is part of your GitHub review or a note for a coding agent. Notes are violet, never reach GitHub, and have their own section in the comments panel with "copy all", "copy & delete" and "send to chat". A draft can be moved between the two at any time.
- "Publish now" on a GitHub draft posts it as a public comment at once, outside any review, after a confirmation. The comments panel also leads straight to "finish review".
- Draft cards lost the dashed outline: a solid card with a colored bar on the left says who the comment is for, and the status word says where it is.
- The comments panel is a floating pane like the chat and finish review. The CLI's `comment add` and `comment edit` take `--for github|agent`, and `comment list` shows it.

## 2026.10.14.4

- Purview tells you when a newer release is on GitHub: a chip with the version on the home page (an icon with a dot inside a PR) that opens the command to run, and in Settings → About the status, a "Check now" button, and a switch to turn the daily check off.

## 2026.10.14.3

- Settings are grouped (Appearance, Review, System; and for a repo: Repo, Review, Sources, Danger) with a section list on the left that scrolls to each section and follows where you are.
- Pressing `s` (or Esc) to close the summary panel now works while the pointer is over it; before, the hover kept it open.

## 2026.10.14.2

- The ⋯ menus on a repo and on a PR are one line per action, with icons; the explanations moved into tooltips. "Archive N merged & closed" now sits by the repo's archived list instead of inside the menu.

## 2026.10.14.1

- The PR header and every home row show GitHub's size stat: files changed, lines added, lines removed.
- Purview now has a version, defined by this changelog, and shows what's new the first time you open it after an update. Settings has an About section with the version and the full log.

## 2026.10.9.1

- The diff is the desk: the sidebar, the unit brief and the side panels rest on it as bordered panes with a small gutter.
- The summary strip opens as a floating panel with Summary, Description and Reviews stacked, and a jump bar that scrolls to each.
- Sidebar tabs and group names in sentence case; "Hide reviewed" is an eye toggle; keys everywhere are drawn as caps, and the shortcuts legend is a keyed table.
- `n` opens a comment on the focused hunk and asks for the line (or a range like `12-18`); `V` marks the whole unit viewed.
- Comments: paste or attach images and videos, Write / Preview, formatting shortcuts and a toolbar, multi-line ranges from the gutter selection, and "Suggest a change" blocks.
- Review threads, previous reviews and the conversation from GitHub show inline and in the summary; a verdict says which revision it covered; bots are filtered.
- Generated files and lockfiles are detected by Purview and kept in one skip unit, never analyzed.
- Chat: a Stop button, Esc to stop, and "send now" on a queued message. The analyzer can read git history for who changed what.
- Settings: extra GitHub logins whose PRs count as yours. Adding an archived PR brings it back.
- Icons are Tabler's. A Playwright suite guards scrolling, folding, the composer and the top bar.
