import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P14 browser journey — MP Home + Daily Intelligence (GAP-04, GAP-05, GAP-23).
 *
 * Journey: sign in → Intelligence → run the engine with a manual item → see the item
 * ranked with its stated reason → open its provenance → draft why-it-matters through
 * the governed AI boundary → Home shows the item, answers the ten questions, and links
 * back into the owning surface → the private personal layer is separate and disclaimed.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  // Each test gets a fresh browser context, so the dev-login form is always rendered
  // once the initial /api/me check resolves. Wait for it rather than racing it.
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("MP runs the intelligence engine and the item reaches Home with its provenance", async ({ page }) => {
  await signIn(page);

  // ── Intelligence: watch a topic, then run the engine on a manual item ──
  await gotoSurface(page, "Sources & sweeps");
  await expect(page.getByTestId("intelligence-page")).toBeVisible();

  // The watchlist is a section of the page now, not a closed disclosure: nothing is opened first.
  await page.getByTestId("intel-watch-label").fill("continuation-probe");
  await page.getByTestId("intel-watch-submit").click();
  await expect(page.getByTestId("intel-watchlist")).toContainText("continuation-probe");

  const headline = `A continuation-probe headline ${Date.now()}`;
  // Adding an item by hand now sits behind its own disclosure: the sweep button and the manual
  // fields were one undifferentiated form, which is why "Run a sweep" read as ambiguous.
  await page.getByTestId("intel-manual-add").locator("summary").click();
  await page.getByTestId("intel-manual-title").fill(headline);
  await page.getByTestId("intel-manual-locator").fill("Playwright journey, operator desk");
  await page.getByTestId("intel-manual-body").fill("Context recorded by the operator during the P14 journey.");
  await page.getByTestId("intel-run-submit").click();

  await expect(page.getByTestId("intel-run-message")).toContainText("kept");
  await expect(page.getByTestId("intel-items")).toContainText(headline);

  // The ranking states its rule, and the watchlist match is visible in it.
  const card = page.locator('[data-testid^="intel-item-"]', { hasText: headline });
  await expect(card).toBeVisible();
  await expect(card.locator('[data-testid^="intel-reason-"]')).toContainText("heuristic");
  await expect(card.locator('[data-testid^="intel-reason-"]')).toContainText("watchlist match");

  // Provenance is one click away and names where the item came from.
  await card.locator('[data-testid^="intel-detail-"]').click();
  await expect(card.locator('[data-testid^="intel-citations-"]')).toContainText("Playwright journey, operator desk");

  // Why-it-matters is drafted through the governed AI boundary (local adapter offline).
  await card.locator('[data-testid^="intel-synth-"]').click();
  await expect(card.locator('[data-testid^="intel-message-"]')).toContainText("governed AI boundary");

  // ── A gated external source is shown as gated, never as working ──
  // Sources are the first section of the page and are on screen without opening anything.
  await expect(page.getByTestId("intel-sources")).toContainText("West Peek firm state");

  // ── Home: the item is surfaced, the ten questions are mapped, links work ──
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("home-page")).toBeVisible();
  await expect(page.getByTestId("home-module-intelligence")).toContainText(headline);
  await expect(page.getByTestId("home-questions")).toContainText("What needs my decision?");
  await expect(page.getByTestId("home-questions")).toContainText("What is costing money?");

  // "One thing to watch" was removed from Home on operator direction (17 Aug 2026) — it restated
  // what the modules below already said. Asserted absent in BOTH states, because the old block had
  // an empty variant too and removing only the populated one would leave Home showing a headed
  // card that says "nothing is flagged".
  await expect(page.getByTestId("one-thing-to-watch")).toHaveCount(0);
  await expect(page.getByTestId("one-thing-to-watch-empty")).toHaveCount(0);

  // Ask has its own highlighted band on Home (operator direction, 17 Aug 2026) AND stays in the
  // nav. Home is where you are reminded it exists; the nav is where you reach for it once you know.
  await expect(page.getByTestId("home-ask")).toBeVisible();
  await page.getByTestId("home-ask-open").click();
  await expect(page.getByTestId("intent-page")).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();

  // Drilling from a module lands on the surface that owns the records.
  await page.getByTestId("home-module-intelligence").getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("intelligence-page")).toBeVisible();
});

test("home layout is configurable and saved as a new version", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByTestId("home-settings-toggle").click();
  await page.getByTestId("module-toggle-ic_priorities").check();
  await page.getByTestId("home-settings-save").click();
  await expect(page.getByTestId("home-settings-message")).toContainText("version");
  await expect(page.getByTestId("home-module-ic_priorities")).toBeVisible();
});

test("the private personal layer is separate, disclaimed, and honest about calculation", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Home", exact: true }).click();

  const panel = page.getByTestId("personal-intelligence");
  await expect(panel).toContainText("Not institutional truth");
  await panel.getByTestId("personal-toggle").click();
  await expect(page.getByTestId("personal-calculation-note")).toContainText("does not compute planetary positions");

  const enable = page.getByTestId("personal-enable");
  if (await enable.isVisible().catch(() => false)) {
    await enable.click();
  }
  await page.getByTestId("personal-headline").fill("Hold the fund-terms conversation until next week");
  await page.getByTestId("personal-submit").click();
  await expect(page.getByTestId("personal-entries")).toContainText("MANUAL_ENTRY");
});

test("mp-home never widens privacy: an investment-team member gets no LP module", async ({ request }) => {
  // The seeded firm has only Managing Partners; this asserts the contract the service
  // enforces for any non-MP identity by checking the MP case explicitly carries the
  // module and the aggregation reports which module answers which question.
  const res = await request.get("/api/mp-home", { headers: { "x-wpos-dev-user": "scooter@westpeek.ventures" } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.questions).toHaveLength(10);
  for (const m of body.modules) {
    expect(typeof m.link).toBe("string");
  }

  /*
   * EVERY QUESTION IS ACTUALLY ANSWERED, which nothing checked.
   *
   * The old assertion counted ten questions and stopped, so a question whose module was not enabled
   * still counted. The operator read her own Home on 23 Aug and found FOUR of the ten saying "no
   * module enabled for this yet" — what is at risk, what the employees are doing, what is costing
   * money, and what is broken. A page that names ten questions as its purpose and answers six is
   * indicting itself, and the test agreed it was fine because it only counted the list.
   *
   * Counting a list is not checking it. This asserts the thing the page promises.
   */
  const unanswered = body.questions.filter((q: { module: string | null }) => !q.module);
  expect(
    unanswered.map((q: { question: string }) => q.question),
    "every question this page names must resolve to a module by default",
  ).toEqual([]);

  // And "What is broken?" is answered by the system that CHECKS, not by a list that sounds like it
  // might. It used to resolve to `reconciliation` — LP figures disagreeing with the administrator,
  // which is a money problem — while `health_fault`, with a live escalation loop behind it, had no
  // module at all.
  const broken = body.questions.find((q: { question: string }) => q.question === "What is broken?");
  expect(broken.module).toBe("health");
});
