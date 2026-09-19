import { expect, type Page } from "@playwright/test";

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

/**
 * Open Work, then the machinery, the way an operator does — AND PIN THAT IT IS NOT ON THE DESK.
 *
 * The scheduled machinery used to render below the whole board on the Work surface, so four specs
 * reached it by navigating to Work and asserting `jobs-page` was visible. The 18 Sep redesign
 * separated the four kinds the page carries: what needs her, what is happening now, what the firm
 * has done, and what runs on a clock. Machinery is the fourth, and it stopped competing with the
 * second by getting its own address.
 *
 * WHY THIS HELPER ASSERTS THE ABSENCE FIRST. Replacing `expect(jobs-page).toBeVisible()` with a
 * click and the same expectation would have been a weaker test than the one it replaced — it would
 * pass just as happily if the machinery quietly reappeared under the board tomorrow, which is the
 * exact regression this redesign exists to prevent. So the contract is stated in both directions:
 * the machinery is NOT on the desk, and it IS one deliberate click away.
 */
export async function openWorkMachinery(page: Page): Promise<void> {
  await gotoSurface(page, "Work");
  const jobs = page.getByTestId("jobs-page");
  await expect(jobs, "the machinery must not be on the desk — it is the kind that does not need her").toHaveCount(0);
  await page.getByTestId("work-view-machinery").click();
  await expect(jobs, "the machinery must be exactly one click from the desk").toBeVisible();
}

/**
 * Open a company's deal record on Dealflow, the way a person does: press its name on the row.
 *
 * The record picker `<select>` under the pipeline is gone (design/DEALS_SECTION_DESIGN.md §1.2 #7:
 * "the row's name is the door"), so a journey that used to `selectOption` a company now narrows
 * the list to Everything — a passed or invested deal is not on the Live chip — and presses the
 * row. The record opens under the pipeline on its first face.
 */
export async function openDealRecord(page: Page, companyName: string): Promise<void> {
  await page.getByTestId("dealflow-filter-ALL").click();
  await page.locator('button[data-testid^="deal-company-"]', { hasText: companyName }).first().click();
  await expect(page.getByTestId("deal-record")).toBeVisible();
  await expect(page.getByTestId("deal-record-company-name")).toContainText(companyName);
}

/** Pick a face of the open deal record: standing · deal · known · committee · history. */
export async function openDealFace(page: Page, face: "standing" | "deal" | "known" | "committee" | "history"): Promise<void> {
  await page.getByTestId(`deal-face-${face}`).click();
  await expect(page.getByTestId(`deal-face-${face}`)).toHaveAttribute("aria-selected", "true");
}
