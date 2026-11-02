import { test, expect } from "@playwright/test";

const YOURS_OPEN = "/pr/github.com/acme/billing/502";

test("on your PR the reviewers open a panel to ask someone, ask again, or stop asking", async ({ page }) => {
  await page.goto(YOURS_OPEN);
  const button = page.getByTestId("reviewers-button");
  await expect(button).toBeVisible();
  await button.click();
  const panel = page.getByTestId("reviewers-panel");
  await expect(panel.getByTestId("reviewers-row")).toHaveCount(3);

  // GitHub's suggestions show before anything is typed.
  await expect(panel.getByTestId("reviewers-candidate-maria")).toContainText("suggested");
  await panel.getByTestId("reviewers-search").fill("pay");
  await panel.getByTestId("reviewers-candidate-payments").click();
  await expect(panel.getByTestId("reviewers-row")).toHaveCount(4);
  await expect(panel.getByTestId("reviewers-row").first()).toContainText("payments");

  // A pending request can be taken back; someone who answered can be asked again.
  await panel.getByTestId("reviewers-remove-dana").click();
  await expect(panel.getByTestId("reviewers-row")).toHaveCount(3);
  await panel.getByTestId("reviewers-rerequest-sam").click();
  await expect(panel.getByTestId("reviewers-row").filter({ hasText: "sam" })).toContainText("requested");
});
