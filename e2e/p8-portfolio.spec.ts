import { expect, test } from "@playwright/test";
import { actionName, approvalStateWords } from "@shared/help/actionNames";
import { gotoSurface, openDisclosure } from "./support/nav";

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

  /*
   * Creating a company is inside the `company-identity` disclosure now. The Companies route leads
   * with the register and folds the identity/evidence workbench underneath it, so this step used to
   * time out on an input that was present and invisible.
   */
  await gotoSurface(page, "Companies");
  await openDisclosure(page, "company-identity");
  await page.getByTestId("company-create-name").fill(`${marker} Co`);
  await page.getByTestId("company-create-submit").click();
  await expect(page.getByTestId("company-message")).toContainText("Created");

  /*
   * The monitoring surface speaks English throughout now, and that is what broke every assertion
   * below. `METRIC_DETERIORATION` reads "went the wrong way", `HIGH` reads "Serious", and the
   * confirmations are sentences rather than "…ok". The metric is also NAMED by a person and keyed
   * by a slug derived from the name, so a figure is recorded against a metric picked from a list
   * rather than against whatever string was typed. None of the governed behaviour moved: two dated
   * figures still produce a deterioration alert, and the alert still opens a support request.
   */
  await gotoSurface(page, "Portfolio");
  await page.getByTestId("portfolio-company").selectOption({ label: `${marker} Co` });
  await page.getByTestId("metric-key").fill(metricKey);
  await page.getByTestId("metric-define").click();
  await expect(page.getByTestId("portfolio-message")).toContainText(`Now tracking ${metricKey}`);

  // Two DATED snapshots: 1000 → 800 is a 20% deterioration (operator HIGH band).
  await page.getByTestId("snapshot-metric").selectOption({ label: metricKey });
  await page.getByTestId("snapshot-date").fill("2026-01-31");
  await page.getByTestId("snapshot-value").fill("1000");
  await page.getByTestId("snapshot-submit").click();
  await expect(page.getByTestId("portfolio-message")).toContainText("as of 2026-01-31");
  await page.getByTestId("snapshot-date").fill("2026-02-28");
  await page.getByTestId("snapshot-value").fill("800");
  await page.getByTestId("snapshot-submit").click();
  await expect(page.getByTestId("portfolio-message")).toContainText("as of 2026-02-28");

  await page.getByTestId("evaluate-alerts").click();
  await expect(page.getByTestId("portfolio-message")).toContainText("to look at");
  const deterioration = page.locator('li[data-testid^="alert-"]', { hasText: "went the wrong way" }).first();
  // "Serious" is what HIGH is called on the page; the severity itself is unchanged.
  await expect(deterioration).toContainText("Serious");
  await expect(deterioration).toContainText(metricKey);

  // The alert opens a support request; a proposed match is accepted, which only
  // opens the MP-reserved introduction approval — it never contacts anyone.
  await deterioration.locator('button[data-testid^="alert-support-"]').click();
  await expect(page.getByTestId("portfolio-message")).toContainText("asked for help");
  await page.locator('button[data-testid^="support-open-"]').first().click();
  await expect(page.getByTestId("support-detail")).toBeVisible();
  await page.getByTestId("match-target").fill(`${marker} intro candidate`);
  await page.getByTestId("match-submit").click();
  await expect(page.getByTestId("match-list")).toContainText(`${marker} intro candidate`);
  await page.locator('button[data-testid^="match-accept-"]').first().click();
  await expect(page.getByTestId("support-message")).toContainText("approval card apc_");
  // The state says what it MEANS — "accepted — waiting on a partner to make the introduction" —
  // rather than printing ACCEPTED. Which is the whole point of this journey: accepting a match is
  // not making an introduction, and the row now says so where it used to leave the reader to know.
  await expect(page.getByTestId("match-list")).toContainText("waiting on a partner to make the introduction");

  const cardId = /apc_[0-9a-f-]+/.exec((await page.getByTestId("support-message").textContent()) ?? "")?.[0];
  expect(cardId).toBeTruthy();

  // The introduction approval is pending an MP — and nothing has been sent.
  await gotoSurface(page, "Approvals");
  /*
   * The queue speaks English now. It used to print the action key and the raw state — the card read
   * `introduction.relationship_sensitive` and `pending_review` — and both were replaced by the words
   * a partner uses (`actionName` / `APPROVAL_STATE_WORDS` in shared/help/actionNames.ts).
   *
   * Both assertions are kept, and both now read from that shared module rather than from a string
   * typed here, so the next rewording moves them instead of breaking them. What is being proved is
   * unchanged: the introduction is waiting on a Managing Partner, and nothing has been sent.
   */
  const approvalCard = page.getByTestId(`approval-card-${cardId}`);
  await expect(approvalCard).toBeVisible();
  await expect(approvalCard).toContainText(approvalStateWords("pending_review").label);
  await expect(approvalCard).toContainText(actionName("introduction.relationship_sensitive"));
  const effects = (await (await request.get("/api/effects/requests", { headers: MP })).json()) as { effect_requests: unknown[] };
  expect(effects.effect_requests).toHaveLength(0);

  // Alert volume is observable, with the quality caveat stated explicitly.
  const volume = (await (await request.get("/api/diagnostics/alert-volume", { headers: MP })).json()) as { note: string; by_day: unknown[] };
  expect(volume.note).toContain("UNPROVEN");
  expect(volume.by_day.length).toBeGreaterThan(0);
});
