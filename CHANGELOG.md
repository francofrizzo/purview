# Changelog

Each heading is a version: the day, then a counter within the day. The newest
heading is the version Purview reports, and the entries above the last one you
saw are what "What's new" shows after an update. Written for the reader of the
app, not for git: say what changed in the review, not which file moved.

## Unreleased

- **Comment box layout.** The placeholder names the line and who it's for, the audience switch sits by save, `Aa` opens the formatting, and copy and ask chat are icons. (thanks Canta 🐑)
- **Comments panel.** Cards show who they're for with a colored frame and icon, actions appear on hover, AI reviewers get an outlined "bot" label, and the header is one line. (thanks Canta 🐑)
- **Workspace look.** Settings → Workspace sets the PR's panes flat, edge to edge, and side panes show their scrollbar only on hover. (thanks Canta 🐑)
- **Fix:** flipping the comment audience twice in a row no longer saves a note for the agent as a GitHub draft.

## 2026.10.30.4

- **View options.** The sliders button in the top bar holds the diff layout, line wrapping, skippable folding, read units and GitHub thread filters. (thanks Canta 🐑)
- **End of a unit.** Past the last hunk, a button marks the unit viewed, opens the next unread unit or finishes the review. (thanks Canta 🐑)
- **Unit brief.** The "N files" line opens the unit's files, the heart is one row of file names to jump to, and a finding's places show as file and lines. (thanks Canta 🐑)
- **File status letters.** A, M, D or R beside a file's name says what the PR did to it, in diff headers, the Files view and a unit's file list.
- **Resizable sidebar.** Drag the sidebar's right edge to resize it; double-click restores the default width. (thanks Canta 🐑)
- **Shortcuts window.** `?`, the ⋯ menu or "keyboard shortcuts" in the sidebar opens the shortcuts in a centered window. (thanks Canta 🐑)
- **PR name in the top bar.** `owner/repo#number` sits beside the title, the branch icon shows base and head with copy buttons, and the rev menu needs two revisions. (thanks Canta 🐑)
- **New commits on Refresh.** When the PR moved on GitHub, the Refresh button reads "new commits", with the reason on hover. It replaces the bar under the top bar. (thanks Canta 🐑)
- **Top bar moves.** Sync, full screen and analysis stats are in the ⋯ menu, the audience is on `a` and in the comment box, updates show at home, and a dot marks a busy chat. (thanks Canta 🐑)

## 2026.10.30.3

- **Hunk and file headers.** A hunk's header shows its first line and function, a file's leads with its name, and both offer "comment" and "cite in chat" on hover. (thanks Canta 🐑)
- **Folded hunks.** Click a focused hunk's header to fold it; it keeps its heart and risks on the header, and context rows appear only next to open hunks. (thanks Canta 🐑)
- **File notes in the Files view.** The analysis's note on a file, or on its folder, sits under the file's header and on its row's tooltip. (thanks Canta 🐑)
- **Plain new files.** A file the PR adds whole reads on the plain background, its gutter still green, so a heart or a risk in it stands out. (thanks Canta 🐑)
- **Fix:** an outdated or whole-file thread clicked in the comments panel now opens at the top of its file, even resolved, instead of folded to one line. (thanks Canta 🐑)
- **Fix:** the diff no longer scrolls past its last hunk, read hunks no longer flash open between files, and hunk labels show code as code, not backticks. (thanks Canta 🐑)

## 2026.10.30.2

- **Floating chat.** The button at the top of the chat pops it into a window you drag, resize or minimize. `c` still shows and hides it, and its ⋯ menu holds clear conversation and repo checkout. (thanks Canta 🐑)
- **One submit button.** In the Review panel, pick Comment, Approve or Request changes, then press Submit. It asks to confirm only while must-read units are unread. (thanks Canta 🐑)
- **One-line refresh result.** After a refresh, a line under the top bar says what the revision brought, then the analysis's summary of it. "by file" lists the rest. (thanks Canta 🐑)
- **Graphite themes.** Graphite Dark and Light, on neutral grays, in Settings → Appearance. (thanks Canta 🐑)
- **Progress ring on home rows.** A PR's row shows how far you've read as a ring with its count. (thanks Canta 🐑)
- **Fix:** a reviewer in the Review panel reads on one line, with the stale-commit note and inline comments under it, instead of breaking mid-phrase. (thanks Canta 🐑)

## 2026.10.30.1

