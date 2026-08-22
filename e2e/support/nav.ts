import type { Page } from "@playwright/test";

/**
 * Shell navigation helper (design overhaul, D3).
 *
 * On a laptop the primary rail is always on screen. Below 900px it becomes a full-height sheet
 * opened from the black top bar, because 29 destinations in a horizontal chip scroller gave the
 * operator no grouping and no thumb reach (docs/WEST_PEEK_DESIGN_REFERENCE_AUDIT.md §3.2/3.4).
 *
 * Every destination is still a real, visible button once the sheet is open — grouping labels the
 * nav, it never hides a route. This helper opens the sheet only when the viewport put it away.
 */
export async function openNavIfCollapsed(page: Page): Promise<void> {
  const toggle = page.getByTestId("nav-toggle");
  if (!(await toggle.isVisible().catch(() => false))) return;
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await toggle.click();
}

/**
 * Open the More / System disclosure if it is closed (P26).
 *
 * Administration and diagnostics moved behind one collapsed region so the everyday rail is six
 * groups rather than twenty-nine flat links. Nothing was removed — this opens the lid.
 */
export async function openSystemAreaIfCollapsed(page: Page): Promise<void> {
  const toggle = page.getByTestId("nav-system-toggle");
  if (!(await toggle.isVisible().catch(() => false))) return;
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await toggle.click();
}

/**
 * Open a `<details>` disclosure by its testid, if it is closed.
 *
 * Several surfaces now fold a whole workflow behind a summary — the Companies route puts the
 * register on show and the identity/evidence work (aliases, merges, claims, contradictions) inside
 * `company-identity`. Everything under a closed `<details>` is in the DOM and NOT visible, so a
 * spec that fills a field down there fails with "element is not visible" and reads like a missing
 * control rather than a shut lid. This opens it the way a person does.
 */
export async function openDisclosure(page: Page, testId: string): Promise<void> {
  const details = page.getByTestId(testId);
  if ((await details.evaluate((el) => (el as HTMLDetailsElement).open).catch(() => true)) === true) return;
  await details.locator("summary").first().click();
}

/**
 * Navigate to any surface by its visible label, at any viewport, in either nav tier.
 *
 * Callers should not have to know which tier a destination lives in — that is a product decision
 * that may change again. So this walks the same path an operator does: open the sheet if the
 * viewport put it away, and open the system region only if the destination is not already on show.
 */
export async function gotoSurface(page: Page, label: string): Promise<void> {
  await openNavIfCollapsed(page);
  const target = page.getByRole("button", { name: label, exact: true }).first();
  if (!(await target.isVisible().catch(() => false))) {
    await openSystemAreaIfCollapsed(page);
  }
  await target.click();
}
