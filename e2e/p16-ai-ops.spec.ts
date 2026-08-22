import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P16 browser journey — provider router + AI cost command center (GAP-02, GAP-03).
 *
 * Journey: sign in → AI Ops → providers show credential presence (never a value) and a
 * health check that admits it contacted nobody → the model catalogue prints pricing
 * provenance beside every price → a Managing Partner sets a scoped budget → the cost
 * surface reports spend with its definitions attached.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("the provider surface reports credential presence and an honest health check", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Cockpit");
  await expect(page.getByTestId("ai-ops-page")).toBeVisible();

  // Credential presence by NAME, and it is NOT configured in this environment.
  await expect(page.getByTestId("catalog-credential-openrouter")).toContainText("OPENROUTER_API_KEY not configured");
  await expect(page.getByTestId("catalog-credential-fireworks")).toContainText("FIREWORKS_API_KEY not configured");

  await page.getByTestId("catalog-check-openrouter").click();
  await expect(page.getByTestId("ai-ops-message")).toContainText("No request was made");
  await expect(page.getByTestId("catalog-health-openrouter")).toContainText("LOCAL_FIXTURE");
});

test("the model catalogue prints pricing provenance beside the price", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Cockpit");

  const row = page.getByTestId("model-row-gpt-4o-mini");
  await expect(row).toContainText("ILLUSTRATIVE");
  await expect(page.getByTestId("model-row-llama-v3p1-70b-instruct")).toBeVisible();
  await expect(page.locator("body")).toContainText("ILLUSTRATIVE means placeholder configuration, not a vendor price");
});

test("a Managing Partner sets a scoped budget and the cost centre shows its definitions", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Cockpit");

  await page.getByTestId("budget-scope-type").selectOption("CATEGORY");
  await page.getByTestId("budget-scope-id").fill("RESEARCH");
  await page.getByTestId("budget-period").selectOption("MONTHLY");
  await page.getByTestId("budget-cap").fill("40");
  await page.getByTestId("budget-submit").click();

  await expect(page.getByTestId("ai-ops-message")).toContainText("version");
  await expect(page.getByTestId("budget-list")).toContainText("CATEGORY:RESEARCH");

  await expect(page.getByTestId("cost-definitions")).toContainText("benefit is not measured as money");
  await expect(page.getByTestId("cost-totals")).toContainText("what has it cost");

  // The two adjacent figures the operator asked about now say why there are two of them.
  await expect(page.getByTestId("cost-two-blocks")).toContainText("not the same number");

  // The firmwide ceiling — both windows, present even when nothing has been set.
  await expect(page.getByTestId("firm-budget-MONTHLY")).toContainText("Most it may spend in a month");
  await expect(page.getByTestId("firm-budget-ALL_TIME")).toContainText("Most it may ever spend");

  // And the quarantine has somewhere to go. It was 51 rows deep with no button.
  await expect(page.getByTestId("quarantine-queue")).toBeVisible();
});
