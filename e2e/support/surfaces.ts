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

/** Visible lists with literally nothing inside them — the ambiguous blank, in the DOM. */
export async function blankLists(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const body = document.querySelector(".surface-body");
    if (!body) return [] as string[];
    return Array.from(body.querySelectorAll("ul.card-list, ol.card-list"))
      .filter((ul) => {
        const el = ul as HTMLElement;
        // Only what a reader can actually see. Anything under a closed <details> is in the DOM and
        // not on screen, and a lid nobody has opened is not a blank.
        if (el.offsetParent === null) return false;
        return el.children.length === 0 && el.innerText.trim().length === 0;
      })
      .map((ul) => (ul as HTMLElement).dataset.testid ?? "an unnamed list");
  });
}

/** Every visible empty/loading slot the design system draws, as the text a reader sees. */
export async function emptySlots(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const body = document.querySelector(".surface-body");
    if (!body) return [] as string[];
    return Array.from(body.querySelectorAll(".state-empty, .state-message"))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => (el as HTMLElement).innerText.trim());
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

  let last = "";
  for (let i = 0; i < 12; i += 1) {
    const now = JSON.stringify([await blankLists(page), await emptySlots(page)]);
    // Settled when two consecutive reads agree AND nothing is still announcing that it is reading.
    if (now === last && !/…|\.\.\./.test(now)) return true;
    last = now;
    await page.waitForTimeout(200);
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
