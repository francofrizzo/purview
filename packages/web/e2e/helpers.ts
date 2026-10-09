import { expect, type Locator, type Page } from "@playwright/test";

/** The fixture PR (packages/web/src/mocks/fixture.ts). */
export const PR_PATH = "/pr/github.com/acme/billing/482";

/** ⌘ on a Mac, Ctrl elsewhere — the app reads both, the OS only sends one. */
export const MOD = process.platform === "darwin" ? "Meta" : "Control";

export const UNITS = {
  charge: "Idempotent charge path with ledger-backed replay",
  retry: "Retry wrapper with jittered exponential backoff",
  wiring: "Container wiring, call-site threading and docs",
  reconcile: "Nightly reconciliation of the ledger against the gateway",
};

/** Hunks of the reconciliation unit, in diff order (fixture ids). */
export const RECONCILE_HUNKS = [
  "a1b2c3d4e5f6000d",
  "a1b2c3d4e5f6000e",
  "a1b2c3d4e5f6000f",
  "a1b2c3d4e5f60011",
  "a1b2c3d4e5f60012",
];

export async function openPr(page: Page) {
  await page.goto(PR_PATH);
  await expect(page.getByTestId("unit-header")).toBeVisible();
  await expect(page.locator("[data-testid^=hunk-header-]").first()).toBeVisible();
}

/** Select a review unit from the sidebar column (1280px wide: no drawer). */
export async function openUnit(page: Page, title: string) {
  const nav = page.locator("nav");
  const unit = nav.getByText(title).first();
  // The "skip" group starts folded; its units are only there once it opens.
  if (!(await unit.isVisible())) await nav.getByRole("button", { name: /^skip/i }).click();
  await unit.click();
  await expect(page.getByTestId("unit-header")).toContainText(title.slice(0, 30));
}

export const scroller = (page: Page) => page.locator("[data-diff-scroller]");
export const hunkHeader = (page: Page, id: string) => page.getByTestId(`hunk-header-${id}`);

/** A hunk header's top edge, relative to the scroller's top edge. */
export async function headerTop(page: Page, id: string): Promise<number> {
  return page.evaluate((hunkId) => {
    const sc = document.querySelector("[data-diff-scroller]")!;
    const el = document.querySelector(`[data-testid="hunk-header-${hunkId}"]`);
    if (!el) return Number.NaN;
    return el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  }, id);
}

/** Height of the file header row (what a focused hunk lands under): the
 *  pinned one when there is one, else any mounted file row with a height. */
export async function fileHeaderHeight(page: Page): Promise<number> {
  const read = () =>
    page.evaluate(() => {
      const pinned = document.querySelector('[data-sticky="true"] [data-testid^="file-header-"]');
      const any = [...document.querySelectorAll('[data-testid^="file-header-"]')];
      const h = (el: Element | null) => (el ? el.getBoundingClientRect().height : 0);
      return h(pinned) || Math.max(0, ...any.map(h));
    });
  await expect.poll(read, { message: "a file header row should be mounted" }).toBeGreaterThan(0);
  return read();
}

/**
 * The focused hunk's header sits right under the sticky file header and
 * nothing pinned paints over it: the point just inside its top edge hit-tests
 * to the header itself (or a descendant). Polled as one predicate — the glide
 * takes a few frames, and the pinned headers re-extract a frame after it.
 */
export async function expectUnderFileHeader(page: Page, id: string, tolerance = 3) {
  const fh = await fileHeaderHeight(page);
  await expect(hunkHeader(page, id)).toHaveAttribute("data-focused", "true");
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ hunkId, fh, tolerance }) => {
            const sc = document.querySelector("[data-diff-scroller]")!;
            const el = document.querySelector(`[data-testid="hunk-header-${hunkId}"]`);
            if (!el) return "header not mounted";
            const r = el.getBoundingClientRect();
            const top = r.top - sc.getBoundingClientRect().top;
            if (Math.abs(top - fh) > tolerance) return `top ${top.toFixed(1)}px, wanted ${fh}px`;
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 2);
            if (!hit || !el.contains(hit)) {
              const row = hit?.closest("[data-index]")?.firstElementChild;
              return `covered by ${row?.getAttribute("data-testid") ?? hit?.tagName ?? "nothing"}`;
            }
            return "ok";
          },
          { hunkId: id, fh, tolerance },
        ),
      { message: `hunk ${id} should land under the file header, uncovered` },
    )
    .toBe("ok");
  await settledScrollTop(page);
}

/**
 * A real click at the element's centre, without Playwright's pre-click
 * scroll-into-view: a position test must not have its pane moved for it.
 */
export async function clickAt(target: Locator) {
  // The unit header above the pane collapses (with a transition) once the
  // pane is scrolled past it, shifting everything up in page coordinates;
  // click only once the box has stopped moving.
  let box = await target.boundingBox();
  for (let i = 0; i < 20; i++) {
    await target.page().waitForTimeout(100);
    const next = await target.boundingBox();
    if (box && next && Math.abs(next.y - box.y) < 0.5 && Math.abs(next.x - box.x) < 0.5) break;
    box = next;
  }
  if (!box) throw new Error("clickAt: target has no box");
  await target.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** `j` (or `k`), then wait for the focus to move: a second press before React
 *  re-rendered would read the old focus and go nowhere. */
export async function step(page: Page, key: "j" | "k", expectedId: string) {
  await page.keyboard.press(key);
  await expect(hunkHeader(page, expectedId)).toHaveAttribute("data-focused", "true");
}

/** The scroller's `scrollTop`, settled: two reads a frame apart agree. */
export async function settledScrollTop(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const sc = document.querySelector("[data-diff-scroller]")!;
        let last = sc.scrollTop;
        const tick = () => {
          if (sc.scrollTop === last) return resolve(last);
          last = sc.scrollTop;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** A diff row by its new-side line number (second gutter) and row type. */
export function lineRow(page: Page, newNo: number, type: "add" | "context" = "add"): Locator {
  return page
    .locator(`.diff-line[data-type="${type}"]`)
    .filter({ has: page.locator(".diff-gutter:nth-child(2)", { hasText: new RegExp(`^${newNo}$`) }) })
    .first();
}

export const newGutter = (row: Locator) => row.locator(".diff-gutter").nth(1);

/** Open the composer on one line through the hover `+`. */
export async function openComposerOnLine(page: Page, newNo: number) {
  const row = lineRow(page, newNo);
  await row.hover();
  await row.getByRole("button", { name: "Comment on this line" }).click();
  await expect(page.getByTestId("comment-composer")).toBeVisible();
  return row;
}
