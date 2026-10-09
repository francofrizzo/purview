import { test, expect } from "@playwright/test";
import { MOD, UNITS, lineRow, newGutter, openComposerOnLine, openPr, openUnit } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
});

test("compose on a line: type, bold with the chord, preview, save shows the marker", async ({ page }) => {
  const row = await openComposerOnLine(page, 10);
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toContainText("on line 10");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("needs a test");
  await textarea.evaluate((el: HTMLTextAreaElement) => el.select());
  await page.keyboard.press(`${MOD}+b`);
  await expect(textarea).toHaveValue("**needs a test**");

  // Write / Preview, by the chord and back by the button.
  await page.keyboard.press(`${MOD}+Shift+p`);
  await expect(page.getByTestId("composer-mode-preview")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("composer-preview").locator("strong")).toHaveText("needs a test");
  await expect(textarea).toBeHidden();
  await page.getByTestId("composer-mode-write").click();
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue("**needs a test**");

  await page.getByTestId("composer-save").click();
  await expect(composer).toHaveCount(0);
  await expect(row.getByTestId("comment-bubble")).toBeVisible();
  await expect(page.getByTestId("topbar-comments")).toContainText(/\d+/);
});

test("a gutter range opens the composer on lines A–B, and 'Suggest a change' prefills them", async ({ page }) => {
  const from = newGutter(lineRow(page, 11));
  const to = newGutter(lineRow(page, 13));
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();

  await expect(page.getByTestId("quote-selection")).toContainText("reconcile.ts:11–13");
  await page.getByTestId("comment-selection-button").click();
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toContainText("on lines 11–13");

  await page.getByTestId("composer-format-suggestion").click();
  const value = await page.getByTestId("composer-textarea").inputValue();
  expect(value).toBe(
    ["```suggestion", "  ledger: ChargeResult | null;", "  gateway: GatewayCharge | null;", "  verdict: Verdict;", "```", ""].join("\n"),
  );
  // The code inside the fence is selected, so typing replaces it.
  const sel = await page.getByTestId("composer-textarea").evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  expect(sel).toBe("  ledger: ChargeResult | null;\n  gateway: GatewayCharge | null;\n  verdict: Verdict;");
});

test("pasting a picture attaches it and shows a thumbnail", async ({ page }) => {
  await openComposerOnLine(page, 10);
  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("see ");
  await textarea.evaluate((el) => {
    // A 1x1 PNG, as the clipboard would hand it over.
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    const dt = new DataTransfer();
    dt.items.add(new File([png], "shot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('[data-testid^="attachment-thumb-"]')).toHaveCount(1);
  await expect(textarea).toHaveValue(/purview-attachment:/);
});

test("`n` opens the composer: on the gutter range, else on the focused hunk's first changed line", async ({ page }) => {
  const from = newGutter(lineRow(page, 11));
  const to = newGutter(lineRow(page, 13));
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("quote-selection")).toContainText("reconcile.ts:11–13");
  await page.keyboard.press("n");
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toContainText("on lines 11–13");
  await expect(page.getByTestId("quote-selection")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(composer).toHaveCount(0);

  await page.mouse.move(5, 5);
  await page.keyboard.press("j");
  await page.keyboard.press("n");
  const prompt = page.getByTestId("line-prompt-input");
  await expect(prompt).toBeFocused();
  const prefilled = await prompt.inputValue();
  expect(prefilled).toMatch(/^\d+$/);
  await page.keyboard.press("Enter");
  await expect(composer).toContainText(`on line ${prefilled}`);
  await page.keyboard.press("Escape");
  await expect(composer).toHaveCount(0);

  // Digits pick another line of the same file; a range works too.
  await page.keyboard.press("n");
  await prompt.fill("11-13");
  await page.keyboard.press("Enter");
  await expect(composer).toContainText("on lines 11–13");
  await page.keyboard.press("Escape");

  // A line outside the diff is refused, and the prompt stays open to fix it.
  await page.keyboard.press("n");
  await prompt.fill("9999");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("line-prompt")).toContainText("not in this file's diff");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("line-prompt")).toHaveCount(0);
});
