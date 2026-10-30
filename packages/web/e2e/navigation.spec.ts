import { test, expect } from "@playwright/test";
import { PR_PATH, RECONCILE_HUNKS, UNITS, expectUnderFileHeader, hunkHeader, openPr, openUnit } from "./helpers";

const [A, B, C] = RECONCILE_HUNKS;

test.beforeEach(async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
});

test("j/k move the focus one hunk at a time and land it under the sticky file header", async ({ page }) => {
  await expect(hunkHeader(page, A)).toHaveAttribute("data-focused", "true");

  await page.keyboard.press("j");
  await expectUnderFileHeader(page, B);
  // Exactly one focused hunk (A's row may have left the virtual window).
  await expect(page.locator('[data-testid^=hunk-header-][data-focused="true"]')).toHaveCount(1);
  // The pinned row above it is this file's header, not a hunk's.
  await expect(page.locator('[data-sticky="true"] [data-testid="file-header-src/billing/reconcile.ts"]')).toBeVisible();

  await page.keyboard.press("j");
  await expectUnderFileHeader(page, C);

  await page.keyboard.press("k");
  await expectUnderFileHeader(page, B);
});

test("v marks the focused hunk viewed, folds it, and moves on to the next", async ({ page }) => {
  await page.keyboard.press("j");
  await expectUnderFileHeader(page, B);

  await page.keyboard.press("v");
  await expect(hunkHeader(page, B)).toHaveAttribute("data-collapsed", "true");
  await expect(hunkHeader(page, B).getByRole("button", { name: "Mark as not viewed" })).toBeVisible();
  await expect(hunkHeader(page, B)).toContainText("lines folded");
  await expectUnderFileHeader(page, C);
  // The file's own checkbox now reads partly done.
  await expect(page.getByTestId("file-viewed-src/billing/reconcile.ts").first()).toHaveAttribute("aria-checked", "mixed");
});

test("a unit opens on its first hunk still to read, and v moves on to the next one still to read", async ({ page }) => {
  // The charge unit: 0001 is viewed in the fixture, 0003 and 0005 are not.
  await openUnit(page, UNITS.charge);
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("v");
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-collapsed", "true");
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
});

test("Shift+J / Shift+K step between units in sidebar order", async ({ page }) => {
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile);
  // The reconciliation unit is "skim" and sits after the two must-reads.
  await page.keyboard.press("Shift+KeyK");
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.retry);
  await page.keyboard.press("Shift+KeyK");
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.charge);
  await page.keyboard.press("Shift+KeyJ");
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.retry);
  // The diff follows the unit: its first hunk still to read is focused
  // (0002 is already viewed in the fixture).
  await expect(hunkHeader(page, "a1b2c3d4e5f60008")).toHaveAttribute("data-focused", "true");
});

test("s opens the overview in the sidebar over the diff's room, and its bar jumps between sections", async ({ page }) => {
  await page.keyboard.press("s");
  const overview = page.getByTestId("overview");
  await expect(overview).toBeVisible();
  await expect(page.getByTestId("sidebar-tab-overview")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-diff-scroller]")).toHaveCount(0);
  const pane = (await page.getByTestId("overview-pane").boundingBox())!;
  expect(pane.width).toBeGreaterThan(1000);

  await expect(page.getByTestId("pr-summary")).toBeVisible();
  await expect(page.getByTestId("pr-description")).toContainText("Retried charges could double-bill");
  const jump = page.getByTestId("overview-jump-description");
  await jump.click();
  await expect(jump).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("pr-description")).toBeInViewport();

  // Only what needs a close read is listed; the rest is counted.
  const reading = page.getByTestId("reading-order");
  await expect(reading).toContainText(UNITS.charge);
  await expect(reading).not.toContainText(UNITS.reconcile);
  await expect(page.getByTestId("reading-rest")).toHaveText("Then 2 to skim and 2 to skip.");

  await page.keyboard.press("s");
  await expect(overview).toHaveCount(0);
  await expect(page.locator("[data-diff-scroller]")).toBeVisible();
});

