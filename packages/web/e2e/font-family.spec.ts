import { test, expect } from "@playwright/test";

test("the code font box keeps a space typed between words, and a chip replaces what it holds", async ({ page }) => {
  await page.goto("/settings");
  const box = page.getByPlaceholder("default monospace stack");
  await box.fill("");
  await box.pressSequentially("Rec Mono Linear");
  await expect(box).toHaveValue("Rec Mono Linear");
  await page.getByRole("button", { name: "JetBrains Mono", exact: true }).click();
  await expect(box).toHaveValue("JetBrains Mono");
  await expect(page.getByRole("button", { name: "Rec Mono Linear", exact: true })).toBeVisible();
});
