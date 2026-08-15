import { expect, test } from "@playwright/test";

/**
 * P15 browser journey — Employee Lounge / Digital Office (GAP-01, GAP-10, GAP-11).
 *
 * Journey: sign in → Employees → the whole roster with departments and the activation cap
 * → open an employee → compute a scorecard from real run history → lower its lifecycle →
 * the change lands on the status history → a department room accepts a human announcement.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("the lounge shows the governed roster and the activation cap it cannot bypass", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await expect(page.getByTestId("employees-page")).toBeVisible();

  await expect(page.getByTestId("lounge-activation-law")).toContainText("activation slots in use");
  await expect(page.getByTestId("lounge-activation-law")).toContainText("ai_employee.activate");

  // The whole roster is present, with identity and department, not just a count.
  await expect(page.getByTestId("employee-card-aie_walker")).toContainText("Scooter AI Chief of Staff");
  await expect(page.getByTestId("employee-card-aie_paige")).toContainText("Research Analyst");

  // Filtering by department narrows the grid.
  await page.getByTestId("lounge-department").selectOption("MP Support");
  await expect(page.getByTestId("employee-card-aie_walker")).toBeVisible();
  await expect(page.getByTestId("employee-card-aie_paige")).toHaveCount(0);
});

test("an operator computes a scorecard and lowers an employee's lifecycle", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await page.getByTestId("employee-open-aie_wells").click();

  const detail = page.getByTestId("employee-detail-aie_wells");
  await expect(detail).toBeVisible();

  await page.getByTestId("employee-compute-aie_wells").click();
  await expect(page.getByTestId("employee-message-aie_wells")).toContainText("Scorecard computed");
  await expect(page.getByTestId("employee-scorecard-aie_wells")).toContainText("run(s)");
  // The honest caveat travels with the number.
  await expect(page.getByTestId("employee-scorecard-aie_wells")).toContainText("No 'value generated' figure is stored");

  await page.getByTestId("employee-lifecycle-paused-aie_wells").click();
  await expect(page.getByTestId("employee-message-aie_wells")).toContainText("Now PAUSED");
  await expect(detail).toContainText("INACTIVE → PAUSED");
});

test("a department room takes a human announcement and shows its members", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await page.getByTestId("room-open-mp_support").click();
  await expect(page.getByTestId("room-detail")).toContainText("Walker");

  await page.getByTestId("room-announce-body").fill("Operating note posted from the P15 journey.");
  await page.getByTestId("room-announce-submit").click();
  await expect(page.getByTestId("room-message")).toContainText("Announcement posted");
  await expect(page.getByTestId("room-messages")).toContainText("Operating note posted from the P15 journey.");
});
