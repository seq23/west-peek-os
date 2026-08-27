import { expect, type Page } from "@playwright/test";
import { openNavIfCollapsed, openSystemAreaIfCollapsed } from "./nav";

/**
 * Walking EVERY destination and asking the same three questions of each.
 *
 * WHY A SWEEP AND NOT A LIST OF TESTIDS. The `*-empty` testids cover roughly a third of the empty
 * slots in this product, so a spec written against them passes for the two thirds that have none —
 * and the defect this exists to catch was on a page with no testid at all. The design system's own
 * classes (`state-empty` for a list row, `state-message` for a whole surface) and its list class
 * (`card-list`) are the contract every page already renders against, so they are what is read.
 *
 * Used by `d0-empty-firm.spec.ts` (a firm with no data) and `d1-design-states.spec.ts` (a reader
 * with no authority). Those are the two states in which a surface is most likely to render an
 * ambiguous blank, and they are the two states the product's own verification kept missing: the
 * design pass ran entirely as a Managing Partner against a populated database.
 */

/** Under this, a page is chrome with nothing said. The Governance regression measured zero. */
export const LEGIBLE_CHARS = 80;

/**
 * Destinations a sweep deliberately does not walk.
 *
 * `Help` is the one page with no purpose block by design — it IS the explanation, so a block
 * explaining it would be the page explaining itself to itself (`PagePurposeBlock` returns null for
 * it). Its own coverage is in `p26-operator-experience.spec.ts`.
 */
export const SKIP_DESTINATIONS = new Set(["Help"]);

/**
 * The visibility test, and why `offsetParent` alone is not it.
 *
 * Everything under a closed `<details>` is in the DOM and not on screen — and Chrome still reports
 * a non-null `offsetParent` and a non-zero `offsetHeight` for it, while `innerText` comes back as
 * the empty string. Measured 22 Aug 2026 on the Companies register, which lives inside the
 * `company-identity` disclosure: a perfectly good empty-state row read as an unexplained blank
 * because the lid above it was shut.
 *
 * So a closed disclosure is checked for explicitly. A lid nobody has opened is not a blank, and a
 * sweep that says it is will report the same false defect on every page that folds a workflow away.
 */
/** Every destination the rail offers, in both tiers, by its visible label. */
export async function allDestinations(page: Page): Promise<string[]> {
  await openNavIfCollapsed(page);
  await openSystemAreaIfCollapsed(page);
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll("nav button"))
      .map((b) => (b as HTMLElement).innerText.trim())
      .filter((t) => t.length > 0 && t.length < 40),
  );
  return Array.from(new Set(labels));
}

/**
 * Visible lists with nothing inside them AND nothing beside them — the ambiguous blank, in the DOM.
 *
 * TWO SHAPES ARE BOTH CORRECT, and an early version of this sweep only allowed one of them. A page
 * may put the explanation INSIDE the list as a `state-empty` row, which is what most of them do; or
 * it may put it BESIDE the list as a sibling paragraph, which is what the AI run list and the
 * intelligence item list do. A reader cannot tell the difference and neither should this. What is
 * never acceptable is an empty list with no explanation anywhere near it.
 */
export async function blankLists(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const body = document.querySelector(".surface-body");
    if (!body) return [] as string[];
    const visible = (el: Element): boolean =>
      (el as HTMLElement).offsetParent !== null && el.closest("details:not([open])") === null;
    return Array.from(body.querySelectorAll("ul.card-list, ol.card-list"))
      .filter((ul) => {
        const el = ul as HTMLElement;
        // Only what a reader can actually see — see VISIBLE_IN_PAGE above for why `offsetParent`
        // alone gets this wrong.
        if (!visible(el)) return false;
        if (el.children.length > 0 || el.innerText.trim().length > 0) return false;
        // Explained by something standing next to it?
        const beside = Array.from(el.parentElement?.children ?? []).some(
          (sib) => sib !== el && visible(sib) && sib.matches(".state-empty, .state-message"),
        );
        return !beside;
      })
      .map((ul) => (ul as HTMLElement).dataset.testid ?? "an unnamed list");
  });
}

