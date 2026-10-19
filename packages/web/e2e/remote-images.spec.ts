import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

/**
 * Pictures GitHub hosts are drawn through the local server's proxy
 * (`/api/prs/:key/image?url=…`, answered by a stand-in in mock mode — see
 * vite.config.ts); any other image in the same text stays a link.
 */
test("the description shows GitHub-hosted pictures and keeps other images as links", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("summary-strip-has-description").click();
  const description = page.getByTestId("pr-description");
  await expect(description).toBeVisible();

  const picture = description.locator('img[data-testid="attachment-media"]');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("alt", "retry flow");
  const src = await picture.getAttribute("src");
  expect(src).toMatch(/^\/api\/prs\/[^/]+\/image\?url=/);
  expect(decodeURIComponent(src!.split("url=")[1])).toBe(
    "https://github.com/user-attachments/assets/4f1c9a2e-7b3d-4e8a-9c21-6d5e0f7a8b19",
  );
  // Loaded, not a broken image: the stand-in has a size.
  await expect.poll(() => picture.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  // The picture opens the GitHub URL, not the proxy.
  await expect(description.locator("a", { has: page.locator('img[data-testid="attachment-media"]') })).toHaveAttribute(
    "href",
    "https://github.com/user-attachments/assets/4f1c9a2e-7b3d-4e8a-9c21-6d5e0f7a8b19",
  );

  const external = description.getByRole("link", { name: /gateway$/ });
  await expect(external).toBeVisible();
  await expect(external).toHaveAttribute("href", "https://docs.example.com/gateway/idempotency.png");
  expect(await description.locator('img[data-testid="attachment-media"]').count()).toBe(1);
});
