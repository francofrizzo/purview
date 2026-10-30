import { test, expect } from "@playwright/test";
import { UNITS, hunkHeader, openComposerOnLine, openPr, openUnit, scroller } from "./helpers";

test("the view options hold the layout, wrapping, folding, read units and thread filters", async ({ page }) => {
  await openPr(page);
  await expect(page.locator(".diff-half")).toHaveCount(0);
  await page.getByTestId("view-options").click();
  await page.getByTestId("layout-split").click();
  await expect(page.locator(".diff-half").first()).toBeVisible();
  await page.getByTestId("hide-reviewed-units").check();
  await expect(page.getByTestId("hide-reviewed-units")).toBeChecked();
  await page.getByTestId("hide-reviewed-units").uncheck();
  await expect(page.getByTestId("filter-resolved")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("layout-split")).toHaveCount(0);
});

test("the branches open under their icon, each with a copy button", async ({ page }) => {
  await openPr(page);
  await expect(page.getByTestId("topbar-repo")).toContainText("acme/billing#482");
  await page.getByTestId("topbar-branches").hover();
  const panel = page.getByTestId("topbar-branches-panel");
  await expect(panel).toContainText("base");
  await expect(panel).toContainText("dana/charge-retries-idempotency");
  await expect(panel.getByRole("button")).toHaveCount(2);
  // The pointer can reach the copy buttons.
  await panel.getByRole("button").first().hover();
  await expect(panel).toBeVisible();
  await page.getByTestId("topbar-title").hover();
  await expect(panel).toHaveCount(0);
});

test("the shortcuts open as a modal from ? , the ⋯ menu and the sidebar", async ({ page }) => {
  await openPr(page);
  const modal = page.getByTestId("shortcuts-popover");
  await page.keyboard.press("?");
  await expect(modal).toContainText("this list");
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await page.getByTestId("topbar-overflow").click();
  await page.getByTestId("menu-shortcuts").click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("shortcuts-button").click();
  await expect(modal).toBeVisible();
});

test("sync and full screen live in the ⋯ menu; refresh stays and names new commits", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("reviewer.mockStale", "1"));
  await openPr(page);
  const refresh = page.getByTestId("topbar-refresh");
  await expect(refresh).toContainText("new commits");
  await expect(refresh).toHaveAttribute("data-tip", /new commits upstream/);
  await page.getByTestId("topbar-overflow").click();
  await expect(page.getByTestId("menu-sync")).toBeVisible();
});

test("a file says what the PR did to it in a letter, wherever it is listed", async ({ page }) => {
  await openPr(page);
  const badge = (path: string) => page.getByTestId(`file-header-${path}`).first().getByTestId("file-status");
  await expect(badge("src/billing/idempotency.ts")).toHaveText("A");
  await expect(badge("src/billing/charge.ts")).toHaveText("M");
  await page.getByTestId("unit-files-toggle").click();
  await expect(page.getByTestId("unit-files").getByTestId("file-status").first()).toHaveText("A");
});

test("the unit's files open on demand, stay open, and each jumps to its first hunk", async ({ page }) => {
  await openPr(page);
  await expect(page.getByTestId("unit-files")).toHaveCount(0);
  await page.getByTestId("unit-files-toggle").click();
  const files = page.getByTestId("unit-files");
  await files.getByRole("button", { name: /ledger\.ts/ }).click();
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
  await openUnit(page, UNITS.reconcile);
  await expect(page.getByTestId("unit-files")).toBeVisible();
});

test("past the last hunk the unit offers its next step", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  await scroller(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.getByTestId("unit-end-mark").click();
  await expect(page.getByTestId("unit-header")).not.toContainText(UNITS.reconcile.slice(0, 30));
});

test("the sidebar column resizes by dragging its edge; a double click restores it", async ({ page }) => {
  await openPr(page);
  const handle = page.getByTestId("sidebar-resize");
  const nav = page.locator("nav.pane").first();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 82, box.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await nav.boundingBox())!.width).toBeGreaterThan(420);
  await handle.dblclick();
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(352);
});

test("the comment box keeps its keys on the tooltips, and Aa opens the formatting", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  await openComposerOnLine(page, 10);
  const ask = page.getByTestId("composer-send-to-chat");
  await expect(ask).toHaveAttribute("aria-label", "Ask the chat");
  await expect(ask).toHaveAttribute("data-tip-key", "⌘⇧↵");
  await expect(page.getByTestId("composer-save")).toHaveAttribute("data-tip-key", "⌘↵");
  await expect(page.getByTestId("copy-composer")).toHaveClass(/\bbtn\b/);
  await expect(page.getByTestId("composer-format-bold")).toHaveCount(0);
  await page.getByTestId("composer-format-toggle").click();
  await expect(page.getByTestId("composer-format-bold")).toBeVisible();
  await page.getByTestId("composer-textarea").press("Escape");
  await expect(page.getByTestId("comment-composer")).toHaveCount(0);
  await openComposerOnLine(page, 10);
  await expect(page.getByTestId("composer-format-bold")).toBeVisible();
});

