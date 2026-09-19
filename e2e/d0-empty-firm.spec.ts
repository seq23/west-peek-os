import { expect, test } from "@playwright/test";
import { allDestinations, emptySlots, SKIP_DESTINATIONS, sweepSurfaces, visitSurface } from "./support/surfaces";

/**
 * AN EMPTY FIRM. EVERY SURFACE STILL READS.
 *
 * THIS FILE RUNS FIRST, and the name is load-bearing: Playwright walks the spec files in order, so
 * `d0-` puts this ahead of `d1-`, `p1-` and everything after. `scripts/e2e/prepare-local.mjs`
 * deletes the local D1 before the suite starts, which means these assertions are made against a
 * firm with no companies, no deals, no meetings, no LPs, no positions and no runs — the state every
 * one of these pages will be in on the day somebody first opens it, and the only chance this suite
 * gets to see it.
 *
 * WHY IT MATTERS MORE THAN IT SOUNDS. The design pass's own verification ran entirely as a Managing
 * Partner on a populated database, and that hid a real defect: read with nothing to show, the
 * Governance surface rendered ZERO characters — no form, no rows, no explanation. An operator could
 * not tell "you may not do this" from "this is broken" from "nothing has happened yet", and those
 * are three different things to do next. The design system's rule (§7) is that an empty slot is a
 * STATED FACT, never a gap the reader has to interpret.
 *
 * THE THREE RULES, applied to every destination in the rail:
 *
 *   1 · The page renders readable prose under its header — not chrome over a void.
 *   2 · It says what it is FOR, before it has anything to show. The purpose block is served from
 *       one shared source and is data-independent, so a surface is orientating on day zero.
 *   3 · No list is silently empty. An empty `<ul>` with nothing inside it is the exact ambiguous
 *       blank this file exists to catch — a slot with an explanation in it is fine, a slot with
 *       literally nothing in it is not.
 *
 * The rules are stated unconditionally rather than as "when the firm is empty", on purpose: they
 * are true of a full firm as well, and a conditional assertion is one that stops testing the moment
 * the condition drifts.
 */

test("every destination is legible, says what it is for, and has no unexplained blank", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  const complaints = await sweepSurfaces(page);

  expect(complaints.silent, "these surfaces rendered chrome with nothing said under it").toEqual([]);
  expect(complaints.unoriented, "these surfaces do not say what they are for").toEqual([]);
  expect(complaints.unexplained, "these lists were empty with no row explaining what would fill them").toEqual([]);
});

test("no empty slot is a bare placeholder — every one of them is a stated fact", async ({ page }) => {
  /*
   * THE OTHER HALF OF THE RULE. The sweep above proves nothing is BLANK; this proves that the thing
   * standing in the blank's place is a sentence rather than a token. "—", "None" and "0" are the
   * three ways an empty slot gets written by somebody who has stopped thinking about the reader,
   * and all three leave exactly the ambiguity the design system's §7 exists to remove: a partner
   * cannot tell "nothing has happened" from "this did not load" from "you cannot see this".
   *
   * ASSERTED AS A SHAPE, NOT AS A LENGTH. A character floor would be a style opinion and would
   * start arguments about "No open conflicts." — which is a perfectly good stated fact. What is
   * never acceptable is a slot with one wordless token in it.
   */
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();

  const destinations = await allDestinations(page);
  const tokens: string[] = [];
  let stated = 0;

  for (const label of destinations) {
    if (SKIP_DESTINATIONS.has(label)) continue;
    if (!(await visitSurface(page, label))) continue;
    for (const slot of await emptySlots(page)) {
      stated += 1;
      const text = slot.text;
      const bare = text.length === 0 || !/\s/.test(text) || /^(none|n\/a|na|-|—|–|0|empty|nothing)\.?$/i.test(text);
      if (bare) tokens.push(`${label} → ${slot.what}: "${text}"`);
    }
  }

  // The sweep has to have FOUND empty slots, or it proved nothing. On a firm with no data there are
  // dozens; a run that finds none means the selector stopped matching, not that the firm is full.
  expect(stated, "no empty slot was found at all — the design system's own classes stopped matching").toBeGreaterThan(5);
  expect(tokens, "an empty slot must be a sentence a reader can act on, never a bare token").toEqual([]);
});

/**
 * THE FUND-SHAPED PAGES ON A FIRM WITH NO FUND. Thesis and Secondaries read a fund's policy
 * versions; before any fund exists they must say so in words rather than draw a rail from nothing
 * or a sleeve of $0. Asserted HERE because this is the one file that runs on a provably empty firm
 * — the Deals journeys later in the suite each make a fund and cannot reach this state.
 */
test("Thesis and Secondaries say there is no fund, and draw nothing from nothing", async ({ page, request }) => {
  const funds = (await (await request.get("/api/funds", { headers: { "x-wpos-dev-user": "scooter@westpeek.ventures" } })).json()) as {
    funds: unknown[];
  };
  expect(funds.funds, "the empty-firm journey found a fund — the suite no longer starts from a clean database").toHaveLength(0);

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  expect(await visitSurface(page, "Thesis")).toBe(true);
  await expect(page.getByTestId("thesis-no-fund")).toContainText("No fund exists yet");
  await expect(page.getByTestId("thesis-rail")).toHaveCount(0);

  expect(await visitSurface(page, "Secondaries")).toBe(true);
  await expect(page.getByTestId("secondaries-budget")).toContainText("sleeve budget to confirm");
  await expect(page.getByTestId("secondaries-budget")).toContainText("MISSING — no fund exists");
  await expect(page.getByTestId("secondaries-eyebrow")).toContainText("sleeve budget to confirm");
  await expect(page.getByTestId("secondaries-budget")).not.toContainText("$0 of $0");
});
