import { expect, test } from "@playwright/test";
import { gotoSurface, openDisclosure } from "./support/nav";

/**
 * P6 browser journey against local `wrangler dev`:
 * login as Scooter (MP) → create a company → open a deal on it at the committee stage →
 * the deal record's arithmetic (manual, then recomputed with the verified formulas) →
 * a material contradiction on the same company → the committee packet on Meetings →
 * APPROVE without a receipt is refused → put it in front of the partners → MP approves
 * the card → APPROVE recorded with the receipt → the receipt cannot be replayed →
 * Activity shows the typed IC events, and Company 360 shows the one canonical identity.
 *
 * ── REWRITTEN 22 Aug 2026, because the surfaces underneath it moved ─────────────────────────────
 *
 * This spec drove a nav destination called "Investment" that no longer exists. The pipeline and the
 * deal record became ONE component on **Dealflow** (`DealflowPage.tsx` / `CompanyDealRecord`) —
 * App.tsx: "picking a company on the pipeline did not open its record; it scrolled you to a
 * dropdown where you picked the same company again" — and the committee moved to **Meetings** under
 * ADR-019, where a packet opens by itself the moment a deal reaches the committee stage. Every
 * governed property this journey existed to prove is still proved; only the addresses changed.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

/** Seven numbers, all typed by a person — the record refuses to compute on a blank. */
const MATH_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ["deal-math-check-size", "1000000"],
  ["deal-math-round-size", "5000000"],
  ["deal-math-pre-money", "20000000"],
  ["deal-math-exit-value", "300000000"],
  ["deal-math-future-dilution-pct", "30"],
  ["deal-math-hold-years", "7"],
  ["deal-math-fund-size", "50000000"],
];

