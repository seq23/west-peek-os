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

  /*
   * THE CAP CHANGED; THE LAW DID NOT. Migration 0136 employed the whole roster, so the line no
   * longer counts "activation slots in use" — every employee may be ACTIVE at once. What must
   * still be said, and is what this test exists for, is that employing somebody for the FIRST time
   * takes an approved reserved receipt and that no control on this surface can go round it.
   */
  await expect(page.getByTestId("lounge-activation-law")).toContainText("may be ACTIVE at once");
  await expect(page.getByTestId("lounge-activation-law")).toContainText("ai_employee.activate");
  await expect(page.getByTestId("lounge-activation-law")).toContainText("nothing on this surface can bypass it");

  // The whole roster is present, with identity and department, not just a count.
  // Titles were rewritten in the partners' words: "Scooter AI Chief of Staff" reads as a product
  // name; "Scooter's Chief of Staff" is what he is. The card still has to carry WHO and WHICH
  // department, which is what this asserts.
  await expect(page.getByTestId("employee-card-aie_walker")).toContainText("Scooter's Chief of Staff");
  await expect(page.getByTestId("employee-card-aie_walker")).toContainText("MP Support");
  // A second seat from a different department. `aie_paige` is not on the roster any more — the
  // registry is the source of truth for who exists, and a spec that names somebody who was removed
  // fails as though the page were broken.
  await expect(page.getByTestId("employee-card-aie_wyatt")).toContainText("Analyst & Scout");

  // Filtering by department narrows the grid.
  await page.getByTestId("lounge-department").selectOption("MP Support");
  await expect(page.getByTestId("employee-card-aie_walker")).toBeVisible();
  await expect(page.getByTestId("employee-card-aie_wyatt")).toHaveCount(0);
});

test("an operator computes a scorecard and lowers an employee's lifecycle", async ({ page, request }) => {
  /*
   * WHICHEVER EMPLOYEE IS CURRENTLY WORKING, rather than a name pinned in this file.
   *
   * This drove `aie_wells` from INACTIVE — true when every employee started switched off. Migration
   * 0136 employed the whole roster ("Duty hours govern who is actually on"), so lowering now starts
   * from ACTIVE, and re-running the suite twice would find Wells already PAUSED with the control
   * disabled. Picking a working employee at run time keeps this both correct and re-runnable, which
   * is a hard requirement of this suite and not a nicety.
   */
  const roster = (await (await request.get("/api/ai/employees", { headers: { "x-wpos-dev-user": "scooter@westpeek.ventures" } })).json()) as {
    employees: Array<{ id: string; status: string }>;
  };
  const working = roster.employees.find((e) => e.status === "ACTIVE");
  expect(working, "the roster must have somebody working for this journey to lower").toBeTruthy();
  const id = working!.id;

  await signIn(page);
  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await page.getByTestId(`employee-open-${id}`).click();

  const detail = page.getByTestId(`employee-detail-${id}`);
  await expect(detail).toBeVisible();

  await page.getByTestId(`employee-compute-${id}`).click();
  await expect(page.getByTestId(`employee-message-${id}`)).toContainText("Scorecard computed");
  await expect(page.getByTestId(`employee-scorecard-${id}`)).toContainText("run(s)");
  // The honest caveat travels with the number.
  await expect(page.getByTestId(`employee-scorecard-${id}`)).toContainText("No 'value generated' figure is stored");

  // Lowering authority is recorded as a TRANSITION with a from and a to, not as a new state alone.
  await page.getByTestId(`employee-lifecycle-paused-${id}`).click();
  await expect(page.getByTestId(`employee-message-${id}`)).toContainText("Now PAUSED");
  await expect(detail).toContainText("ACTIVE → PAUSED");
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
