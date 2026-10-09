import { test, expect } from "@playwright/test";
import { PR_PATH } from "./helpers";

for (const width of [1280, 768, 390]) {
  test(`at ${width}px the title is fully visible and nothing overflows sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(PR_PATH);
    const title = page.getByTestId("topbar-title");
    await expect(title).toHaveText("Charge retries: idempotency keys + backoff");
    await expect(page.locator("[data-testid^=hunk-header-]").first()).toBeVisible();

    const m = await page.evaluate(() => {
      const title = document.querySelector('[data-testid="topbar-title"]') as HTMLElement;
      const header = title.closest("header") as HTMLElement;
      const t = title.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      const probe = document.createElement("span");
      probe.textContent = title.textContent;
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(title).font}`;
      document.body.appendChild(probe);
      const textWidth = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        titleClipped: title.scrollWidth > title.clientWidth + 1 || textWidth > t.width + 1,
        titleInsideHeader: t.left >= h.left && t.right <= h.right + 1,
        headerOverflow: header.scrollWidth > header.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        viewport: window.innerWidth,
      };
    });
    expect(m.viewport).toBe(width);
    expect(m.titleClipped, "title text is truncated").toBe(false);
    expect(m.titleInsideHeader).toBe(true);
    expect(m.headerOverflow, "header overflows horizontally").toBe(false);
    expect(m.pageOverflow, "page overflows horizontally").toBe(false);
  });
}
