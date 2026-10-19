# Changelog

Each heading is a version: the day, then a counter within the day. The newest
heading is the version Purview reports, and the entries above the last one you
saw are what "What's new" shows after an update. Written for the reader of the
app, not for git: say what changed in the review, not which file moved.

## Unreleased

- **Reading passes over skippable hunks.** Opening a unit lands on its first hunk worth reading, and `v` moves on to the next one that is not skippable, as Space already did.
- **Stopping a chat reply says so.** The stop button reads "stopping…" until the reply winds down, and a stop that does not land shows up in the chat's failure row. Rewinding, clearing the conversation and switching the agent say when they are in flight, and a failure there is reported the same way instead of silently undone.
- **A failed comment action now says what failed.** A save the server refuses shows why under the comment box and keeps your text; a delete, publish, move or undo that fails says so under that card, and a resolve that fails under its thread.
- **The review summary says "saved".** Clicking away from the summary box flashes a check once it is on disk, and shows the error if it is not.
- **A rolled-back change says so.** When marking hunks or a unit viewed, reclassifying a unit or archiving a PR is refused, the page says what failed and that the change was put back, instead of quietly snapping back.
- **A unit's revision notes survive a fresh analysis.** Re-analysing a PR from scratch used to drop every unit's "what changed in rN" notes; they now carry over to the new units that hold the same hunks, and notes lost that way come back.
- **Moved code in one color.** Both ends of a move tint violet now; the fold band's "moved from / to" and the badge's arrow say which way it went.
- **Jump from a fold band.** A folded "N lines moved from / to …" band now carries a "go to" at its right edge that lands on the other end of the move when it is in the same unit; the band itself still expands on click or Enter.
- **One move, one band.** A moved block that a blank line or a closing brace split in two now folds behind a single band, the gap with it; a real edit inside the block still keeps the halves apart.
- **Split view folds a move whole or not at all.** When a moved block sits across from a real change in split view, no band appears mid-block any more; the rows stay tinted and visible until the whole block can fold.
- **Small hunks skipped more reliably.** The analysis now sees the body of every hunk of four changed lines or fewer up front, so import blocks, re-exports and renamed call sites get marked skippable instead of left as reading.

## 2026.10.19.2

- **Finer notes from the analysis.** Hunk headers carry a few words on what each hunk is, and a heart can mark more than one place in a hunk.

## 2026.10.19.1

- **Skippable hunks.** The analysis marks the hunks you need not read, such as import changes, re-exports and renamed call sites inside a unit that matters. They show muted with a short label, count toward nothing, and Space passes over them. Hover to read one at full strength.
- **A heart can be a few lines.** When the logic is a small part of a large hunk, the bar marks just those lines, the why sits right above them, and the brief names the range.
- **Files in reading order.** Inside a unit, the analysis can say which files to read first; otherwise the files that hold the heart come first, then diff order.
- **Progress at a glance on the home page.** Every PR row shows its progress bar, empty until you start, with the viewed count under it; the unit count sits beside it and the diff size moved into the row's details.

## 2026.10.16.6

- **A comment opens where it sits.** Click a comment or thread in the dock and the diff lands on its line, in its unit or its file depending on the tab, with the hunk unfolded and the comment open.
- **Shift+Space goes back.** `space` moves to the next hunk still to read; `shift+space` moves to the previous one, so an overshoot is one key back.

## 2026.10.16.5

- **One sort direction on the home page.** Every block lists oldest first: the longest-waiting review request on top, then your PRs and the rest by when they were added.

## 2026.10.16.4

- **Units link to each other.** A unit's summary that names another unit by id shows that unit's number and title as a link; click it to open the unit.
- **One card per sent comment.** A comment you sent no longer shows twice when GitHub reports it as a one-line range.
- **Updates show on a normal reload.** A new build appears on the next reload; no hard reload needed.

## 2026.10.16.3

- **Every theme reads.** Faint text, chips, tints and borders are placed against the surfaces they sit on; code comments on changed lines are lifted a step. All 17 themes, checked by a test.
- **Pick up where you left off.** A unit opens on its first hunk still to read, and `v` moves on to the next one.
- **Lists in chat render right.** Numbering continues across blank lines, and nested lists stay nested.

## 2026.10.16.2

- **Every unit has a heart.** The analysis marks the one to three hunks where the logic lives, each with a line on what to look for. They stand out in the diff; `h` / `H` jump between them. Re-analyze to get them on existing PRs.
- **The unit brief leads with the why.** Full-size attention line, then the heart; the checks fold to a counts line.
- **Analyze from scratch** in the PR's ⋯ menu redoes the whole analysis. "Analyze again" only picks up what is new.

## 2026.10.16.1

- **One panel on the right** holds comments, chat and review as tabs. `m` / `c` / `r` open them; one width, one close.
- **Comments know their audience.** Your own PRs default to notes for the agent, others to your GitHub review; the switch flips one PR and is remembered. Fixed: a new comment could lose its audience and line range.
- **Reading the analysis.** Summaries and findings render inline markdown; the revision menu can light up what a revision changed; the strip links to the description and reviews; shortcuts open as a card.
- **Tooltips** are the app's own: fast, in the UI face, with the key shown.

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
