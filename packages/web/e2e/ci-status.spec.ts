import { test, expect } from "@playwright/test";
import { PR_PATH } from "./helpers";

test("the list marks mixed and passing CI beside the line counts and leaves unknown CI empty", async ({ page }) => {
  await page.goto("/");
  const failing = page.getByTestId("pr-row-github.com/acme/billing/482");
  const mark = failing.getByTestId("ci-mark");
  await expect(mark).toHaveText("1/3");
  await expect(mark).toHaveAttribute("data-tip", "CI failing (1 of 3): Unit tests");
  await expect(page.getByTestId("pr-row-github.com/acme/billing/491").getByTestId("ci-mark")).toHaveAttribute("data-tip", "CI passing");
  const unknown = page.getByTestId("pr-row-github.com/acme/billing/502");
  await expect(unknown).toBeVisible();
  await expect(unknown.getByTestId("ci-mark")).toHaveCount(0);
});

test("the header opens check details and run links, and Escape closes them", async ({ page }) => {
  await page.goto(PR_PATH);
  const mark = page.getByTestId("ci-mark");
  await expect(mark).toHaveText("1/3");
  await expect(mark).toHaveAttribute("data-tip", "CI failing (1 of 3): Unit tests");
  await mark.click();
  const panel = page.getByRole("dialog", { name: "CI checks" });
  await expect(panel.getByTestId("ci-check")).toHaveCount(3);
  await expect(panel.getByTestId("ci-check").first()).toContainText("failure");
  const link = panel.getByRole("link", { name: "Unit tests" });
  await expect(link).toHaveAttribute("href", "https://github.com/acme/billing/actions/runs/123");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(mark).toHaveAttribute("aria-expanded", "false");
});
