import { expect, test } from "@playwright/test";

/**
 * P18 browser journey — Intent → Execution + the Institutional Lens Bench (GAP-08, GAP-09).
 *
 * Journey: sign in → Intent → write a rough thought → the packet shows the operator's own words
 * verbatim alongside derived ambiguities, assumptions, risks, and acceptance criteria → execution
 * is REFUSED while the blocking lens has not run → record the gate → execute → a real work card
 * and governed run are recorded on the packet.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("a rough thought becomes a governed packet the lens bench can stop", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Intent → Execution", exact: true }).click();
  await expect(page.getByTestId("intent-page")).toBeVisible();

  const thought = "Look into the Acme secondary soon and tell me if we should take the block";
  await page.getByTestId("intent-text").fill(thought);
  await page.getByTestId("intent-strength").selectOption("DEEP");
  await page.getByTestId("intent-submit").click();
  await expect(page.getByTestId("intent-message")).toContainText("Packet opened");

  // The operator's own words survive verbatim, beside the derived fields.
  await expect(page.getByTestId("packet-original")).toContainText(thought);
  await expect(page.getByTestId("packet-original")).toContainText("never rewrites this");
  await expect(page.getByTestId("packet-ambiguities")).toContainText("soon");
  await expect(page.getByTestId("packet-acceptance")).toContainText("counter-case");

  // The blocking lens is visible and unrun, and execution is refused because of it.
  await expect(page.getByTestId("packet-lens-TRUTH_COMPLIANCE_GATE")).toContainText("execution is refused until it does");
  await page.getByTestId("packet-execute").click();
  await expect(page.getByTestId("packet-message")).toContainText("TRUTH_COMPLIANCE_GATE");

  // Record the gate, then execute for real.
  await page.getByTestId("lens-key").selectOption("TRUTH_COMPLIANCE_GATE");
  await page.getByTestId("lens-verdict").selectOption("PASS");
  await page.getByTestId("lens-critique").fill("Internal analysis of records we hold; asserts no external conclusion.");
  await page.getByTestId("lens-submit").click();
  await expect(page.getByTestId("packet-message")).toContainText("recorded as PASS");

  await page.getByTestId("packet-execute").click();
  await expect(page.getByTestId("packet-message")).toContainText("Work card opened");
  // The packet now carries the real work card and governed run it produced.
  await expect(page.locator('[data-testid^="packet-detail-"]')).toContainText("work card");
  await expect(page.locator('[data-testid^="packet-detail-"]')).toContainText("COMPLETE");
});

test("the lens bench publishes its storage rule", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Intent → Execution", exact: true }).click();
  await expect(page.getByTestId("lens-storage-rule")).toContainText("Private model reasoning is never stored");
  await expect(page.getByTestId("lens-bench")).toContainText("No Pedestal Law");
});
