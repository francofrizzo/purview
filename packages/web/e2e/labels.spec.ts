import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

// The fixture's charge unit labels its ledger hunk (…0005, an ordinary hunk
// in a unit with a heart): the analysis's words replace the derived hint.
const LABELLED = "a1b2c3d4e5f60005";
const HEART = "a1b2c3d4e5f60003";
const HEART_WITH_LABEL = "a1b2c3d4e5f60001";

test("an ordinary hunk shows the analysis's label on its header instead of the derived hint", async ({ page }) => {
  await openPr(page);
  await expect(page.getByTestId(`hunk-label-${LABELLED}`)).toHaveText("ledger table and its writes");
  await expect(page.getByTestId(`hunk-hint-${LABELLED}`)).toHaveCount(0);
  // A heart hunk carries its captions; a label chip too when the analysis gave it one.
  await expect(page.getByTestId(`hunk-label-${HEART}`)).toHaveCount(0);
  await expect(page.getByTestId(`hunk-heart-${HEART}`).first()).toBeVisible();
  await expect(page.getByTestId(`hunk-label-${HEART_WITH_LABEL}`)).toHaveText("charge() rewired around the ledger");
});
