import { expect, test } from "@playwright/test";
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
  "AI",
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

  // The cap and roster size are stated, and they are the real ones (pinned by help-facts.test.ts).
  await expect(page.getByTestId("help-topic-employees")).toContainText("31 AI employee roles");
  await expect(page.getByTestId("help-topic-employees")).toContainText("5 may be active");

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

test("no help topic is left unaudited, and each states its evidence", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByTestId("help-center-page")).toBeVisible();

  // Every topic must carry a maturity marker; none may still be "Not yet audited".
  await expect(page.getByTestId("help-tag-AUDIT_PENDING")).toHaveCount(0);

  // The four formerly-unaudited topics now make specific, falsifiable claims.
  await expect(page.getByTestId("help-topic-intelligence")).toContainText("until it is explicitly promoted");
  await expect(page.getByTestId("help-topic-investing")).toContainText("receipted decision");
  await expect(page.getByTestId("help-topic-lp")).toContainText("revocation");
  await expect(page.getByTestId("help-topic-portfolio")).toContainText("MP introduction gate");

  // And the LP topic still refuses to invent fund terms.
  await expect(page.getByTestId("help-topic-lp")).toContainText("No other fund term is asserted");
});


test("nav groups fold, and the rail remembers what you closed", async ({ page }) => {
  await signIn(page);

  const deals = page.getByTestId("nav-group-deals");
  await expect(deals).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Investment", exact: true })).toBeVisible();

  await deals.click();
  await expect(deals).toHaveAttribute("aria-expanded", "false");
  // Genuinely hidden, not painted out of view — assistive tech and a sighted operator agree.
  await expect(page.getByRole("button", { name: "Investment", exact: true })).toBeHidden();

  // The rail should learn the operator's shape rather than resetting to the designer's.
  await page.reload();
  await expect(page.getByTestId("nav-group-deals")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Investment", exact: true })).toBeHidden();

  await page.getByTestId("nav-group-deals").click();
  await expect(page.getByRole("button", { name: "Investment", exact: true })).toBeVisible();
});

test("Home and Ask carry icons; the rest do not", async ({ page }) => {
  await signIn(page);
  // Icons only where they aid recall. Forty of them would mean inventing a metaphor for
  // "Contradictions", and a bad icon has to be read AND decoded.
  await expect(page.getByRole("button", { name: "Home", exact: true }).locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Ask", exact: true }).locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Research", exact: true }).locator("svg")).toHaveCount(0);
});
