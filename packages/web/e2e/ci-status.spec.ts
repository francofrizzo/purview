import { test, expect } from "@playwright/test";
import { PR_PATH } from "./helpers";

test("the list shows mixed and passing CI and leaves unknown CI empty", async ({ page }) => {
  await page.goto("/");
  const failing = page.getByTestId("pr-row-github.com/acme/billing/482");
  await expect(failing.getByTestId("ci-chip").filter({ visible: true })).toHaveText("failing · 1 of 3");
  await expect(page.getByTestId("pr-row-github.com/acme/billing/491").getByTestId("ci-chip").filter({ visible: true })).toHaveText("passing");
  const unknown = page.getByTestId("pr-row-github.com/acme/billing/502");
  await expect(unknown).toBeVisible();
  await expect(unknown.getByTestId("ci-chip")).toHaveCount(0);
});

test("the header opens check details and run links, and Escape closes them", async ({ page }) => {
  await page.goto(PR_PATH);
  const chip = page.getByTestId("ci-chip");
  await expect(chip).toHaveAttribute("title", "Unit tests");
  await chip.click();
  const panel = page.getByRole("dialog", { name: "CI checks" });
  await expect(panel.getByTestId("ci-check")).toHaveCount(3);
  await expect(panel.getByTestId("ci-check").first()).toContainText("failure");
  const link = panel.getByRole("link", { name: "Unit tests" });
  await expect(link).toHaveAttribute("href", "https://github.com/acme/billing/actions/runs/123");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-expanded", "false");
});
