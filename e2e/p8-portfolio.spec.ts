import { expect, test } from "@playwright/test";

/**
 * P8 browser journeys against local `wrangler dev` (plan §12.3):
 * "portfolio metric → alert" and "support match → approval gate".
 *
 * Two dated snapshots produce a deterioration alert; the alert opens a support
 * request; a proposed match is accepted, which creates — but does not satisfy —
 * the MP-reserved introduction approval card. Nothing is sent.
 *
 * Runs fully offline: local D1 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P8 portfolio journey: dated metrics → alert → support request → match → MP introduction gate", async ({ page, request }) => {
  const marker = `E2E-P8-${Date.now()}`;
  const metricKey = `arr_${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await page.getByRole("button", { name: "Companies", exact: true }).click();
  await page.getByTestId("company-create-name").fill(`${marker} Co`);
  await page.getByTestId("company-create-submit").click();
  await expect(page.getByTestId("company-message")).toContainText("Created");

  await page.getByRole("button", { name: "Portfolio", exact: true }).click();
  await page.getByTestId("portfolio-company").selectOption({ label: `${marker} Co` });
  await page.getByTestId("metric-key").fill(metricKey);
  await page.getByTestId("metric-define").click();
  await expect(page.getByTestId("portfolio-message")).toContainText("Metric definition ok");

  // Two DATED snapshots: 1000 → 800 is a 20% deterioration (operator HIGH band).
  await page.getByTestId("snapshot-date").fill("2026-01-31");
  await page.getByTestId("snapshot-value").fill("1000");
  await page.getByTestId("snapshot-submit").click();
  await expect(page.getByTestId("portfolio-message")).toContainText("Snapshot ok");
  await page.getByTestId("snapshot-date").fill("2026-02-28");
  await page.getByTestId("snapshot-value").fill("800");
  await page.getByTestId("snapshot-submit").click();
  await expect(page.getByTestId("portfolio-message")).toContainText("Snapshot ok");

  await page.getByTestId("evaluate-alerts").click();
  await expect(page.getByTestId("portfolio-message")).toContainText("Evaluation ok");
  const deterioration = page.locator('li[data-testid^="alert-"]', { hasText: "METRIC_DETERIORATION" }).first();
  await expect(deterioration).toContainText("HIGH");
  await expect(deterioration).toContainText(metricKey);

  // The alert opens a support request; a proposed match is accepted, which only
  // opens the MP-reserved introduction approval — it never contacts anyone.
  await deterioration.locator('button[data-testid^="alert-support-"]').click();
  await expect(page.getByTestId("portfolio-message")).toContainText("Support request ok");
  await page.locator('button[data-testid^="support-open-"]').first().click();
  await expect(page.getByTestId("support-detail")).toBeVisible();
  await page.getByTestId("match-target").fill(`${marker} intro candidate`);
  await page.getByTestId("match-submit").click();
  await expect(page.getByTestId("match-list")).toContainText(`${marker} intro candidate`);
  await page.locator('button[data-testid^="match-accept-"]').first().click();
  await expect(page.getByTestId("support-message")).toContainText("approval card apc_");
  await expect(page.getByTestId("match-list")).toContainText("ACCEPTED");

  const cardId = /apc_[0-9a-f-]+/.exec((await page.getByTestId("support-message").textContent()) ?? "")?.[0];
  expect(cardId).toBeTruthy();

  // The introduction approval is pending an MP — and nothing has been sent.
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("introduction.relationship_sensitive");
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("pending_review");
  const effects = (await (await request.get("/api/effects/requests", { headers: MP })).json()) as { effect_requests: unknown[] };
  expect(effects.effect_requests).toHaveLength(0);

  // Alert volume is observable, with the quality caveat stated explicitly.
  const volume = (await (await request.get("/api/diagnostics/alert-volume", { headers: MP })).json()) as { note: string; by_day: unknown[] };
  expect(volume.note).toContain("UNPROVEN");
  expect(volume.by_day.length).toBeGreaterThan(0);
});
