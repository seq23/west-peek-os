import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1 } from "./support/provision";

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
   * The card says "Paused" with the reason beside it (15 Sep 2026: a job is on unless there is a
   * stated reason, so the reason is the thing worth showing). The raw enum never reaches the page.
   */
  const job = page.getByTestId("job-daily_intelligence");
  await expect(job.getByTestId("job-state-daily_intelligence")).toHaveText("Paused");
  await expect(job.getByTestId("job-paused-daily_intelligence")).toContainText("operator must switch recurring work on");

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
  // Still paused. Running it by hand is not putting it back on.
  await expect(page.getByTestId("job-state-daily_intelligence")).toHaveText("Paused");

  // Put it back on deliberately, then run it. It sits under "Scheduled work" with an honest cadence.
  await page.getByTestId("job-resume-daily_intelligence").click();
  await expect(page.getByTestId("job-state-daily_intelligence")).toHaveText("Scheduled");
  await expect(page.getByTestId("job-list").getByTestId("job-daily_intelligence")).toBeVisible();
  await expect(page.getByTestId("job-cadence-daily_intelligence")).toContainText(/Every \d+ minutes|Every hour|Every day at/);

  await page.getByTestId("job-run-daily_intelligence").click();
  await expect(page.getByTestId("jobs-message")).toContainText("SUCCEEDED");
  await expect(page.getByTestId("job-runs-daily_intelligence")).toContainText("SUCCEEDED");

  // PAUSING NEEDS A REASON. An empty prompt leaves it on; a reason pauses it and is shown beside it.
  page.once("dialog", (d) => d.dismiss());
  await page.getByTestId("job-pause-daily_intelligence").click();
  await expect(page.getByTestId("jobs-message")).toContainText("a reason is required");
  await expect(page.getByTestId("job-state-daily_intelligence")).toHaveText("Scheduled");
  page.once("dialog", (d) => d.accept("the sources are being re-registered this week"));
  await page.getByTestId("job-pause-daily_intelligence").click();
  await expect(page.getByTestId("job-state-daily_intelligence")).toHaveText("Paused");
  await expect(page.getByTestId("job-paused-daily_intelligence")).toContainText("the sources are being re-registered this week");
  await page.getByTestId("job-resume-daily_intelligence").click();
  await expect(page.getByTestId("job-state-daily_intelligence")).toHaveText("Scheduled");
});

/**
 * Two sections (15 Sep 2026): work on a clock, and work that runs only when asked. The deck
 * rebuild is ON_REQUEST — no timer, "Only when asked" — and nothing on the page is hard-coded by
 * job key to say so.
 */
test("the deck rebuild is on request, under its own heading, with no clock", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Work");
  const onRequest = page.getByTestId("job-list-on-request");
  await expect(onRequest.getByTestId("job-deck_rebuild")).toBeVisible();
  await expect(page.getByTestId("job-state-deck_rebuild")).toHaveText("On request");
  await expect(page.getByTestId("job-cadence-deck_rebuild")).toContainText("Only when asked");
  await expect(page.getByTestId("job-cadence-deck_rebuild")).not.toContainText("next ");
  await expect(page.getByTestId("job-list").getByTestId("job-deck_rebuild")).toHaveCount(0);
  await expect(page.getByTestId("job-run-deck_rebuild")).toBeVisible();
});

/**
 * Walker's duties for West Peek Productions (15 Sep 2026) are on the clock, and the page says whose
 * business they serve. A job whose card said "no description" was the failure the facts exist to
 * stop; a job for a partner's private agency that read like fund work would be the same failure.
 */
test("Walker's West Peek Productions duty is on the clock, one note a month, labelled as Scooter's agency work", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Work");
  // ONE job now (15 Sep 2026: "why is scooter getting 2 emails?"), MONTHLY on the 1st (0169); the
  // two it replaced and the one-off introduction are RETIRED and off the page.
  const job = page.getByTestId("job-productions_monthly");
  await expect(job).toBeVisible();
  await expect(job).toContainText("Scooter's own agency, not the fund");
  await expect(job).toContainText("Walker");
  await expect(page.getByTestId("job-state-productions_monthly")).toHaveText("Scheduled");
  await expect(page.getByTestId("job-cadence-productions_monthly")).toContainText("On the 1st of every month at 14:00 UTC");
  for (const key of ["productions_customer_ideas", "productions_press_pitches", "productions_intro_note"]) {
    await expect(page.getByTestId(`job-${key}`)).toHaveCount(0);
  }
  // Run it by hand: it opens the month's card on Walker's desk and says so. Walker is put on duty
  // first — an earlier journey in the suite may have paused him, and a scheduled job may never
  // activate an employee itself (D10), so a paused Walker is a correct REFUSED, not this test.
  provisionLocalD1("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_walker';");
  await page.getByTestId("job-run-productions_monthly").click();
  await expect(page.getByTestId("jobs-message")).toContainText("SUCCEEDED");
  await expect(page.getByTestId("job-runs-productions_monthly")).toContainText("Walker's desk");
});