/**
 * Every visible empty/loading slot the design system draws — the text a reader sees, and enough to
 * find it again. A failure that says only `""` costs somebody an afternoon working out which slot.
 */
export async function emptySlots(page: Page): Promise<Array<{ what: string; text: string }>> {
  return await page.evaluate(() => {
    const body = document.querySelector(".surface-body");
    if (!body) return [] as Array<{ what: string; text: string }>;
    return Array.from(body.querySelectorAll(".state-empty, .state-message"))
      .filter((el) => (el as HTMLElement).offsetParent !== null && el.closest("details:not([open])") === null)
      .map((el) => {
        const node = el as HTMLElement;
        const named = node.dataset.testid ?? node.parentElement?.dataset.testid ?? node.tagName.toLowerCase();
        return { what: named, text: node.innerText.trim() };
      });
  });
}

/**
 * Go to a destination and wait for it to have SETTLED.
 *
 * Loading and empty share one slot by design ("told apart by tone — never a blank"), so a sweep
 * that measured on arrival would sometimes be reading "Reading the record…" and calling it an
 * unexplained blank. Reporting a race as a defect is worse than not testing for it: it costs
 * somebody an afternoon and teaches them the suite lies.
 *
 * Returns false when the destination is not reachable for this reader, so a caller can tell "the
 * page said nothing" from "there was no page".
 */
export async function visitSurface(page: Page, label: string): Promise<boolean> {
  await openNavIfCollapsed(page);
  const target = page.getByRole("button", { name: label, exact: true }).first();
  if (!(await target.isVisible().catch(() => false))) await openSystemAreaIfCollapsed(page);
  if (!(await target.isVisible().catch(() => false))) return false;
  await target.click();
  await page.waitForLoadState("networkidle").catch(() => undefined);

  /*
   * FIVE SECONDS, and the budget is deliberately generous. Measured 22 Aug 2026: at a load average
   * of 42 this sweep reported four Employees lists as unexplained blanks that were simply still
   * being fetched, and every one of them was a page that renders its empty state correctly. A sweep
   * that reports a busy machine as a product defect costs somebody an afternoon and teaches them
   * the suite lies, which is more expensive than the seconds this spends.
   */
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    const now = JSON.stringify([await blankLists(page), await emptySlots(page)]);
    // Settled when two consecutive reads agree AND nothing is still announcing that it is reading.
    if (now === last && !/…|\.\.\./.test(now)) return true;
    last = now;
    await page.waitForTimeout(250);
  }
  return true;
}

export interface SurfaceComplaints {
  /** Pages that rendered chrome with nothing readable under it. */
  silent: string[];
  /** Pages that do not say what they are for. */
  unoriented: string[];
  /** Lists that were empty with no row explaining what would fill them. */
  unexplained: string[];
}

/**
 * Walk every destination and collect what each one failed to say.
 *
 * Collected rather than asserted one page at a time, on purpose: a sweep that threw on the first
 * bad page would report one defect per run, and the operator would fix them one afternoon at a
 * time. The whole list in one failure message is the useful artefact.
 */
export async function sweepSurfaces(page: Page): Promise<SurfaceComplaints> {
  const destinations = await allDestinations(page);
  expect(destinations.length, "the rail must actually offer destinations to walk").toBeGreaterThan(20);

  const complaints: SurfaceComplaints = { silent: [], unoriented: [], unexplained: [] };
  for (const label of destinations) {
    if (SKIP_DESTINATIONS.has(label)) continue;
    if (!(await visitSurface(page, label))) continue;

    const chars = await page.evaluate(
      () => (document.querySelector(".surface-body") as HTMLElement | null)?.innerText.trim().length ?? 0,
    );
    if (chars < LEGIBLE_CHARS) complaints.silent.push(`${label} (${chars} chars)`);

    if ((await page.locator('[data-testid^="page-purpose-"]').first().count()) === 0) {
      complaints.unoriented.push(label);
    }

    for (const blank of await blankLists(page)) complaints.unexplained.push(`${label} → ${blank}`);
  }
  return complaints;
}
