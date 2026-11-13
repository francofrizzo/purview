import { expect, test } from "@playwright/test";
import { openPr, openUnit, UNITS } from "./helpers";

test("leaving generated files out of line counts shrinks the list's size and moves the header's 'all' to 'all but generated'", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("whats-new-close").click();
  await page.getByText("Charge retries: idempotency keys + backoff").click();
  const header = page.getByTestId("change-size");
  // To "all": two clicks from the implementation's.
  await header.click();
  await header.click();
  await expect(header).toHaveAttribute("data-counts", "all");
  await page.goBack();

  const row = page.getByTestId("pr-row-github.com/acme/billing/482").getByTestId("diff-size");
  const every = await row.innerText();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "leave out generated", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveText(every);
  await expect(row).toHaveAttribute("data-tip", /generated files? left out/);

  await page.getByText("Charge retries: idempotency keys + backoff").click();
  await expect(header).toHaveAttribute("data-counts", "authored");
});

test("a file header carries its file's kind, in the change mix's colors", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.wiring);
  await expect(page.getByTestId("file-header-docs/billing.md")).toHaveAttribute("data-kind", "docs");
  await expect(page.getByTestId("file-header-src/container.ts")).toHaveAttribute("data-kind", "implementation");
  await openUnit(page, UNITS.retry);
  await expect(page.getByTestId("file-header-test/billing/charge.test.ts")).toHaveAttribute("data-kind", "tests");
});
