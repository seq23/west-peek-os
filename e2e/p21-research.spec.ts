import { expect, test } from "@playwright/test";

/**
 * P21 browser journey — Research / Analyst Workstation (GAP-14).
 *
 * Journey: sign in → Research → launch a project → record a source with its reliability basis →
 * record a finding, which is explicitly labelled research and NOT evidence → promote it, which
 * creates a governed claim → assemble a packet whose IC readiness is computed and explained.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("a finding is research until it is promoted, then it is governed evidence", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByTestId("research-page")).toBeVisible();
  await expect(page.getByTestId("research-rule")).toContainText("no separate evidence store");

  await page.getByTestId("research-title").fill("Late-stage secondaries pricing");
  await page.getByTestId("research-question").fill("Are blocks clearing above or below the last primary?");
  await page.getByTestId("research-submit").click();
  await expect(page.getByTestId("research-page-message")).toContainText("Opened");

  await page.getByTestId("research-source-kind").selectOption("HUMAN");
  await page.getByTestId("research-source-title").fill("Call with a secondaries broker");
  await page.getByTestId("research-source-reliability").selectOption("MEDIUM");
  await page.getByTestId("research-source-basis").fill("first-hand, but a single interested party");
  await page.getByTestId("research-source-submit").click();
  await expect(page.getByTestId("research-sources")).toContainText("Call with a secondaries broker");

  await page.getByTestId("research-finding-statement").fill("Recent AI-infrastructure blocks cleared at a 10-15% discount.");
  await page.getByTestId("research-finding-submit").click();
  await expect(page.getByTestId("research-message")).toContainText("not as evidence");
  await expect(page.getByTestId("research-findings")).toContainText("research only — not evidence");

  const finding = page.locator('[data-testid^="research-finding-rfnd_"]').first();
  await finding.locator('[data-testid^="research-promote-"]').click();
  await expect(page.getByTestId("research-message")).toContainText("Verification is a separate human act");
  await expect(page.getByTestId("research-findings")).toContainText("governed claim");

  // The packet computes readiness and explains it rather than asserting it.
  await page.getByTestId("research-packet-title").fill("Secondaries pricing packet");
  await page.getByTestId("research-packet-submit").click();
  await expect(page.getByTestId("research-message")).toContainText("question(s) still open");
  await expect(page.getByTestId("research-packets")).toContainText("not IC-ready");
});
