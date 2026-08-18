import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P22–P24 browser journey — connectors, specialist lane, LP operations
 * (GAP-15, GAP-16, GAP-17, GAP-18).
 *
 * The point of this journey is that the product tells the truth about the outside world: every
 * connector is NOT_CONFIGURED with its gate named, a configuration check says it contacted
 * nothing, the specialist lane is labelled UNPROVEN — VENDOR ACCESS GATE, and the administrator
 * and VDR sources carry NO_CONTRACT.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("integrations state what is connected, what is gated, and what has never run", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Integrations");
  await expect(page.getByTestId("integrations-page")).toBeVisible();

  // Every connector is unconfigured and names its gate.
  await expect(page.getByTestId("connector-network_os")).toContainText("NOT_CONFIGURED");
  await expect(page.getByTestId("connector-transcription")).toContainText("consent required");
  await expect(page.getByTestId("connector-fund_admin")).toContainText("no source contract has been agreed");
  await expect(page.getByTestId("connector-rules")).toContainText("No secret value is read");

  // A check is explicitly a configuration check.
  await page.getByTestId("connector-check-network_os").click();
  await expect(page.getByTestId("integrations-message")).toContainText("Nothing was contacted");

  // Network OS authority is restated, not quietly assumed.
  await expect(page.getByTestId("network-os-authority")).toContainText("never overwrites it");

  // The specialist lane is labelled honestly.
  await expect(page.getByTestId("specialist-status")).toContainText("UNPROVEN — VENDOR ACCESS GATE");
  await expect(page.getByTestId("specialist-gate")).toContainText("have never been called");
  await expect(page.getByTestId("specialist-providers")).toContainText("0 data class(es) allowed to egress");

  // LP operations show the administrator and VDR gaps as product state.
  await expect(page.getByTestId("lp-ops-authority")).toContainText("never overwrites an administrator figure");
  await expect(page.getByTestId("lp-ops-sources")).toContainText("NO_CONTRACT");
  await expect(page.getByTestId("lp-ops-gates")).toContainText("PROVIDER NOT SELECTED");
});
