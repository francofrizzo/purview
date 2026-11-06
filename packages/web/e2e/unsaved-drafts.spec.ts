import { test, expect } from "@playwright/test";
import { UNITS, lineRow, openComments, openComposerOnLine, openPr, openUnit } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
});

test("opening another line puts the first box's text away; its pencil brings it back until it is saved", async ({ page }) => {
  await openComposerOnLine(page, 10);
  await page.getByTestId("composer-textarea").fill("first thought");
  await openComposerOnLine(page, 12);
  await expect(page.getByTestId("composer-textarea")).toHaveValue("");

  // Line 10 keeps a pencil; the drawer lists the text.
  const marker = lineRow(page, 10).getByTestId("comment-unsaved");
  await expect(marker).toBeVisible();
  await openComments(page);
  const section = page.getByTestId("drawer-section-unsaved");
  await expect(section).toContainText("first thought");

  await marker.click();
  await expect(page.getByTestId("composer-textarea")).toHaveValue("first thought");
  await page.getByTestId("composer-save").click();
  await expect(page.getByTestId("comment-composer")).toHaveCount(0);
  await expect(section).toHaveCount(0);
  await expect(page.getByTestId("comment-unsaved")).toHaveCount(0);
});

test("Escape and a reload keep the text; the × and the drawer's discard let it go", async ({ page }) => {
  await openComposerOnLine(page, 10);
  await page.getByTestId("composer-textarea").fill("kept across a reload");
  await page.getByTestId("composer-textarea").press("Escape");
  await expect(page.getByTestId("comment-composer")).toHaveCount(0);

  await page.reload();
  await openComments(page);
  const row = page.getByTestId("unsaved-draft");
  await expect(row).toContainText("kept across a reload");
  // Resuming from the drawer opens the box on its line with the text.
  await row.getByRole("button", { name: /kept across a reload/ }).click();
  await expect(page.getByTestId("composer-textarea")).toHaveValue("kept across a reload");
  await page.getByTestId("comment-composer").getByRole("button", { name: "Discard" }).click();
  await expect(row).toHaveCount(0);

  await openComposerOnLine(page, 10);
  await expect(page.getByTestId("composer-textarea")).toHaveValue("");
  await page.getByTestId("composer-textarea").fill("second");
  await openComposerOnLine(page, 12);
  await page.getByTestId("unsaved-discard").click();
  await expect(page.getByTestId("drawer-section-unsaved")).toHaveCount(0);
});