- **Opus by default.** Analyses and the chat run on Opus unless a model is picked; choose Sonnet in Settings → Agents for cheaper runs.
- **Analysis language setting.** Settings → Agents picks the language new analyses write in. It starts on Always English; a language in the repo's rubric still wins, and a refresh keeps the PR's own. (thanks Canta 🐑)
- **Plain-language analysis.** The PR summary says why it exists and what to judge, unit summaries open with what changes, and each thing keeps one name. Analyze from scratch to get it. (thanks Canta 🐑)
- **Concepts.** `s` lists the terms the PR leans on, and hovering a dotted word in the guide, the diff or the chat says what it means. Analyze from scratch to get them. (thanks Canta 🐑)
- **Moved blocks.** Blocks start open and their band names the other end, where "go to" lands. Settings → Diff defaults → Moved blocks starts them folded.
- **Fix:** a Mermaid diagram that fails to render no longer shows an error outside the page layout; its source shows as a code block instead.

## 2026.10.28.1

- **Import picker.** "import PRs…" in a repo's ⋯ menu finds review requests and your own PRs, then lets you tick which ones to import. Ticking an archived PR brings it back.
- **Draft comments from Claude Code.** With the purview skill, Claude Code can leave, edit or move drafts on a PR for you to send from Purview.
- **Archived PRs return on a new request.** With "watch for review requests" on, a PR you archived comes back when your review is asked for again.
- **Claude Code on Purview's tools (new harness).** Analyses and the chat now run Claude Code with Purview's own review tools instead of a shell. It needs Claude Code 2.1.305 or newer; pick Claude Code (Legacy) in Settings → Agents to keep the old way.
- **Open in Claude Code.** The chat's terminal button now opens Claude Code in a PR worktree where it can edit code and run tests. On your own PR it works on the PR's branch, and Purview never resets or deletes the worktree.
- **Agents edit any draft.** Claude Code and the chat can edit, move or delete your drafts too; the drafts panel marks their changes with an undo.
- **Archive reviewed PRs.** The archive button under a repo's list also clears open PRs you already reviewed that nobody asked you to review again.
- **Moved-code rows.** A moved block shows in a faded red or green, the side it left or arrived on, with a → or ← in place of +/- on each line. Violet now means only an agent note.
- **Fix:** the chat no longer jumps back to the bottom while you read a little higher up during a reply.
- **Fix:** an expanded moved block no longer looks like an ordinary change; its lines keep the band's coloured edge and the arrow markers.
- **Fix:** a moved line no longer shows a word-level highlight against an unrelated line next to it.
- **Fix:** the chat's terminal command popover no longer opens below the bottom of the window.

## 2026.10.23.4

- **Fix:** a Mermaid diagram in the chat no longer stays as raw code until you reload the page.

## 2026.10.23.3

- **Comments follow the code.** A comment keeps pointing at the same lines after a new revision, pushed or not; one whose line is gone shows an "outdated" chip with where it was written.
- **Open in editor.** The code button in the PR header opens Purview's own copy of the PR, at its head commit, in your editor. Its menu lists the editors found on this machine and takes a custom command.
- **Watch your own PRs.** Repo settings → Watch has a second switch that imports and analyzes the PRs you open, drafts included, every 5 minutes, independent of the review-request switch.
- **Fix:** opening a PR no longer freezes the server for other requests.
- **Fix:** adding, refreshing and syncing a PR no longer freeze the server for other requests.
- **Fix:** a PR no longer loads its diff twice when opened.
- **Fix:** saving a comment no longer scrolls the diff away from where you were reading; the keyboard stays on the diff.

## 2026.10.23.2

- **Archived list, newest first.** A repo's archived PRs open with the ten most recently added on top, and "show 10 more" walks back.
- **Fix:** the dock button in the PR header opens the chat, the first tab, instead of comments the first time.

## 2026.10.23.1

