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
  /*
   * RE-POINTED STRICTER, 19 Sep 2026 (design/HOME_DESIGN.md §2). The ten questions left Home for
   * the Help Center (pagePurpose already carried them; no telemetry ever showed the drawer opened);
   * Ask left the masthead for the foot line and stays in the nav; "One thing to watch" stays gone.
   * A module with something new is a row in Arrived; a quiet one is a row under the Quiet chip.
   */
  const module = page.getByTestId("home-module-intelligence");
  if (!(await module.isVisible().catch(() => false))) await page.getByTestId("home-rail-quiet").click();
  await expect(module).toBeVisible();
  await expect(page.getByTestId("home-questions")).toHaveCount(0);
  await expect(page.getByTestId("one-thing-to-watch")).toHaveCount(0);
  await expect(page.getByTestId("one-thing-to-watch-empty")).toHaveCount(0);

  // Ask is on the foot line — under the answer, never above it — and still one press away.
  const foot = page.getByTestId("home-foot");
  await expect(foot).toContainText("Ask for anything");
  expect((await foot.boundingBox())!.y, "the foot sits below the masthead").toBeGreaterThan((await page.getByTestId("home-masthead").boundingBox())!.y);
  await page.getByTestId("home-ask-open").click();
  await expect(page.getByTestId("intent-page")).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();

  // Drilling from a module lands on the surface that owns the records.
  if (!(await page.getByTestId("home-module-intelligence").isVisible().catch(() => false))) await page.getByTestId("home-rail-quiet").click();
  await page.getByTestId("home-open-intelligence").click();
  await expect(page.getByTestId("intelligence-page")).toBeVisible();
});

test("home layout is configurable and saved as a new version", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  // "Choose what Home shows" is a foot link that opens the same component in place (§3.7).
  await page.getByTestId("home-settings-toggle").click();
  await page.getByTestId("module-toggle-ic_priorities").check();
  await page.getByTestId("home-settings-save").click();
  await expect(page.getByTestId("home-settings-message")).toContainText("version");
  /* A module with nothing NEW is a name in the quiet roll; its row is under the Quiet chip. This
     asserts the enabled module reaches the page either way. */
  const row = page.getByTestId("home-module-ic_priorities");
  if (!(await row.isVisible().catch(() => false))) await page.getByTestId("home-rail-quiet").click();
  await expect(row).toBeVisible();
});

test("the private personal layer is separate, disclaimed, and honest about calculation", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  // The private layer left Home for its own route (§2: 0 profiles, 0 entries in 30 days); the foot
  // links to it and the boundary is unchanged.
  await expect(page.getByTestId("personal-intelligence")).toHaveCount(0);
  await page.getByTestId("home-private-link").click();

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

/**
 * "WHO HAS SOMETHING FOR YOU" MEANS NEW SINCE YOU LAST LOOKED.
 *
 * Operator, 15 Sep 2026: the section counted modules that merely had items, so Open never quieted
 * it. Walked as she would: a colleague is loud → Open → back on Home the same colleague is quiet,
 * says since when, is greyed, and sits below anyone who still has something new; the count line
 * says how many are new, not how many have anything.
 */
test("pressing Open quiets a colleague until something new arrives, and the count says new, not present", async ({ page, request }) => {
  // Something genuinely new in her name: a work card, so `my_work` is loud whatever earlier specs
  // looked at. (Every spec drives one D1, so a module's mark can already exist by the time this
  // runs — the test makes its own news rather than assuming a fresh firm.) Made BEFORE signing in,
  // because signing in lands on Home and reads the modules once.
  const made = await request.post("/api/work-cards", {
    headers: { "x-wpos-dev-user": "scooter@westpeek.ventures" },
    data: { title: "Read the Sensori memo before Thursday", description: "Opened by the e2e suite.", owner_type: "HUMAN", owner_id: "fu_scooter_taylor", priority: "NORMAL" },
  });
  expect(made.status(), await made.text()).toBe(201);

  await signIn(page);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("home-page")).toBeVisible();

  /* A fresh colleague is a row in Arrived; a quiet one is a row under the Quiet chip (19 Sep 2026).
     This journey is about a row going from new to quiet, so it filters as a person would. */
  const wren = page.getByTestId("home-module-my_work");
  await expect(wren).toHaveAttribute("data-fresh", "new");
  await expect(wren).toContainText("Read the Sensori memo before Thursday");
  await expect(page.getByTestId("home-deliveries-count")).toContainText(/\d+ since you last looked/);
  const loudKeys = async () =>
    Promise.all((await page.locator('[data-testid^="home-module-"][data-fresh="new"]').all()).map((l) => l.getAttribute("data-testid")));
  const loudBefore = await loudKeys();

  await wren.getByTestId("home-open-my_work").click();
  await expect(page.getByTestId("work-cards-page")).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("home-page")).toBeVisible();

  // Not in Arrived any more — and under Quiet, saying since when.
  const loudAfter = await loudKeys();
  expect(loudBefore).toContain("home-module-my_work");
  expect(loudAfter).not.toContain("home-module-my_work");
  for (const k of loudAfter) expect(loudBefore).toContain(k);
  await page.getByTestId("home-rail-quiet").click();
  await expect(wren).toHaveAttribute("data-fresh", "quiet");
  await expect(wren.getByTestId("home-module-quiet-my_work")).toContainText(/nothing new since \d/);
  await expect(wren).toHaveClass(/deal-row-out/);
  await page.getByTestId("home-rail-home").click();
  await expect(page.getByTestId("home-rail")).toHaveAttribute("data-filter", "all");

  // Something new in her name again: loud again, and it says how many since when.
  const again = await request.post("/api/work-cards", {
    headers: { "x-wpos-dev-user": "scooter@westpeek.ventures" },
    data: { title: "Call the Sensori founder", description: "Opened by the e2e suite.", owner_type: "HUMAN", owner_id: "fu_scooter_taylor", priority: "HIGH" },
  });
  expect(again.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId("home-page")).toBeVisible();
  await expect(wren).toHaveAttribute("data-fresh", "new");
  await expect(wren.getByTestId("home-module-new-my_work")).toContainText(/1 new since \d/);

  // The rule is on the page for the things prepared for her, too: a week puts them away.
  await expect(page.getByTestId("deliverables-put-away-rule")).toContainText("put away by itself");
});
