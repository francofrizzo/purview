import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test("header picker confirms, prepares and remembers the editor", async ({ page }) => {
  await openPr(page);
  const button = page.getByTestId("topbar-editor");
  await expect(button).toHaveAttribute("data-tip", "Open Purview's own copy of this PR, detached at its head commit");
  await button.click();
  await page.getByTestId("editor-pick-code").click();
  const confirm = page.getByTestId("editor-confirm");
  await expect(confirm).toContainText("Edits there are on no branch.");
  await expect(confirm.getByRole("checkbox", { name: "Don't show again" })).toBeChecked();
  await confirm.getByRole("button", { name: "Open", exact: true }).click();
  await expect(button).toHaveText("preparing checkout…");
  await expect(button).toBeDisabled();
  await expect(confirm).toHaveCount(0);
  await expect(button).toHaveText("open in editor");
  await button.click();
  await expect(page.getByTestId("editor-pick-code")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("editor-pick-code").click();
  await expect(confirm).toHaveCount(0);
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled();
});

test("a named custom command opens and appears in the picker", async ({ page }) => {
  await openPr(page);
  const button = page.getByTestId("topbar-editor");
  await button.click();
  await page.getByRole("button", { name: "Custom command…", exact: true }).click();
  await page.getByLabel("Custom editor name").fill("Nova");
  await page.getByLabel("Custom editor command").fill('nova "{path}"');
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const confirm = page.getByTestId("editor-confirm");
  await expect(confirm).toContainText("in Nova");
  await confirm.getByRole("button", { name: "Open", exact: true }).click();
  await expect(button).toBeDisabled();
  await expect(confirm).toHaveCount(0);
  await button.click();
  await expect(page.getByTestId("editor-pick-custom")).toHaveText("Nova");
  await expect(page.getByTestId("editor-pick-custom")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("editor-pick-custom").click();
  await expect(confirm).toHaveCount(0);
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled();
});