- **Tags on PRs.** Hover a row on the home page and click the tag icon, or use the PR header's ⋯ menu, to give a PR one tag; each block of the home page groups its PRs by tag, in the tag's colour. A PR in a stack tags the whole stack unless you untick "Whole stack".
- **Stacked PRs in the list.** A PR stacked on another PR in the same block hangs under it as a tree on the home page.
- **Threads, CI and blame in the chat.** Ask the chat which threads are open or yours, what reviewers said, whether checks pass, or who last touched a line. It can draft a reply to a thread.
- **Risks on the lines they concern.** The diff marks the lines a risk is about with a bar, its flag and one sentence of what is at stake. Re-analyze to get them.
- **The chat can mark hunks viewed.** Ask it to tick moved or mechanical code and it marks those hunks, in both Claude harnesses, and says which.
- **Two more unit kinds.** A unit can be "refactor" (restructured, nothing changed) or "data" (schema, seeds, generated files); re-analyze to get them.
- **Fable in the model list.** The analysis and chat model pickers offer Fable, Opus, Sonnet and Haiku for both Claude harnesses.
- **Search switches.** The find bar shows both sides of each choice, "this unit | whole diff" and "changed | all lines", with the active one lit. All lines is the default.
- **Fix:** "Publish now" shows "publishing…" on the card while GitHub takes it, then the comments panel scrolls to the card under Submitted and flashes it.
- **Fix:** code in a bold lead-in, such as **`file.go`**, renders as code and links to the diff instead of showing the backticks.

## 2026.10.22.1

- **Thread actions in the comments panel.** Hover a GitHub thread to copy it with the code it points at, reply to it, or resolve it.
- **Reactions on GitHub comments.** Each comment in the diff shows its reactions; click one to add or remove yours, or pick from the eight GitHub emoji.
- **Review text in the finish-review panel.** Each reviewer's verdict shows what they wrote, and "N inline comments" jumps to each of their comments in the diff.
- **Emoji picker in the comment box.** The smiley button in the formatting row searches by name or meaning; Enter inserts the first match.
- **Dates in the rev menu.** Each revision shows when it was fetched, and the menu is wider.
- **Copy the PR number.** A copy icon sits next to the number in the header, like the one on the branch.
- **"Changed" means the highlighted revisions.** The chip on a unit appears when a revision lit up in the rev menu touched it, and no longer when the unit changed since you viewed it.
- **Fix:** tool calls in the chat and the analysis banner say what the agent is doing, such as "Reading the diff", with the file or pattern on a line below.
- **Fix:** a whole-file or outdated thread clicked in the comments panel opens in its review unit instead of switching to the Files tab.
- **Fix:** the floating comment box no longer clips its formatting controls on the right.

## 2026.10.21.2

- **Findings link to their evidence.** Each place a finding cites that the diff shows opens there with a click; the fold under a unit's summary is now called Findings.

## 2026.10.21.1

- **Reviewers on your PRs.** The row and the PR header show who was asked to review one of your PRs and what they said; bots are left out, and a PR with no reviewer says so.
- **Update from the list.** A PR with new commits on GitHub carries an "update" button on its row; click it to refresh without opening it.

## 2026.10.20.4

- **Fix:** a PR renamed on GitHub now carries its new title everywhere: the report, the CLI list and what your coding agent reads, not only the header.

## 2026.10.20.3

- **Your notes reach the agent.** Notes for the agent can be picked up by the coding agent that wrote the PR: `purview notes <pr> --wait` returns them as you write them, and each note shows when it was picked up.
- **CI status on every PR.** The list and the PR header show whether the checks pass, fail or are still running; click the header chip for each check and its run.
- **The coding-agent skill knows when it is stale.** Installed copies carry a revision; the skill tells you to reinstall when it changed, and `purview skill install` says whether it updated anything.

## 2026.10.20.2

- **Fix:** adding a PR through the coding-agent skill now starts its analysis, like adding it in the app. Say "without analysis" to just track it.

## 2026.10.20.1

- **Purview from your coding agent.** A bundled skill lets Claude Code, Codex or any agent track, list, refresh, archive and re-analyze PRs in Purview and read what the analysis found, never your review. Settings has a prompt to paste into the agent, and `purview skill install` does it for the common ones.

## 2026.10.19.3

- **Skippable hunks, out of the way.** Small hunks like imports and renamed call sites now get marked skippable; opening a unit and `v` skip past them, and `Z` folds them all shut.
- **Pictures in the description and comments.** Images hosted on GitHub now show in the PR description, the reviews and other people's comments, fetched through Purview with your own access.
- **What each revision changed.** A refresh writes one line per revision, shown in the rev menu and on the "since review" chip. Moved code is tidier: one colour, one band per block, a jump to the other end.
- **The app tells you what it is doing.** Chat stop, review submit and the summary save show their state, and a refused action says what failed instead of snapping back silently.

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
