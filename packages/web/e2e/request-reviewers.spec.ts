import { test, expect } from "@playwright/test";

const YOURS_OPEN = "/pr/github.com/acme/billing/502";

test("on your PR the reviewers open a panel to ask someone, ask again, or stop asking", async ({ page }) => {
  await page.goto(YOURS_OPEN);
  const button = page.getByTestId("reviewers-button");
  await expect(button).toBeVisible();
  await button.click();
  const panel = page.getByTestId("reviewers-panel");
  await expect(panel.getByTestId("reviewers-row")).toHaveCount(3);
  // Typing goes straight into the search.
  await expect(panel.getByTestId("reviewers-search")).toBeFocused();

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

test("the Review panel on your PR has the same reviewers section", async ({ page }) => {
  await page.goto(YOURS_OPEN);
  await page.getByTestId("topbar-finish-review").click();
  const section = page.getByTestId("review-panel-reviewers");
  await expect(section.getByTestId("reviewers-row")).toHaveCount(3);
  // Who reviews is not part of the review: it heads the panel, above the summary.
  const top = (await section.boundingBox())!.y;
  expect(top).toBeLessThan((await page.getByTestId("review-summary").boundingBox())!.y);
  // The candidates drop down only while the search has focus.
  await expect(section.getByTestId("reviewers-candidates")).toHaveCount(0);
  await section.getByTestId("reviewers-search").focus();
  await expect(section.getByTestId("reviewers-candidate-maria")).toBeVisible();
  await section.getByTestId("reviewers-search").fill("kai");
  await section.getByTestId("reviewers-candidate-kai").click();
  await expect(section.getByTestId("reviewers-row")).toHaveCount(4);
  // The header's cluster follows.
  await expect(page.getByTestId("reviewers-button").getByTestId("reviewer")).toHaveCount(4);
});
