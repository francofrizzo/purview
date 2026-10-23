import { test, expect } from "@playwright/test";

/**
 * Tags and stacks on the home page: a block groups its rows under a tag
 * heading, a PR stacked on another in the same group hangs under it as a
 * tree, the hover tag icon opens the editor, and a tag survives navigation.
 */
test("tags group rows, stacks hang under their base, and edits persist", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("whats-new-close").click().catch(() => {});
  const baseKey = "github.com/acme/billing/491";
  const childKey = "github.com/acme/billing/502";
  const base = page.getByTestId(`pr-row-${baseKey}`);
  const child = page.getByTestId(`pr-row-${childKey}`);
  const block = page.getByTestId("mine-github.com/acme/billing");

  // The heading carries the tag; rows under it do not repeat it.
  await expect(block.getByTestId("pr-tag-heading").getByTestId("pr-tag")).toHaveText(["payments"]);
  await expect(base.getByTestId("pr-tag")).toHaveCount(0);

  // The child hangs under its base, indented, with the tree beside it and no
  // "stacked on" text (the tree says it).
  await expect(base.locator("+ li")).toHaveAttribute("data-testid", `pr-row-${childKey}`);
  await expect(child).toHaveAttribute("data-depth", "1");
  await expect(child.getByTestId("stack-tree")).toBeAttached();
  await expect(child.getByTestId("pr-stacked-on")).toHaveCount(0);
  await expect(base).toHaveCSS("border-bottom-width", "0px");

  // Retag the child from the hover icon: it leaves the stack for its own group.
  await child.hover();
  await child.getByTestId(`tag-${childKey}`).click();
  const input = page.getByTestId("tag-input");
  await expect(input).toHaveValue("payments");
  await input.fill("  Alpha  ");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(block.getByTestId("pr-tag-heading").getByTestId("pr-tag")).toHaveText(["alpha", "payments"]);
  await expect(child).not.toHaveAttribute("data-depth");
  // Out of the tree, the base is still named in the detail line.
  await expect(child.getByTestId("pr-stacked-on")).toHaveText("stacked on #491");

  // The header shows the tag; the mock persisted it.
  await child.getByRole("link").first().click();
  await expect(page.getByTestId("header-tag")).toHaveText("alpha");
  await page.goBack();
  await expect(block.getByTestId("pr-tag-heading").getByTestId("pr-tag")).toHaveText(["alpha", "payments"]);

  // Pick an existing tag from the suggestions: back into the stack.
  await child.hover();
  await child.getByTestId(`tag-${childKey}`).click();
  await page.getByTestId("tag-pick-payments").click();
  await expect(page.getByTestId("tag-input")).toHaveCount(0);
  await expect(child).toHaveAttribute("data-depth", "1");

  // Remove the tag: the row joins the untagged rows at the end of the block.
  await child.hover();
  await child.getByTestId(`tag-${childKey}`).click();
  await page.getByTestId("tag-remove").click();
  await expect(page.getByTestId("tag-input")).toHaveCount(0);
  await expect(block.getByTestId("pr-tag-group").last()).toHaveAttribute("data-tag", "");
  await expect(block.getByTestId("pr-tag-group").last().getByTestId(`pr-row-${childKey}`)).toBeVisible();
});