test("P6 investment journey: deal record → deal math → committee packet → receipted decision", async ({ page, request }) => {
  const marker = `E2E-P6-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  /*
   * Company creation, and where it lives now.
   *
   * The Companies route leads with the REGISTER, and the identity/evidence workbench — creating a
   * company, its claims, verification, contradictions — folded into the `company-identity`
   * disclosure underneath it. Everything inside a closed `<details>` is in the DOM and invisible,
   * which is why this step used to time out on `company-create-name` with "element is not visible":
   * the control was there the whole time, behind a shut lid.
   */
  await gotoSurface(page, "Companies");
  await openDisclosure(page, "company-identity");
  await page.getByTestId("company-create-name").fill(`${marker} Co`);
  await page.getByTestId("company-create-submit").click();
  await expect(page.getByTestId("company-message")).toContainText("Created");

  // Two conflicting sourced claims → a material contradiction the committee must not lose.
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

  /*
   * THE DEAL, OPENED ON DEALFLOW AT THE STAGE IT IS ACTUALLY AT.
   *
   * "Starts at" exists precisely so a deal does not have to be walked forward one stage at a time
   * to be recorded honestly — DealflowPage: "Start it where it already is; everything arriving at
   * 'New' makes every clock lie." Opening it at IC_READY is also what makes the committee packet
   * appear on Meetings, which is the ADR-019 behaviour the second half of this journey depends on.
   */
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-add-toggle").click();
  await page.getByTestId("dealflow-company").selectOption({ label: `${marker} Co` });
  await page.getByTestId("dealflow-sleeve").selectOption("EARLY_STAGE_PRIMARY");
  await page.getByTestId("dealflow-stage").selectOption("IC_READY");
  await page.getByTestId("dealflow-add-submit").click();
  await expect(page.getByTestId("dealflow-message")).toContainText(`${marker} Co`);

  // The record opens from the pipeline itself — one company, one record, everything under it.
  await page.getByTestId("deal-record-company").selectOption({ label: `${marker} Co` });
  await expect(page.getByTestId("deal-record")).toBeVisible();
  await expect(page.getByTestId("deal-record-company-name")).toContainText(`${marker} Co`);

  // Deal math: typed by a person first (D6), then recomputed with the verified formulas only.
  for (const [testId, value] of MATH_INPUTS) await page.getByTestId(testId).fill(value);
  await page.getByTestId("deal-math-create").click();
  await expect(page.getByTestId("deal-math-entry-mode")).toContainText("manual entry");
  await page.getByTestId("deal-math-calculate").click();
  await expect(page.getByTestId("deal-math-entry-mode")).toContainText("recomputed");
  // TVPI has no hand-verified formula and is therefore never machine-filled.
  await expect(page.getByTestId("deal-math-packet")).toContainText("no verified formula");

  /*
   * IT ACTUALLY REACHED THE COMMITTEE, and this is asserted before the browser is asked to show it.
   *
   * "Starts at" walks the deal up one stage at a time, and the form reports a partial walk in the
   * same message as a complete one ("Added, but could not set it to Investment Committee"). Without
   * this line a stalled walk surfaced twenty lines later as "the committee packet is not on the
   * page", which reads as a broken surface rather than as a deal that never got there.
   */
  const opportunityId = await opportunityIdFor(request, `${marker} Co`);
  const opp = (await (await request.get(`/api/opportunities/${opportunityId}`, { headers: MP })).json()) as {
    status?: string;
    opportunity?: { status: string };
  };
  expect(
    opp.status ?? opp.opportunity?.status,
    "the deal must be at the committee stage — that stage move is what opens the packet (ADR-019)",
  ).toBe("IC_READY");

  // The committee. A packet opened by itself when the deal reached the committee stage (ADR-019).
  await gotoSurface(page, "Meetings");
  const icDeal = page.getByTestId(`ic-deal-${opportunityId}`);
  await expect(icDeal).toBeVisible();
  await expect(icDeal).toContainText(`${marker} Co`);

  /*
   * THE UNRESOLVED MATERIAL CONTRADICTION IS ON THE PACKET.
   *
   * Asserted through the packet itself rather than through a line on the page: the committee
   * surface was rebuilt around "the four things a committee needs" and no longer prints the
   * contradiction count, but the packet is what a decision is made against and it still carries it.
   * If that ever stops being true, a partner can approve an investment over an open disagreement
   * about the company's own revenue and nothing anywhere would say so — which is the single
   * property this half of the journey exists for.
   */
  const packetId = await icPacketIdFor(request, opportunityId);
  const packet = (await (await request.get(`/api/ic/packets/${packetId}`, { headers: MP })).json()) as {
    unresolved_material_contradictions_current: Array<{ materiality: string; required_question: string }>;
  };
  expect(
    packet.unresolved_material_contradictions_current,
    "the open ARR contradiction must reach the packet the committee decides against",
  ).toHaveLength(1);
  expect(packet.unresolved_material_contradictions_current[0]!.materiality).toBe("HIGH");
  // Both figures are named in the question, in whichever order the detector found them.
  expect(packet.unresolved_material_contradictions_current[0]!.required_question).toContain("$4M");
  expect(packet.unresolved_material_contradictions_current[0]!.required_question).toContain("$6M");

  // Put it in front of the partners → an MP approval card; approve it in the Approvals surface.
  await page.getByTestId(`ic-submit-${opportunityId}`).click();

  /*
   * APPROVE WITHOUT A RECEIPT IS REFUSED — and it is tried HERE, after submission, on purpose.
   *
   * A draft packet refuses a decision for a different reason (409: it has not been put to anybody
   * yet), so attempting it before submitting would pass for the wrong reason and would stop
   * proving the thing this line exists for: that a SUBMITTED packet, ready to be decided, still
   * cannot be approved without the reserved receipt behind it.
   */
  const noReceipt = await request.post(`/api/ic/packets/${packetId}/decide`, {
    headers: MP,
    data: { decision: "APPROVE", rationale: "conviction on team" },
  });
  // 409 rather than 403: the refusal is the governance state of the packet, not the identity of the
  // caller — this Managing Partner may decide, and the decision still cannot be recorded until a
  // reserved receipt exists. The reason is named in the body rather than left to the status code.
  expect(noReceipt.status(), await noReceipt.text()).toBe(409);
  expect(await noReceipt.text()).toContain("reserved_action_requires_approval");

  /*
   * Found by the PACKET it was raised about, not by "the first investment.approve in the queue".
   * Every spec in this suite drives the same local D1 (one Playwright worker, one database), so a
   * card matched by action key alone would eventually be another journey's.
   */
  const cardFor = async (): Promise<string | null> => {
    const body = (await (await request.get("/api/approvals?state=pending_review", { headers: MP })).json()) as {
      approvals: Array<{ id: string; action_key: string; object_id: string }>;
    };
    return body.approvals.find((a) => a.action_key === "investment.approve" && a.object_id === packetId)?.id ?? null;
  };
  await expect
    .poll(cardFor, { message: "submitting the packet must raise the reserved investment.approve card for THIS packet" })
    .not.toBeNull();
  const cardId = (await cardFor())!;

  await gotoSurface(page, "Approvals");
  await expect(page.getByTestId(`approval-card-${cardId}`)).toBeVisible();
  await page.getByTestId(`decision-note-${cardId}`).fill("IC approved at committee");
  await page.getByTestId(`approve-${cardId}`).click();
  await page.getByTestId("approval-filter").selectOption("approved");
  // The badge reads "Approved" now: a decided card is collapsed and its state is the badge, not
  // a raw enum printed twice on the same screen.
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("Approved");

  // Record the decision with the receipt (via the API surface the committee page posts to).
  const decideRes = await request.post(`/api/ic/packets/${packetId}/decide`, {
    headers: MP,
    data: { decision: "APPROVE", rationale: "conviction on team", receipt_id: cardId },
  });
  expect(decideRes.status(), await decideRes.text()).toBe(201);

  // The receipt is consumed: a replay is refused.
  const replay = await request.post(`/api/ic/packets/${packetId}/decide`, {
    headers: MP,
    data: { decision: "APPROVE", receipt_id: cardId },
  });
  expect(replay.status()).toBe(409);

  // Activity spine carries the typed IC events.
  await gotoSurface(page, "Activity");
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

/** The opportunity opened on a company, by the company's canonical name (API, MP identity). */
async function opportunityIdFor(request: import("@playwright/test").APIRequestContext, companyName: string): Promise<string> {
  const companies = (await (await request.get("/api/companies", { headers: MP })).json()) as {
    companies: Array<{ id: string; canonical_name: string }>;
  };
  const company = companies.companies.find((c) => c.canonical_name === companyName)!;
  const opportunities = (await (await request.get("/api/opportunities", { headers: MP })).json()) as {
    opportunities: Array<{ id: string; company_id: string }>;
  };
  return opportunities.opportunities.find((o) => o.company_id === company.id)!.id;
}

/** Resolve the IC packet id for an opportunity (API, MP identity). */
async function icPacketIdFor(request: import("@playwright/test").APIRequestContext, opportunityId: string): Promise<string> {
  const packets = (await (await request.get(`/api/ic/packets?opportunity_id=${opportunityId}`, { headers: MP })).json()) as {
    ic_packets: Array<{ id: string }>;
  };
  return packets.ic_packets[0]!.id;
}
