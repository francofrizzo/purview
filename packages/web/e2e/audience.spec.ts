import { test, expect } from "@playwright/test";
import { UNITS, openComments, openComposerOnLine, openPr, openUnit } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openPr(page);
});

test("the drawer files comments by audience; a draft moves between the two", async ({ page }) => {
  await openComments(page);
  const github = page.getByTestId("drawer-section-github");
  const agent = page.getByTestId("drawer-section-agent");
  await expect(github).toBeVisible();
  await expect(agent).toBeVisible();
  await expect(agent.getByTestId("comment-card-draft-agent-1")).toBeVisible();
  await expect(agent.getByTestId("comment-card-draft-agent-1")).toContainText("Picked up by Claude Code · 5m ago");
  await expect(github.getByTestId("drawer-group-drafts").getByTestId("comment-card-draft-1")).toBeVisible();
  // The review's footer leads to the finish-review panel.
  await expect(page.getByTestId("drawer-finish-review")).toBeVisible();

  // Move the note to GitHub: it re-files under Drafts; move it back.
  await page.getByTestId("move-draft-agent-1").click();
  await expect(github.getByTestId("comment-card-draft-agent-1")).toBeVisible();
  await expect(github.getByTestId("comment-card-draft-agent-1")).toHaveAttribute("data-audience", "github");
  await page.getByTestId("move-draft-agent-1").click();
  await expect(page.getByTestId("drawer-section-agent").getByTestId("comment-card-draft-agent-1")).toBeVisible();

  // Only the notes are in the agent bundle.
  await expect(page.getByTestId("copy-bundle-drawer")).toContainText("(1)");
  // A pushed or submitted comment cannot move; a reply is not publishable.
  await expect(page.getByTestId("move-draft-2")).toHaveCount(0);
  await expect(page.getByTestId("publish-draft-2")).toHaveCount(0);
});

test("the switch decides what a new comment is for; `a` flips it", async ({ page }) => {
  await openUnit(page, UNITS.reconcile);
  // GitHub is the unremarked default; only the agent case shows in the top bar.
  const agentMode = page.getByTestId("topbar-audience-agent-mode");
  await expect(agentMode).toHaveCount(0);
  await page.keyboard.press("a");
  await expect(agentMode).toBeVisible();

  await openComposerOnLine(page, 10);
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toHaveAttribute("data-audience", "agent");
  // No header in place under the line: the placeholder and the button say who it is for.
  await expect(page.getByTestId("composer-textarea")).toHaveAttribute("placeholder", "Note for the agent on line 10…");
  await expect(page.getByTestId("composer-save")).toHaveText("save note");
  // Flipping inside the composer flips the global switch too.
  await page.getByTestId("composer-audience-github").click();
  await expect(composer).toHaveAttribute("data-audience", "github");
  await expect(agentMode).toHaveCount(0);
  await page.getByTestId("composer-audience-agent").click();
  await expect(composer).toHaveAttribute("data-audience", "agent");

  await page.getByTestId("composer-textarea").fill("rename this before merging");
  await page.getByTestId("composer-save").click();
  await expect(composer).toHaveCount(0);

  await openComments(page);
  const agent = page.getByTestId("drawer-section-agent");
  await expect(agent).toContainText("rename this before merging");
  await expect(page.getByTestId("copy-bundle-drawer")).toContainText("(2)");
  // Back to GitHub for the next test (the mock keeps the switch in memory).
  await page.getByTestId("drawer-audience-github").click();
  await expect(agentMode).toHaveCount(0);
});

test("your own PR defaults to notes for the agent; the flip sticks to the PR", async ({ page }) => {
  await page.goto("/pr/github.com/acme/billing/491");
  const agentMode = page.getByTestId("topbar-audience-agent-mode");
  await expect(agentMode).toBeVisible();
  // One click on the chip goes back to GitHub, and it sticks to this PR.
  await agentMode.click();
  await expect(agentMode).toHaveCount(0);
  // Someone else's PR is untouched by that flip.
  await page.goto("/pr/github.com/acme/billing/482");
  await expect(page.getByTestId("topbar-title")).toBeVisible();
  await expect(agentMode).toHaveCount(0);
});

test("publish now posts one GitHub draft publicly, after a confirmation", async ({ page }) => {
  await openComments(page);
  const github = page.getByTestId("drawer-section-github");
  await page.getByTestId("publish-draft-1").click();
  await expect(page.getByTestId("confirm-publish-draft-1")).toContainText("public at once");
  await page.getByTestId("publish-inline-draft-1").click();
  // While GitHub takes its time the card says so where the question was.
  await expect(page.getByTestId("comment-card-draft-1")).toHaveAttribute("data-publishing", "true");
  await expect(page.getByTestId("confirm-publish-draft-1")).toContainText("Posting on GitHub");
  const landed = github.getByTestId("drawer-group-submitted").getByTestId("comment-card-draft-1");
  await expect(landed).toBeVisible();
  await expect(landed).toHaveAttribute("data-status", "submitted");
  await expect(landed).toBeInViewport();
  await expect(page.getByTestId("comment-card-draft-1")).toHaveAttribute("data-flash", "true");
  await expect(page.getByTestId("publish-draft-1")).toHaveCount(0);
});

test("send to chat hands the notes to the review chat", async ({ page }) => {
  await openComments(page);
  await page.getByTestId("drawer-send-to-chat").click();
  const chat = page.getByTestId("chat-panel");
  await expect(chat).toBeVisible();
  await expect(chat).toContainText("Please act on this note.");
});