test("the overview's jump bar moves to the margin where the pane has room, and comes back where it does not", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.keyboard.press("s");
  const summary = page.getByTestId("pr-summary");
  const first = page.getByTestId("overview-jump-summary");
  const last = page.getByTestId("overview-jump-reviews");

  // A list in the left margin, clear of the text, that stays as the text moves.
  const text = (await summary.boundingBox())!;
  const atRest = (await first.boundingBox())!;
  expect(atRest.x + atRest.width).toBeLessThan(text.x);
  expect((await last.boundingBox())!.y).toBeGreaterThan(atRest.y);
  await last.click();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("pr-reviews")).toBeInViewport();
  expect((await first.boundingBox())!.y).toBe(atRest.y);

  // The same bar, above the text, once the margins are gone.
  await page.setViewportSize({ width: 1000, height: 800 });
  const row = (await first.boundingBox())!;
  expect((await last.boundingBox())!.y).toBe(row.y);
  const pane = (await page.getByTestId("overview").boundingBox())!;
  expect(row.y).toBeLessThan(pane.y + 20);
});

test("a file in the overview's tree opens in the Files view, and the tabs and the URL follow", async ({ page }) => {
  await page.getByTestId("sidebar-tab-overview").click();
  await expect(page).toHaveURL(/view=overview/);
  await page.getByTestId("file-shape-src/billing/idempotency.ts").click();
  await expect(page.getByTestId("overview")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-tab-files")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("file-note")).toHaveText("Derives the charge key from order id, amount and currency.");
  await expect(page).toHaveURL(/view=files.*file=src%2Fbilling%2Fidempotency\.ts/);
  await page.reload();
  await expect(page.getByTestId("file-note")).toBeVisible();
});

test("a PR with nothing read opens on the overview, unless the link names a view", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("reviewer.mockUnread", "1"));
  await page.goto(PR_PATH);
  await expect(page.getByTestId("overview")).toBeVisible();
  await page.goto(`${PR_PATH}?view=guide`);
  await expect(page.getByTestId("sidebar-tab-units")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("overview")).toHaveCount(0);
});

test("a unit in the overview opens in the Guide", async ({ page }) => {
  await page.keyboard.press("s");
  await page.getByTestId("start-reading").click();
  await expect(page.getByTestId("overview")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-tab-units")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("unit-header")).toBeVisible();
});

test("a review's inline comments jump from the overview to the diff", async ({ page }) => {
  await page.keyboard.press("s");
  await page.getByTestId("pr-reviews").getByTestId("verdict-inline-jump").first().click();
  await expect(page.getByTestId("overview")).toHaveCount(0);
  await expect(page.locator("[data-diff-scroller]")).toBeVisible();
});

test("V marks the whole unit viewed and moves on", async ({ page }) => {
  await page.mouse.move(5, 5);
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await page.keyboard.press("Shift+KeyV");
  // The unit is done, so the view advances to the next one in sidebar order.
  await expect(page.getByTestId("unit-header")).not.toContainText(UNITS.reconcile.slice(0, 30));
  // The row's own box reads fully viewed.
  await expect(page.getByTestId("unit-viewed-ledger-reconciliation")).toHaveAttribute("aria-checked", "true");
});

test("a unit's box marks it all viewed from its row, and unmarks it", async ({ page }) => {
  const box = page.getByTestId("unit-viewed-transient-retry-backoff");
  // Retry has one of its two hunks viewed in the fixture.
  await expect(box).toHaveAttribute("aria-checked", "mixed");
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "true");
  // Not the open unit: marking it does not move the reader.
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "false");
});

test("a risk is on a row where it changes what the reader does: any on a skim, an uncommon one on a must-read", async ({ page }) => {
  // The reconciliation unit is a skim that makes an external call: worth knowing before skimming it.
  await expect(page.getByTestId("unit-risk-ledger-reconciliation")).toHaveText("external call");
  await expect(page.getByTestId("unit-risk-ledger-reconciliation")).toHaveAttribute("data-tip", "Skim, but a risk surface: external call");
  // A must-read unit shows a risk only when it sets the unit apart: money is
  // on one unit of this PR, not most (a flag most units share stays off, see lib/risks.ts).
  await expect(page.getByTestId("unit-risk-idempotent-charge-path")).toHaveText("money");
  await expect(page.getByTestId("unit-risk-idempotent-charge-path")).toHaveAttribute("data-tip", /Sets this unit apart/);
});

