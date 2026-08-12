import { expect, test } from "@playwright/test";

/**
 * P11 browser journey against local `wrangler dev`:
 * dev-header login as Scooter (MP) → open a scenario that PINS the current mandate,
 * sleeve, reserve, and concentration policy versions → state an assumption → add a
 * follow-on option that breaches the pinned concentration limit → run the cross-sleeve
 * comparison → the breach is visible and named → recording APPROVED is refused with no
 * receipt → request the reserved approval → approve it in Approvals → record the
 * decision with the receipt → the option reads APPROVED and the spine carries the
 * typed allocation events.
 *
 * Runs fully offline: local D1 (miniflare), no credentials. Nothing here claims
 * valuation correctness or investment soundness; live allocation use remains gated on
 * the operator accepting docs/ALLOCATION_VERIFICATION.md.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P11 allocation journey: pinned policy versions → visible breach → receipted human decision", async ({ page, request }) => {
  const marker = `E2E-P11-${Date.now()}`;

  // A fund with all four policy versions — the substrate a scenario pins.
  const fund = await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json();
  for (const [kind, policy] of [
    ["mandate", { stages: ["seed"], excluded_sectors: ["tobacco"] }],
    ["sleeve", { sleeves: [{ key: "early", target_pct: 60 }] }],
    ["reserve", { reserve_pct: 40 }],
    ["concentration", { max_single_company_pct: 10 }],
  ] as const) {
    const res = await request.post(`/api/funds/${fund.id}/policies/${kind}`, {
      headers: MP,
      data: { version_no: 1, effective_from: "2026-01-01", policy },
    });
    expect(res.status(), kind).toBe(201);
  }

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await page.getByRole("button", { name: "Allocation", exact: true }).click();
  await page.getByTestId("scenario-fund").selectOption({ label: `${marker} Fund` });
  await page.getByTestId("scenario-name").fill(`${marker} construction`);
  await page.getByTestId("scenario-create").click();
  await expect(page.getByTestId("allocation-message")).toContainText("Scenario ok");

  // The scenario shows exactly what it was computed against, and says what it is not.
  await expect(page.getByTestId("scenario-pins")).toContainText("wpos-allocation-1.0.0");
  await expect(page.getByTestId("scenario-outcome-label")).toContainText("NOT AN EXPECTED RETURN");

  await page.getByTestId("assumption-add").click();
  await expect(page.getByTestId("assumption-list")).toContainText("not an observed rate");

  // A follow-on that takes the position to 12% against the pinned 10% limit.
  await page.getByTestId("option-type").selectOption("FOLLOW_ON");
  await page.getByTestId("option-label").fill(`${marker} follow-on`);
  await page.getByTestId("option-capital").fill("2100000");
  await page.getByTestId("option-existing-cost").fill("1500000");
  await page.getByTestId("option-create").click();
  await expect(page.getByTestId("allocation-message")).toContainText("Option ok");

  await page.getByTestId("run-comparison").click();
  await expect(page.getByTestId("allocation-message")).toContainText("Comparison ok");
  await expect(page.getByTestId("violation-CONCENTRATION_LIMIT")).toContainText("BREACH");
  await expect(page.getByTestId("violation-CONCENTRATION_LIMIT")).toContainText("12.0000%");

  // A visible breach does not block the decision — it informs it. What blocks the
  // decision is the missing receipt.
  const option = page.locator('li[data-testid^="option-"]', { hasText: `${marker} follow-on` }).first();
  const optionId = (await option.getAttribute("data-testid"))!.replace("option-", "");
  await page.getByTestId(`option-approve-${optionId}`).click();
  await expect(page.getByTestId("allocation-message")).toContainText("approval_required");

  await page.getByTestId(`option-request-${optionId}`).click();
  await expect(page.getByTestId("allocation-message")).toContainText("Approval request ok");
  const cardId = await page.getByTestId("option-receipt").inputValue();
  expect(cardId).toMatch(/^apc_/);

  // Approve the follow-on card as the MP in the Approvals surface.
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  const card = page.locator(`li[data-testid="approval-card-${cardId}"]`);
  await expect(card).toContainText("pending_review");
  await card.getByRole("textbox").fill("pro-rata only; concentration breach accepted knowingly — E2E");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect
    .poll(async () => (await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()).state)
    .toBe("approved");

  // Back in Allocation, present the receipt and record the human decision.
  await page.getByRole("button", { name: "Allocation", exact: true }).click();
  await page.getByTestId("scenario-select").selectOption({ label: `${marker} construction (COMPARED)` });
  await page.getByTestId("option-receipt").fill(cardId);
  await page.getByTestId(`option-approve-${optionId}`).click();
  await expect(page.getByTestId("allocation-message")).toContainText("Decision ok");
  await expect(page.getByTestId(`option-decision-${optionId}`)).toContainText("APPROVED");

  // Recording a decision is not moving money: no external effect was created.
  const effects = await (await request.get("/api/effects/requests", { headers: MP })).json();
  expect((effects.effect_requests ?? []).filter((r: { state: string }) => r.state === "EXECUTED")).toHaveLength(0);

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.locator('[data-testid="activity-event-allocation.option_decided"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-allocation.comparison_run"]').first()).toBeVisible();
});
