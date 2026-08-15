import { expect, test } from "@playwright/test";

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
  await page.getByRole("button", { name: "Scheduled Work", exact: true }).click();
  await expect(page.getByTestId("jobs-page")).toBeVisible();
  await expect(page.getByTestId("jobs-architecture")).toContainText("No Queues, no Durable Objects");

  const job = page.getByTestId("job-daily_intelligence");
  await expect(job).toContainText("PAUSED");
  await expect(job).toContainText("operator must switch recurring work on");

  // Running a paused job records a refusal rather than doing the work.
  await page.getByTestId("job-run-daily_intelligence").click();
  await expect(page.getByTestId("jobs-message")).toContainText("REFUSED");

  // Switch it on deliberately, then run it.
  await page.getByTestId("job-reason").fill("operator switching the daily brief on");
  await page.getByTestId("job-toggle-daily_intelligence").click();
  await expect(page.getByTestId("job-daily_intelligence")).toContainText("ACTIVE");

  await page.getByTestId("job-run-daily_intelligence").click();
  await expect(page.getByTestId("jobs-message")).toContainText("SUCCEEDED");
  await expect(page.getByTestId("job-runs-daily_intelligence")).toContainText("SUCCEEDED");
});
