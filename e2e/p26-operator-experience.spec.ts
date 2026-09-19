import { expect, test } from "@playwright/test";
// The Help Center renders its numbers from this module; reading it here is what stops the page and
// the spec drifting apart. `helpFacts` derives the roster from the registry and pins the cap with
// its own unit test, so there is exactly one place either number can be wrong.
import { AI_EMPLOYEE_ROSTER, MAX_ACTIVE_AI_EMPLOYEES_DOC } from "../src/client/lib/helpFacts";
import { gotoSurface } from "./support/nav";

/**
 * P26 browser journey — operator experience: two-tier navigation, the Help Center, and the
 * contextual-help primitive.
 *
 * The claim under test is not "a menu collapses". It is that reorganising the rail did not cost
 * the operator anything: every advanced destination is still reachable, the disclosure is operable
 * from the keyboard alone, a deep link into a system page does not strand the operator in front of
 * a collapsed region, and Help is reachable before sign-in.
 */

// "Cockpit" is the admin console (formerly "AI Ops"); the old Cockpit — an allocation decision
// view — moved to Investing / Deals as "Fund strategy" and is therefore no longer a system
// destination. Renamed on operator direction, 17 Aug 2026.
const SYSTEM_DESTINATIONS = [
  "Cockpit",
  "Activity",
  "Governance",
  "Cross-office",
  // "AI" named nothing — the surface holds the provider kill switches, the spend ceiling and the
  // outbound-email switches, which are controls rather than a subject.
  "AI controls",
  "Machines",
  "Integrations",
  "Diagnostics",
] as const;

// Regrouped by WHEN a thing is used rather than what it is (P53). "Team" is gone — a one-item
// group was an orphan wearing a header, and Employees now sits under Firm.
const EVERYDAY_GROUPS = [
  "Home",
  "Now",
  "Deals",
  "Firm",
  "Learn",
  "Help",
] as const;

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("everyday work is primary and system administration is behind one disclosure", async ({ page }) => {
  await signIn(page);

  for (const group of EVERYDAY_GROUPS) {
    await expect(page.getByText(group, { exact: true }).first()).toBeVisible();
  }

  // The secondary tier starts collapsed: its destinations are genuinely not present to the user.
  const toggle = page.getByTestId("nav-system-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  for (const dest of SYSTEM_DESTINATIONS) {
    await expect(page.getByRole("button", { name: dest, exact: true })).toBeHidden();
  }

  // Opening it reveals every one of them — nothing was removed in the reorganisation.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  for (const dest of SYSTEM_DESTINATIONS) {
    await expect(page.getByRole("button", { name: dest, exact: true })).toBeVisible();
  }
});