test("a second click on the open unit folds its brief to the row, and another opens it", async ({ page }) => {
  const row = page.getByTestId("unit-row-ledger-reconciliation");
  await expect(page.getByTestId("unit-brief")).toBeVisible();
  await row.click();
  await expect(page.getByTestId("unit-brief")).toHaveCount(0);
  await expect(row).toHaveAttribute("aria-expanded", "false");
  // Still the open unit: the diff did not move.
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await row.click();
  await expect(page.getByTestId("unit-brief")).toBeVisible();
  // Folded, then another unit: it opens with its brief.
  await row.click();
  await openUnit(page, UNITS.charge);
  await expect(page.getByTestId("unit-brief")).toBeVisible();
});

test("the brief cites its unit in the chat and moves it to another group", async ({ page }) => {
  const brief = page.getByTestId("unit-brief");
  await brief.getByTestId("cite-unit-ledger-reconciliation").click();
  await expect(page.getByTestId("chat-panel").or(page.getByTestId("floating-chat")).first()).toBeVisible();
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await page.getByTestId("move-unit-must-read").click();
  await expect(page.getByTestId("group-must-read").locator("xpath=..")).toContainText(UNITS.reconcile.slice(0, 30));
});

test("the revision menu lights up what a revision changed", async ({ page }) => {
  await page.getByTestId("revision-menu").click();
  const r3 = page.getByTestId("highlight-revision-3");
  await expect(r3).toHaveAttribute("aria-pressed", "false");
  await r3.click();
  await expect(page.getByTestId("highlight-summary")).toBeVisible();
  // The sidebar marks the units that revision touched.
  await expect(page.locator('[data-testid^="unit-changed-"]').first()).toHaveAttribute("data-tip", "Changed in r3");
  // The menu may have closed on the scroll the highlight caused; reopened, it shows r3 on.
  const menu = page.getByTestId("revision-menu");
  if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  await expect(page.getByTestId("highlight-revision-3")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("highlight-revision-3").click();
  await expect(page.getByTestId("highlight-summary")).toHaveCount(0);
});

test("space / shift+space step between the hunks still to read, skipping viewed ones", async ({ page }) => {
  // The charge unit: 0001 is viewed in the fixture, 0003 and 0005 are not.
  await openUnit(page, UNITS.charge);
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Space");
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Shift+Space");
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-focused", "true");
  // From the first one still to read, backward wraps to the last.
  await page.keyboard.press("Shift+Space");
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
});

test("the overview lists the concepts the PR leans on", async ({ page }) => {
  await page.keyboard.press("s");
  const concepts = page.getByTestId("overview-concepts");
  await expect(concepts.getByTestId("concept")).toHaveCount(3);
  await expect(concepts).toContainText("Charge ledger");
  await expect(concepts.getByTestId("concept-new")).toHaveCount(2);
});

test("a concept the guide names is explained on hover, once per block", async ({ page }) => {
  await openUnit(page, UNITS.charge);
  const mark = page.getByTestId("unit-header").getByTestId("concept-mark").first();
  await expect(mark).toHaveAttribute("data-tip", /^Charge (key|ledger) \(new in this PR\): /);
});

test("the Files view shows the analysis's note on a file, or on its folder", async ({ page }) => {
  await page.getByRole("tab", { name: /files/i }).click();
  await page.locator("nav").getByText("ledger.ts").first().click();
  await expect(page.getByTestId("file-note")).toContainText("Charges once per key");
});

test("a hunk and a file offer to comment and to cite in chat on hover, with their icons", async ({ page }) => {
  const header = hunkHeader(page, A);
  await header.hover();
  const cite = header.getByRole("button", { name: "Cite this hunk in the chat" });
  await expect(cite).toHaveText("cite in chat");
  await expect(cite.locator("svg")).toHaveCount(1);
  const file = page.getByTestId("file-header-src/billing/reconcile.ts").first();
  await file.hover();
  await expect(file.getByRole("button", { name: /^Cite .* in the chat$/ }).locator("svg")).toHaveCount(1);
  await expect(file.getByTestId("add-file-comment-src/billing/reconcile.ts").locator("svg")).toHaveCount(1);
  // Citing attaches the hunk to the chat's message; nothing is sent.
  await header.hover();
  await cite.click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
});
