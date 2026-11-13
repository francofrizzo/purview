import { test, expect, type Page } from "@playwright/test";
import { UNITS, lineRow, openPr } from "./helpers";

/** The `architecture` experiment: an Overview section, only while it is on. */

async function openOverview(page: Page, opts: { on?: boolean; empty?: boolean } = {}) {
  await page.addInitScript(({ on, empty }) => {
    if (on) localStorage.setItem("reviewer.mockExperiments", "architecture");
    if (empty) localStorage.setItem("reviewer.mockArchitecture", "empty");
  }, { on: opts.on ?? true, empty: opts.empty ?? false });
  await openPr(page);
  await page.getByTestId("sidebar-tab-overview").click();
  await expect(page.getByTestId("overview-behavior")).toBeVisible();
}

test("off, the analysis's architecture shows nowhere; turned on in Settings, the section comes after behavior changes", async ({ page }) => {
  await openOverview(page, { on: false });
  await expect(page.getByTestId("overview-architecture")).toHaveCount(0);
  await expect(page.getByTestId("overview-jump-architecture")).toHaveCount(0);

  // In-app: a reload would reset the mock's config.
  await page.evaluate(() => {
    history.pushState({}, "", "/settings");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByTestId("experiment-architecture").click();
  await expect(page.getByTestId("experiment-architecture")).toBeChecked();
  await page.goBack();
  await page.getByTestId("sidebar-tab-overview").click();
  const section = page.getByTestId("overview-architecture");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("overview-jump-architecture")).toBeVisible();
  // After behavior changes, before where it lands.
  const order = await page.locator("[data-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
  expect(order.indexOf("architecture")).toBe(order.indexOf("behavior") + 1);
});

test("a deviation quotes the rule beside the code and opens its unit at the line", async ({ page }) => {
  await openOverview(page);
  const section = page.getByTestId("overview-architecture");
  const row = section.getByTestId("architecture-deviation");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("architecture-deviation-mark")).toBeVisible();
  await expect(row.getByTestId("architecture-rule")).toContainText("everything else goes through");
  await expect(row.getByTestId("architecture-rule")).toContainText("docs/architecture.md · Persistence");
  await expect(row.getByTestId("architecture-code")).toContainText("FROM charge_ledger");
  await expect(row.getByTestId("architecture-code")).toContainText("src/billing/reconcile.ts:114");
  await expect(row.getByTestId("architecture-why")).toContainText("no paged read");

  await row.getByRole("button", { name: /Reconciler queries/ }).click();
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await expect(lineRow(page, 114)).toBeInViewport();
});

test("the sources and the rules checked sit in the header; a doc the PR changes opens in Files", async ({ page }) => {
  await openOverview(page);
  const section = page.getByTestId("overview-architecture");
  const sources = section.getByTestId("architecture-source");
  await expect(sources).toHaveText(["docs/architecture.md", "docs/billing.md"]);
  // Not in the PR: a path, not a button.
  await expect(sources.first()).toHaveAttribute("data-tip", /does not change it/);

  const toggle = section.getByTestId("architecture-checked-toggle");
  await expect(toggle).toHaveText("checked 4 rules");
  await expect(section.getByTestId("architecture-checked")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(section.getByTestId("architecture-checked-rule")).toHaveCount(4);
  await expect(section.getByTestId("architecture-checked-rule").last()).toContainText("Charges go through the gateway adapter.");
  await toggle.click();
  await expect(section.getByTestId("architecture-checked")).toHaveCount(0);

  await sources.getByText("docs/billing.md").click();
  await expect(page.getByTestId("overview")).toHaveCount(0);
  await expect(page.locator('[data-testid^="hunk-header-a1b2c3d4e5f60009"]')).toBeVisible();
});

test("a decision the docs miss offers the line to add to them, and copies it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openOverview(page);
  const decisions = page.getByTestId("architecture-decisions");
  await expect(decisions).toContainText("Worth documenting");
  const decision = decisions.getByTestId("architecture-decision");
  await expect(decision).toHaveCount(1);
  await expect(decision).toContainText("Jobs read the gateway in batches");
  const line = decision.getByTestId("architecture-docline");
  await expect(line).toContainText("docs/architecture.md · Gateway");
  await line.getByTestId("architecture-docline-copy").getByRole("button").click();
  await expect(line.getByTestId("architecture-docline-copy")).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Jobs may read the gateway in batches (`chargesByKeys`); request paths call it one charge at a time.",
  );
  await decision.getByRole("button", { name: /Jobs read the gateway/ }).click();
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
});

test("comment with the rule opens a draft on the line holding only the quoted rule", async ({ page }) => {
  await openOverview(page);
  const row = page.getByTestId("architecture-deviation");
  await row.hover();
  await row.getByTestId("architecture-comment").click();
  const box = page.getByTestId("composer-textarea");
  await expect(box).toBeVisible();
  const body = await box.inputValue();
  expect(body).toContain("> Only `src/billing/ledger.ts` reads or writes `charge_ledger`");
  expect(body).toContain("> — `docs/architecture.md`, Persistence");
  expect(body).not.toContain("no paged read");
});

test("a PR that follows its docs says so, with the sources in the header and the rules it was checked against", async ({ page }) => {
  await openOverview(page, { empty: true });
  const section = page.getByTestId("overview-architecture");
  await expect(section.getByTestId("architecture-none")).toHaveText("Follows the documented architecture.");
  await expect(section.getByTestId("architecture-deviation")).toHaveCount(0);
  await expect(section.getByTestId("architecture-decisions")).toHaveCount(0);
  await expect(section.getByTestId("architecture-source")).toHaveCount(2);
  await expect(section.getByTestId("architecture-checked-toggle")).toHaveCount(0);
  await expect(section.getByTestId("architecture-checked-rule")).toHaveCount(4);
});

test("the repo's architecture docs are a repo setting only while the experiment is on", async ({ page }) => {
  await page.goto("/repo/github.com/acme/billing/settings");
  await expect(page.getByTestId("settings-nav-rubric")).toBeVisible();
  await expect(page.getByTestId("architecture-docs")).toHaveCount(0);

  await page.addInitScript(() => localStorage.setItem("reviewer.mockExperiments", "architecture"));
  await page.goto("/repo/github.com/acme/billing/settings");
  await expect(page.getByTestId("settings-nav-architecture")).toBeVisible();
  await page.getByTestId("architecture-docs").fill("docs/architecture.md\n\n docs/adr/ ");
  await page.getByTestId("architecture-docs-save").click();
  await expect(page.getByTestId("architecture-docs-save")).toBeDisabled();
  await expect(page.getByTestId("architecture-docs")).toHaveValue("docs/architecture.md\ndocs/adr/");
});
