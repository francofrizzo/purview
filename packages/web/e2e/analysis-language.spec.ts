import { test, expect } from "@playwright/test";

test("the analysis language is picked from a list, or typed as any other name", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("settings-nav-agents").click();
  const select = page.getByTestId("global-analysis-language-select");
  const other = page.getByTestId("global-analysis-language-other");
  await expect(select).toHaveValue("pr");
  await expect(other).toHaveCount(0);

  await select.selectOption({ label: "Español" });
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("Spanish");

  // Other opens a name field, ready to type; Enter saves it as written.
  await select.selectOption("other");
  await expect(other).toBeFocused();
  await other.fill("Rioplatense Spanish");
  await other.press("Enter");
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("other");
  await expect(other).toHaveValue("Rioplatense Spanish");

  // Back to the PR's own language: the name field goes away.
  await select.selectOption("pr");
  await expect(other).toHaveCount(0);
  await expect(select).toHaveValue("pr");
});

test("Other left empty goes back to the language that was set", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("settings-nav-agents").click();
  const select = page.getByTestId("global-analysis-language-select");
  await select.selectOption("other");
  await expect(page.getByTestId("global-analysis-language-other")).toBeFocused();
  await page.getByTestId("global-analysis-language-other").blur();
  await expect(page.getByTestId("global-analysis-language-other")).toHaveCount(0);
  await expect(select).toHaveValue("pr");
});