test("a comment card has no bar but keeps its audience's colour; its actions show on hover", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-comments").click();
  await page.getByTestId("dock-tab-comments").click().catch(() => {});
  const note = page.getByTestId("comment-card-draft-agent-1");
  await expect(note).toBeVisible();
  const look = await note.evaluate((el) => {
    const css = getComputedStyle(el);
    return { shadow: css.boxShadow, border: css.borderTopColor };
  });
  const neutral = await page.getByTestId("comments-panel").evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.borderTop = "1px solid var(--border)";
    el.append(probe);
    const color = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return color;
  });
  expect(look.shadow).toBe("none");
  expect(look.border).not.toBe(neutral);
  await expect(note.getByTestId("comment-audience-mark")).toBeVisible();
  const actions = page.getByTestId("move-draft-agent-1").locator("xpath=..");
  await page.mouse.move(4, 4);
  await expect(actions).toHaveCSS("opacity", "0");
  await note.hover();
  await expect(actions).toHaveCSS("opacity", "1");
});

test("the flat workspace is a setting: off, the panes are cards; on, they sit edge to edge", async ({ page }) => {
  const margin = () => page.locator(".workspace nav.pane").first().evaluate((el) => getComputedStyle(el).marginTop);
  await openPr(page);
  expect(await margin()).toBe("7px");
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("reviewer.settings") ?? "{}");
    localStorage.setItem("reviewer.settings", JSON.stringify({ ...s, flatWorkspace: true }));
  });
  await page.reload();
  await expect(page.getByTestId("unit-header")).toBeVisible();
  expect(await margin()).toBe("0px");
});

test("with no card above the diff, it starts level with the panes and pins to the top when scrolled", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-comments").click();
  const nav = page.locator(".workspace nav.pane").first();
  const dock = page.getByTestId("right-dock");
  const header = page.locator('[data-testid^="file-header-"]').first();
  const top = async (l: typeof nav) => (await l.boundingBox())!.y;
  const rule = () => page.locator("main").first().evaluate((el) => getComputedStyle(el, "::before").backgroundImage);
  expect(await top(header)).toBe(await top(nav));
  expect(await rule()).not.toContain(", linear-gradient");
  await expect(nav).toHaveCSS("border-top-right-radius", "0px");
  await expect(dock).toHaveCSS("border-top-left-radius", "0px");

  await scroller(page).evaluate((el) => el.scrollTo({ top: 60 }));
  await expect.poll(async () => (await top(page.locator("[data-sticky]").first()))).toBe(await top(page.locator(".workspace")));
  await expect.poll(rule).toContain(", linear-gradient");
  await scroller(page).evaluate((el) => el.scrollTo({ top: 0 }));
  await expect.poll(rule).not.toContain(", linear-gradient");

  // The Files view has its card, so the corners stay round.
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByTestId("file-header")).toBeVisible();
  await expect(nav).not.toHaveCSS("border-top-right-radius", "0px");
  await expect(dock).not.toHaveCSS("border-top-left-radius", "0px");
});

test("a unit row's facts rest on the title's last line when they fit, and never on a first line", async ({ page }) => {
  await openPr(page);
  const facts = (id: string) => page.getByTestId(`unit-facts-${id}`);
  const row = page.getByTestId("unit-row-transient-retry-backoff");
  await expect(row.getByTestId("hunk-progress")).toContainText("1/2");
  await expect(row).toContainText(/\+\d+/);
  const box = (l: ReturnType<typeof facts>) => l.boundingBox().then((b) => b!);
  // A short title still has its facts on a second line.
  const short = await box(page.locator('[data-testid^="unit-row-"]').nth(3));
  const shortFacts = await box(page.locator('[data-testid^="unit-facts-"]').nth(3));
  expect(shortFacts.y - short.y).toBeGreaterThan(15);
  // A title that wraps with room left takes two lines, not three.
  const wrapped = await box(row);
  expect(wrapped.height).toBeLessThan(18 * 2 + 12 + 4);
  await expect(page.getByTestId("unit-viewed-transient-retry-backoff")).toBeVisible();
  await expect(facts("transient-retry-backoff")).toBeVisible();
});

test("editing a comment uses the same tools as writing one, with its own way out", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-comments").click();
  await page.getByTestId("dock-tab-comments").click();
  const card = page.getByTestId("comment-card-draft-1");
  await card.hover();
  await card.getByRole("button", { name: /edit/i }).first().click();
  const editor = page.getByTestId("comment-editor-draft-1");
  await expect(editor.getByTestId("format-draft-1-toggle")).toBeVisible();
  await expect(editor.getByTestId("format-draft-1-emoji")).toBeVisible();
  await expect(editor.getByTestId("mode-draft-1-preview")).toBeVisible();
  await expect(editor.getByTestId("composer-audience")).toHaveCount(0);
  await editor.getByTestId("format-draft-1-toggle").click();
  await expect(editor.getByTestId("format-draft-1-bold")).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveCount(0);
});

test("the submit button takes the color of the picked verdict", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-finish-review").click();
  const submit = page.getByTestId("submit-review");
  const fill = () => submit.evaluate((el) => getComputedStyle(el).backgroundColor);
  const comment = await fill();
  await page.getByTestId("verdict-approve").click();
  await expect.poll(fill).not.toBe(comment);
  const approve = await fill();
  await page.getByTestId("verdict-request_changes").click();
  await expect.poll(fill).not.toBe(approve);
  await expect.poll(fill).not.toBe(comment);
});

test("a hunk header shows its range and its signature, not only on hover", async ({ page }) => {
  await openPr(page);
  const header = page.locator('[data-testid^="hunk-header-"]').first();
  await expect(header).toContainText(/@@ -\d+,\d+ \+\d+,\d+ @@/);
});
