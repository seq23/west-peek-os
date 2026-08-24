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

  // Every connector is unconfigured and names its gate — in words, not in enum values. The page
  // stopped printing NOT_CONFIGURED / NO_CONTRACT / UNPROVEN at a reader (item 25, 21 Aug 2026).
  await expect(page.getByTestId("connector-network_os")).toContainText("Not set up");
  await expect(page.getByTestId("connector-transcription")).toContainText("the other side must agree");
  await expect(page.getByTestId("connector-fund_admin")).toContainText("no source contract has been agreed");
  await expect(page.getByTestId("connector-rules")).toContainText("No secret value is read");

  /*
   * A CHECK REPORTS WHAT IT ACTUALLY DID, and the two connectors below do different things.
   *
   * The Network OS check became a LIVE one on 22 Aug 2026 — it mints a session and contacts the
   * partner system, reading nothing. Under `wrangler dev --local` there is no origin configured, so
   * the honest outcome is a NAMED refusal rather than either a green light or a shrug: it says which
   * setting is missing and that a pull would refuse. That is the property asserted, not the
   * sentence — a check that came back reassuring with nothing configured would be the failure.
   */
  await page.getByTestId("connector-check-network_os").click();
  const networkCheck = page.getByTestId("integrations-message");
  await expect(networkCheck).toContainText("WP_OS_NETWORK_OS_BASE_URL");
  // The one sentence a passing check prints. Asserting its ABSENCE is what proves the refusal, and
  // it survives the other half of the message changing with whether a contract happens to exist.
  await expect(networkCheck, "an unconfigured connector must not read as working").not.toContainText("pulls can run");

  /*
   * The fund administrator's check is still a CONFIGURATION check and says so. Nothing is contacted,
   * because there is no agreement with an administrator and there is no code path that could write
   * to one — which is the honesty this page exists for.
   */
  await page.getByTestId("connector-check-fund_admin").click();
  await expect(page.getByTestId("integrations-message")).toContainText("Nothing was contacted");

  // Network OS authority is restated, not quietly assumed.
  await expect(page.getByTestId("network-os-authority")).toContainText("never overwrites it");

  // The specialist lane is labelled honestly.
  await expect(page.getByTestId("specialist-status")).toContainText("has ever been called");
  await expect(page.getByTestId("specialist-gate")).toContainText("have never been called");
  await expect(page.getByTestId("specialist-providers")).toContainText("0 kinds of firm information may leave");

  // LP operations show the administrator and VDR gaps as product state.
  await expect(page.getByTestId("lp-ops-authority")).toContainText("never overwrites an administrator figure");
  await expect(page.getByTestId("lp-ops-sources")).toContainText("no agreement yet");
  await expect(page.getByTestId("lp-ops-gates")).toContainText("The data room");
  await expect(page.getByTestId("lp-ops-gates")).toContainText("never delivered a document");
});
