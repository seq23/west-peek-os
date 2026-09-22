import { expect, test } from "@playwright/test";
import { openDisclosure, openWorkMachinery } from "./support/nav";
import { provisionLocalD1 } from "./support/provision";

/**
 * P19 browser journey — governed orchestration (GAP-21, GAP-22) — and, since 22 Sep 2026, the
 * Machinery redesign (Addendum 4 item 2 / Addendum 5.1): two buckets, "On a clock" and "One-off",
 * each a stack of one-line rows that expand rather than a full card each.
 *
 * Journey: sign in → Machinery → the seeded Daily Intelligence job is PAUSED and says why, once its
 * row is opened → running it anyway records a REFUSED run → switch it on → run it → a SUCCEEDED run
 * with its outcome summary appears in the job's own history.
 */

async function signIn(page: import("@playwright/test").Page, email = "scooter@westpeek.ventures"): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill(email);
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText(email === "sequoia@westpeek.ventures" ? "Sequoia Taylor" : "Scooter Taylor");
}

test("recurring work starts paused, refuses to run, then runs once switched on", async ({ page }) => {
  await signIn(page);
  /*
   * "Scheduled work" is a SECTION of Work now, not a destination of its own — the rail carries
   * "Work", and the recurring machinery renders underneath the cards a person carries (App.tsx,
   * `active === "work"`). This spec had been clicking a nav button that no longer exists, which is
   * why it timed out rather than failing on an assertion.
   */
  /* The machinery is the Work page's third address since 18 Sep, not a section stacked under the
     board. `openWorkMachinery` walks the operator's path and pins BOTH halves of that contract. */
  await openWorkMachinery(page);
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
   * ONE LINE, COLLAPSED, BY DEFAULT (22 Sep 2026). State and cadence are on the row's summary line
   * and readable without opening it; the reason a job is paused is detail, so it needs a press.
   */
  const job = page.getByTestId("job-daily_intelligence");
  await expect(job.getByTestId("job-state-daily_intelligence")).toHaveText("Paused");
  await openDisclosure(page, "job-details-daily_intelligence");
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

  // Put it back on deliberately, then run it. It sits under "On a clock" with an honest cadence.
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
 * SUPERSEDES THE OLD "under its own heading, with no clock" TEST (22 Sep 2026). The 15 Sep design
 * gave "On request" a second list of its own; Addendum 5.1 explicitly rejected a third Machinery
 * bucket — an on-request job is still a `scheduled_job`, still machinery rather than a card, so it
 * sits in the SAME "On a clock" list as every timed job, tagged and sorted after them (it has no
 * literal time of day to read). What is still worth pinning: it reads honestly as on-request, and
 * it never bleeds into the "One-off" bucket, which is `work_card` rows only.
 */
test("the deck rebuild is on request, in the same On a clock list as timed jobs, and never in One-off", async ({ page }) => {
  await signIn(page);
  await openWorkMachinery(page);
  const list = page.getByTestId("job-list");
  await expect(list.getByTestId("job-deck_rebuild")).toBeVisible();
  await expect(page.getByTestId("job-state-deck_rebuild")).toHaveText("On request");
  await expect(page.getByTestId("job-cadence-deck_rebuild")).toContainText("Only when asked");
  await expect(page.getByTestId("job-cadence-deck_rebuild")).not.toContainText("next ");
  // Not a third bucket, and not a work card either — a job never shows in One-off.
  await expect(page.getByTestId("oneoff-list").getByTestId("job-deck_rebuild")).toHaveCount(0);
  await openDisclosure(page, "job-details-deck_rebuild");
  await expect(page.getByTestId("job-run-deck_rebuild")).toBeVisible();
});

/**
 * Walker's duties for West Peek Productions (15 Sep 2026) are on the clock, and the page says whose
 * business they serve. A job whose card said "no description" was the failure the facts exist to
 * stop; a job for a partner's private agency that read like fund work would be the same failure.
 */
test("Walker's West Peek Productions duty is on the clock, one note a month, labelled as Scooter's agency work", async ({ page }) => {
  await signIn(page);
  await openWorkMachinery(page);
  // ONE job now (15 Sep 2026: "why is scooter getting 2 emails?"), MONTHLY on the 1st (0169); the
  // two it replaced and the one-off introduction are RETIRED and off the page.
  const job = page.getByTestId("job-productions_monthly");
  await expect(job).toBeVisible();
  await expect(page.getByTestId("job-state-productions_monthly")).toHaveText("Scheduled");
  await expect(page.getByTestId("job-cadence-productions_monthly")).toContainText("On the 1st of every month at 14:00 UTC");
  await openDisclosure(page, "job-details-productions_monthly");
  await expect(job).toContainText("Scooter's own agency, not the fund");
  await expect(job).toContainText("Walker");
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

/**
 * The weekly hire search (16 Sep 2026) is a WEEKLY job — a real schedule kind since 0172, not an
 * interval of 10,080 minutes — and the page says "Every Monday at 14:00 UTC". Run it now opens the
 * week's card on Walker's desk.
 */
test("Walker's weekly hire search is WEEKLY on Monday at 14:00 UTC, labelled as Scooter's agency work, and runs by hand", async ({ page }) => {
  await signIn(page);
  await openWorkMachinery(page);
  const job = page.getByTestId("job-productions_hire_search");
  await expect(job).toBeVisible();
  await expect(page.getByTestId("job-state-productions_hire_search")).toHaveText("Scheduled");
  await expect(page.getByTestId("job-cadence-productions_hire_search")).toContainText("Every Monday at 14:00 UTC");
  await openDisclosure(page, "job-details-productions_hire_search");
  await expect(job).toContainText("Scooter's own agency, not the fund");
  await expect(job).toContainText("senior experiential producer, freelance");
  await expect(job).toContainText("Walker");
  provisionLocalD1("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_walker';");
  await page.getByTestId("job-run-productions_hire_search").click();
  await expect(page.getByTestId("jobs-message")).toContainText("SUCCEEDED");
  await expect(page.getByTestId("job-runs-productions_hire_search")).toContainText("Walker's desk");
});

/**
 * THE OTHER BUCKET (Addendum 5.1, 22 Sep 2026): "One-off" is every single-instance `work_card`
 * moving on its own — an authenticated partner email, already running and tagged with the sender,
 * or a card she created and is holding, tagged "held by you" with a flip-on control that calls
 * Wave D's own `/release` door right from the row. Two fixture cards prove both halves and the
 * boundary the redesign turns on: a released card stops being machinery, because now she is working
 * it by hand.
 */
test("One-off shows an email assignment tagged by sender and a held card she can turn on from the row", async ({ page }) => {
  const emailId = "wc_e2e_p19_email_assignment";
  const heldId = "wc_e2e_p19_held_card";
  provisionLocalD1(
    `INSERT OR IGNORE INTO work_card (id, title, owner_type, owner_id, state, firm_scope, created_by, requested_by_email, created_at)
     VALUES ('${emailId}', 'E2E-P19: change the pricing page', 'UNASSIGNED', NULL, 'OPEN', 'west-peek', 'system:inbound_email', 'scooter@westpeek.ventures', '2026-09-20T09:00:00.000Z');`,
  );
  provisionLocalD1(
    `INSERT OR IGNORE INTO work_card (id, title, owner_type, owner_id, state, firm_scope, created_by, held_by, held_reason, held_at, created_at)
     VALUES ('${heldId}', 'E2E-P19: rebuild the onboarding page', 'UNASSIGNED', NULL, 'OPEN', 'west-peek', 'fu_sequoia_taylor', 'fu_sequoia_taylor', 'e2e: wait until she is at her desk', '2026-09-21T09:00:00.000Z', '2026-09-21T09:00:00.000Z');`,
  );

  try {
    await signIn(page, "sequoia@westpeek.ventures");
    await openWorkMachinery(page);
    const list = page.getByTestId("oneoff-list");

    // The email assignment already started itself — tagged by sender, no flip-on control.
    const emailRow = list.getByTestId(`oneoff-${emailId}`);
    await expect(emailRow).toBeVisible();
    await expect(emailRow.getByTestId(`oneoff-tag-${emailId}`)).toHaveText("from scooter@westpeek.ventures");
    await expect(page.getByTestId(`oneoff-release-${emailId}`)).toHaveCount(0);

    // The held card is tagged "held by you", carries her reason, and offers the flip-on control.
    const heldRow = list.getByTestId(`oneoff-${heldId}`);
    await expect(heldRow).toBeVisible();
    await expect(heldRow.getByTestId(`oneoff-tag-${heldId}`)).toHaveText("held by you");
    await expect(heldRow.getByTestId(`oneoff-held-${heldId}`)).toContainText("wait until she is at her desk");
    await expect(page.getByTestId(`oneoff-release-${heldId}`)).toBeVisible();

    // Turning it on calls Wave D's own release door, right from the row — no separate page visit.
    await page.getByTestId(`oneoff-release-${heldId}`).click();
    await expect(page.getByTestId("jobs-message")).toContainText("turned on");
    // Released, it is no longer sitting on her flip or started by an authenticated email — she is
    // now working it by hand through the ordinary Work flow, so it leaves Machinery altogether.
    await expect(page.getByTestId(`oneoff-${heldId}`)).toHaveCount(0);
  } finally {
    provisionLocalD1(`DELETE FROM work_card WHERE id IN ('${emailId}', '${heldId}');`);
  }
});
