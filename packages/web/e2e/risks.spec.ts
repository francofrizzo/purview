import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test("risk captions name the flag at its lines alongside the heart bar", async ({ page }) => {
  await openPr(page);
  const caption = page.getByTestId("hunk-risk-a1b2c3d4e5f60003");
  await expect(caption).toBeVisible();
  await expect(caption).toContainText("money");
  await expect(caption).toContainText("A key collision can replay another order’s charge.");
  await expect(page.locator('[data-heart="true"][data-risk="true"] .risk-bar').first()).toBeVisible();
  await page.getByTestId("hunk-toggle-a1b2c3d4e5f60001").click();
  const ranged = page.getByTestId("hunk-risk-a1b2c3d4e5f60001");
  await expect(ranged).toContainText("external call");
  const captionIndex = Number(await ranged.locator("xpath=..").getAttribute("data-index"));
  const firstRow = page.locator('[data-index]', { hasText: "const res = await this.retry(() =>" }).first();
  await expect(firstRow).toHaveAttribute("data-risk", "true");
  await expect(page.locator(`[data-index="${captionIndex + 1}"]`)).toHaveAttribute("data-risk", "true");
  await expect(page.locator(`[data-index="${captionIndex + 1}"]`)).toContainText("24");
});

for (const mode of ["unified", "split"] as const) {
  test(`smells mark their span independently of risk and heart layers (${mode})`, async ({ page }) => {
    await page.addInitScript((diffViewMode) => {
      localStorage.setItem("reviewer.settings", JSON.stringify({ diffViewMode }));
    }, mode);
    await openPr(page);
    const smell = page.getByTestId("hunk-smell-a1b2c3d4e5f60003");
    await expect(smell).toContainText("test gap?");
    await expect(smell).toContainText("changing only the currency");
    const keyRow = page.locator("[data-index]", { hasText: '.update(`${orderId}:${amount}:${currency}`)' }).first();
    await expect(keyRow).toHaveAttribute("data-smell", "true");
    await expect(keyRow).toHaveAttribute("data-risk", "true");
    await expect(keyRow).toHaveAttribute("data-heart", "true");
    const otherRow = page.locator("[data-index]", { hasText: '.digest("hex")' }).first();
    await expect(otherRow).not.toHaveAttribute("data-smell", "true");
    await page.getByTestId("hunk-toggle-a1b2c3d4e5f60003").click();
    await expect(smell).toBeVisible();
    await expect(page.getByTestId("hunk-header-a1b2c3d4e5f60003")).toHaveAttribute("data-collapsed", "true");
  });
}
