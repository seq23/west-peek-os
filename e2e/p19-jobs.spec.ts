import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P19 browser journey — governed orchestration (GAP-21, GAP-22).
 *
 * Journey: sign in → Scheduled Work → the seeded Daily Intelligence job is PAUSED and says why →
 * running it anyway records a REFUSED run → switch it on → run it → a SUCCEEDED run with its
 * outcome summary appears in the job's own history.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("recurring work starts paused, refuses to run, then runs once switched on", async ({ page }) => {
  await signIn(page);
  /*
   * "Scheduled work" is a SECTION of Work now, not a destination of its own — the rail carries
   * "Work", and the recurring machinery renders underneath the cards a person carries (App.tsx,
   * `active === "work"`). This spec had been clicking a nav button that no longer exists, which is
   * why it timed out rather than failing on an assertion.
   */
  await gotoSurface(page, "Work");
  await expect(page.getByTestId("jobs-page")).toBeVisible();
  /*
   * The page says what recurring work IS before it lists any.
   *
   * This used to assert the sentence "No Queues, no Durable Objects" out of a `jobs-architecture`
   * block. That block was deliberately deleted (JobsPage.tsx: "nobody switching a job on needs to
   * know which primitives it is built from"), and ADR-017 is enforced in the code and the config,
   * not by a paragraph on a page — asserting the paragraph only ever proved that somebody had typed
   * it. What is worth holding here is that the surface explains itself at all, which is the rule
   * every surface in this product is held to.
   */
  await expect(page.getByTestId("how-this-works-jobs")).toBeVisible();

  /*
   * The card says "Switched off", not PAUSED. The raw enum came off every card in the plain-English
   * pass — a page that prints its own database vocabulary makes the reader translate — and the
   * state itself is unchanged, so what this asserts is unchanged too.
   */
  const job = page.getByTestId("job-daily_intelligence");
  await expect(job).toContainText("Switched off");
  await expect(job).toContainText("operator must switch recurring work on");

  /*
   * A PAUSE STOPS THE TIMER, NOT A PARTNER.
   *
   * This used to assert REFUSED, and the refusal was a defect. Every pause_reason in this repo
   * tells the reader to run the job by hand — deck_rebuild's says "Run it from Work, or POST
   * /api/jobs/deck_rebuild/run" — and following that sentence returned "REFUSED: job is PAUSED",
   * confirmed against production on 9 Sep 2026. A message that instructs an operator to do
   * something the system then refuses costs a person their time proving the software wrong.
   *
   * The run SAYS it happened while paused, which is the part worth asserting: the operator must
   * never be left wondering why a switched-off job produced work. The clock is still refused —
   * that half is held in tests/jobs.test.ts, where a SCHEDULED trigger can be driven directly.
   */
  await page.getByTestId("job-run-daily_intelligence").click();
  await expect(page.getByTestId("jobs-message")).toContainText("while the job is PAUSED");
  // Still switched off. Running it by hand is not switching it on.
  await expect(page.getByTestId("job-daily_intelligence")).toContainText("Switched off");

  // Switch it on deliberately, then run it.
  await page.getByTestId("job-reason").fill("operator switching the daily brief on");
  await page.getByTestId("job-toggle-daily_intelligence").click();
  await expect(page.getByTestId("job-daily_intelligence")).toContainText("Running");

  await page.getByTestId("job-run-daily_intelligence").click();
  await expect(page.getByTestId("jobs-message")).toContainText("SUCCEEDED");
  await expect(page.getByTestId("job-runs-daily_intelligence")).toContainText("SUCCEEDED");
});
