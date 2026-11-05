import { expect, test } from "@playwright/test";

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