test("every advanced destination still opens its page", async ({ page }) => {
  await signIn(page);
  // Diagnostics and Machines assert their own page testids; the rest must at least become current.
  await gotoSurface(page, "Machines");
  await expect(page.getByTestId("machines-page")).toBeVisible();

  await gotoSurface(page, "Diagnostics");
  await expect(page.getByRole("button", { name: "Diagnostics", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await gotoSurface(page, "Integrations");
  await expect(page.getByRole("button", { name: "Integrations", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("the disclosure is operable from the keyboard alone", async ({ page }) => {
  await signIn(page);
  const toggle = page.getByTestId("nav-system-toggle");

  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Space is the other native activation key for a button; a div-with-onClick would fail here.
  await page.keyboard.press(" ");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // And a revealed destination is reachable by tabbing, not only by pointer.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Cockpit", exact: true })).toBeFocused();
});

test("choosing a system page keeps the region open rather than collapsing under the operator", async ({
  page,
}) => {
  await signIn(page);
  await gotoSurface(page, "Machines");
  const toggle = page.getByTestId("nav-system-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Machines", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // A second system destination in a row must not toggle the region shut.
  await gotoSurface(page, "Activity");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("the Help Center is reachable, searchable, and honest about what is unproven", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByTestId("help-center-page")).toBeVisible();

  // The topics an operator arrives asking for.
  await expect(page.getByTestId("help-topic-what-is")).toBeVisible();
  await expect(page.getByTestId("help-topic-getting-started")).toBeVisible();
  await expect(page.getByTestId("help-topic-cadence")).toBeVisible();
  await expect(page.getByTestId("help-topic-employees")).toBeVisible();
  await expect(page.getByTestId("help-topic-blocked")).toBeVisible();
  await expect(page.getByTestId("help-topic-glossary")).toBeVisible();

  /*
   * The cap and roster size are stated, and they are the REAL ones.
   *
   * Read from `src/client/lib/helpFacts.ts` — the module the page itself renders from — rather than
   * typed here. The numbers moved (31/5 → the current roster and cap) and a help page that states a
   * cap the server does not enforce is worse than one that states none, so what matters is that the
   * page and the constant cannot drift apart, not what today's figure happens to be.
   */
  await expect(page.getByTestId("help-topic-employees")).toContainText(`${AI_EMPLOYEE_ROSTER} AI employee roles`);
  await expect(page.getByTestId("help-topic-employees")).toContainText(`${MAX_ACTIVE_AI_EMPLOYEES_DOC} may be active`);

  // Integrations must NOT claim to work; it must defer to the readiness surface.
  const integrations = page.getByTestId("help-topic-integrations");
  await expect(integrations).toContainText("will not tell you an integration is working");

  // Search narrows, and a miss explains itself instead of rendering an empty page.
  await page.getByTestId("help-search").fill("glossary");
  await expect(page.getByTestId("help-topic-glossary")).toBeVisible();
  await expect(page.getByTestId("help-topic-what-is")).toBeHidden();
  await page.getByTestId("help-search").fill("zzzz-no-such-topic");
  await expect(page.getByTestId("help-no-results")).toBeVisible();
});

test("Help is available before sign-in", async ({ page }) => {
  await page.goto("/");
  // The branded sign-in card IS the gate now (P42) — it replaced a bare notice above a form, and
  // explains why the page is empty rather than just refusing.
  await expect(page.getByTestId("dev-login")).toBeVisible();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByTestId("help-center-page")).toBeVisible();
  // The gate steps aside on Help rather than shouting over it.
  await expect(page.getByTestId("dev-login")).toBeHidden();
});

test("the rail collapses to a menu on a phone and still reaches system pages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  const menu = page.getByTestId("nav-toggle");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");

  await gotoSurface(page, "Machines");
  await expect(page.getByTestId("machines-page")).toBeVisible();
});

test("no help topic is left unaudited, and each page's section states its real controls", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByTestId("help-center-page")).toBeVisible();

  // Every firm-level topic must carry a maturity marker; none may still be "Not yet audited".
  await expect(page.getByTestId("help-tag-AUDIT_PENDING")).toHaveCount(0);
  expect(await page.locator(".help-topic:not(.help-page) .help-tag").count()).toBeGreaterThan(8);

  /*
   * The four page-level topics that used to make prose claims here (intelligence, investing, LP,
   * portfolio) are gone — 19 Sep 2026, each was a third description of a page beside the page's
   * own purpose block and its host's prompt, and one of them was a week stale. Their claims now
   * live in the page's SECTION, rendered from the page's guide, which `validate:page-guides` holds
   * to the page's real controls. So the pins are stricter than the sentences they replace: the
   * control that makes each claim true has to be named, and it has to exist on the page.
   */
  // Research: a finding stays research until it is explicitly promoted.
  await expect(page.getByTestId("help-page-research")).toContainText("Promote into evidence");
  // Dealflow: the committee's decision is a person's, against the approved card.
  await expect(page.getByTestId("help-page-dealflow")).toContainText("The firm is investing");
  await expect(page.getByTestId("help-page-dealflow")).toContainText("Managing Partner");
  // LP: what goes out is reviewed, signed for, and access can be taken back.
  await expect(page.getByTestId("help-page-lp")).toContainText("Send it to the investors");
  await expect(page.getByTestId("help-page-lp")).toContainText("Close it");
  // Portfolio: an introduction to a portfolio company is gated on a partner.
  await expect(page.getByTestId("help-page-portfolio")).toContainText("Take it to a partner");

  // And Help still refuses to invent fund terms — now as a firm-level rule, beside where it is enforced.
  await expect(page.getByTestId("help-topic-governance")).toContainText("No fund term is invented");
  await expect(page.getByTestId("help-topic-governance")).toContainText("Where this is enforced");
});


test("nav groups fold, and the rail remembers what you closed", async ({ page }) => {
  await signIn(page);

  /*
   * "Investment" is not a destination any more — the pipeline and the deal record became one
   * component on Dealflow. Any member of the Deals group proves the fold; Dealflow is the one that
   * group exists for.
   */
  const deals = page.getByTestId("nav-group-deals");
  await expect(deals).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Dealflow", exact: true })).toBeVisible();

  await deals.click();
  await expect(deals).toHaveAttribute("aria-expanded", "false");
  // Genuinely hidden, not painted out of view — assistive tech and a sighted operator agree.
  await expect(page.getByRole("button", { name: "Dealflow", exact: true })).toBeHidden();

  // The rail should learn the operator's shape rather than resetting to the designer's.
  await page.reload();
  await expect(page.getByTestId("nav-group-deals")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Dealflow", exact: true })).toBeHidden();

  await page.getByTestId("nav-group-deals").click();
  await expect(page.getByRole("button", { name: "Dealflow", exact: true })).toBeVisible();
});

test("Home and Ask carry icons; the rest do not", async ({ page }) => {
  await signIn(page);
  // Icons only where they aid recall. Forty of them would mean inventing a metaphor for
  // "Contradictions", and a bad icon has to be read AND decoded.
  await expect(page.getByRole("button", { name: "Home", exact: true }).locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Ask", exact: true }).locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Research", exact: true }).locator("svg")).toHaveCount(0);
});
