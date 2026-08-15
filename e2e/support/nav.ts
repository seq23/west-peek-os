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

/** Navigate to a primary surface by its visible label, at any viewport. */
export async function gotoSurface(page: Page, label: string): Promise<void> {
  await openNavIfCollapsed(page);
  await page.getByRole("button", { name: label, exact: true }).first().click();
}
