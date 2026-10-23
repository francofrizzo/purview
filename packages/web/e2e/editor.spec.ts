import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test("opens the managed PR copy after confirmation and shows preparation", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-overflow").click();
  const item = page.getByTestId("menu-open-editor");
  await expect(item).toHaveText(/^open in /);
  await expect(item).toHaveAttribute("data-tip", /^Purview's own copy of this PR, detached at its head commit, in /);
  await item.click();
  const confirm = page.getByTestId("editor-confirm");
  await expect(confirm).toContainText("Edits there are on no branch.");
  await confirm.getByRole("checkbox", { name: "Don't ask again" }).check();
  await confirm.getByRole("button", { name: "Open", exact: true }).click();
  // The confirm box shows the wait and closes when the editor has been launched.
  await expect(confirm.getByRole("button", { name: /Preparing checkout/ })).toBeVisible();
  await expect(confirm).toHaveCount(0);
  // Confirmed once: the menu item itself shows the wait from now on.
  await page.getByTestId("topbar-overflow").click();
  await expect(item).toHaveText(/^open in /);
  await item.click();
  await expect(confirm).toHaveCount(0);
  await expect(item).toHaveText("preparing checkout…");
  await expect(item).toBeDisabled();
  await expect(item).toHaveText(/^open in /);
});
