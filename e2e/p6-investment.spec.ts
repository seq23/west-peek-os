import { expect, test } from "@playwright/test";

/**
 * P6 browser journey against local `wrangler dev`:
 * login as Scooter (MP) → create a company → create an opportunity → deal math
 * packet (manual) → calculate with the verified formulas → open a material
 * contradiction on the same company → assemble the IC packet → the unresolved
 * contradiction is visible ON the packet → APPROVE without a receipt is refused →
 * submit → MP approves the card → APPROVE recorded with the receipt → Activity
 * shows the typed IC events, and Company 360 shows the one canonical identity.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P6 investment journey: opportunity → deal math → IC packet → receipted decision", async ({ page, request }) => {
  const marker = `E2E-P6-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // Company creation (one canonical identity behind every investment view).
  await page.getByRole("button", { name: "Companies", exact: true }).click();
  await page.getByTestId("company-create-name").fill(`${marker} Co`);
  await page.getByTestId("company-create-submit").click();
  await expect(page.getByTestId("company-message")).toContainText("Created");

  // Two conflicting sourced claims → a material contradiction the IC must see.
  await page.locator('button[data-testid^="company-open-"]', { hasText: `${marker} Co` }).click();
  await expect(page.getByTestId("company-detail")).toBeVisible();
  for (const value of ["$4M", "$6M"]) {
    await page.getByTestId("claim-text").fill(`${marker}: ARR is ${value}`);
    await page.getByTestId("claim-metric-key").fill("arr");
    await page.getByTestId("claim-metric-value").fill(value);
    await page.getByTestId("claim-submit").click();
    await expect(page.getByTestId("claim-message")).toContainText("UNVERIFIED");
  }
  await page.getByTestId("detect-contradictions").click();
  await page.getByTestId("open-contradiction-0").click();
  await expect(page.getByTestId("claim-message")).toContainText("Contradiction ctr_");

  // Investment surface: create the opportunity on that same canonical company.
  await page.getByRole("button", { name: "Investment", exact: true }).click();
  await page.getByTestId("opportunity-company").selectOption({ label: `${marker} Co` });
  await page.getByTestId("opportunity-type").selectOption("EARLY_STAGE_PRIMARY");
  await page.getByTestId("opportunity-title").fill(`${marker} seed round`);
  await page.getByTestId("opportunity-create-submit").click();
  await expect(page.getByTestId("investment-message")).toContainText("created (NEW)");

  await page.locator('button[data-testid^="opportunity-open-"]', { hasText: `${marker} seed round` }).click();
  await expect(page.getByTestId("opportunity-detail")).toBeVisible();

  // Deal math: manual packet first (D6), then the verified-formula calculation.
  await page.getByTestId("deal-math-create").click();
  await expect(page.getByTestId("deal-math-entry-mode")).toHaveText("MANUAL");
  await page.getByTestId("deal-math-calculate").click();
  await expect(page.getByTestId("deal-math-entry-mode")).toHaveText("CALCULATED");
  // TVPI has no verified formula and is never machine-filled.
  await expect(page.getByTestId("deal-math-packet")).toContainText("TVPI — (manual only)");

  // IC packet: the unresolved material contradiction is visible on the packet.
  await page.getByTestId("ic-assemble").click();
  await expect(page.getByTestId("investment-message")).toContainText("IC packet icp_");
  await expect(page.getByTestId("ic-unresolved-contradictions")).toContainText("Unresolved material contradictions: 1");

  // APPROVE without a receipt is refused — an IC approval always needs one.
  await page.getByTestId("ic-rationale").fill("conviction on team");
  await page.getByTestId("ic-approve").click();
  await expect(page.getByTestId("ic-message")).toContainText("Decision refused: approval_required");

  // Submit → an MP approval card is created; approve it in the Approvals surface.
  await page.getByTestId("ic-submit").click();
  await expect(page.getByTestId("ic-message")).toContainText("approval card apc_");
  const submitMessage = (await page.getByTestId("ic-message").textContent()) ?? "";
  const cardId = /apc_[0-9a-f-]+/.exec(submitMessage)?.[0];
  expect(cardId).toBeTruthy();

  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("investment.approve");
  await page.getByTestId(`decision-note-${cardId}`).fill("IC approved at committee");
  await page.getByTestId(`approve-${cardId}`).click();
  await page.getByTestId("approval-filter").selectOption("approved");
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("approved");

  // Record the decision with the receipt (via the API surface the UI posts to).
  const decideRes = await request.post(`/api/ic/packets/${await icPacketIdFor(request, `${marker} seed round`)}/decide`, {
    headers: MP,
    data: { decision: "APPROVE", rationale: "conviction on team", receipt_id: cardId },
  });
  expect(decideRes.status()).toBe(201);

  // The receipt is consumed: a replay is refused.
  const replay = await request.post(`/api/ic/packets/${await icPacketIdFor(request, `${marker} seed round`)}/decide`, {
    headers: MP,
    data: { decision: "APPROVE", receipt_id: cardId },
  });
  expect(replay.status()).toBe(409);

  // Activity spine carries the typed IC events.
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByTestId("activity-event-ic.packet_assembled").first()).toBeVisible();
  await expect(page.getByTestId("activity-event-ic.packet_submitted").first()).toBeVisible();
  await expect(page.getByTestId("activity-event-ic.decision_recorded").first()).toBeVisible();

  // Company 360 resolves the opportunity and IC packet through the ONE identity.
  const companies = (await (await request.get("/api/companies", { headers: MP })).json()) as {
    companies: Array<{ id: string; canonical_name: string }>;
  };
  const company = companies.companies.find((c) => c.canonical_name === `${marker} Co`)!;
  const view = (await (await request.get(`/api/companies/${company.id}/360`, { headers: MP })).json()) as {
    opportunities: unknown[];
    ic_packets: unknown[];
    deal_math_packets: unknown[];
  };
  expect(view.opportunities).toHaveLength(1);
  expect(view.ic_packets).toHaveLength(1);
  expect(view.deal_math_packets).toHaveLength(1);
});

/** Resolve the IC packet id for an opportunity by title (API, MP identity). */
async function icPacketIdFor(request: import("@playwright/test").APIRequestContext, opportunityTitle: string): Promise<string> {
  const opportunities = (await (await request.get("/api/opportunities", { headers: MP })).json()) as {
    opportunities: Array<{ id: string; title: string }>;
  };
  const opportunity = opportunities.opportunities.find((o) => o.title === opportunityTitle)!;
  const packets = (await (await request.get(`/api/ic/packets?opportunity_id=${opportunity.id}`, { headers: MP })).json()) as {
    ic_packets: Array<{ id: string }>;
  };
  return packets.ic_packets[0]!.id;
}
