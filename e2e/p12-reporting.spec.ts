import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P12 browser journey against local `wrangler dev`:
 * dev-header login as Scooter (MP) → open a reporting period and draft its packet →
 * distribution refused with reviews outstanding → record the finance, compliance, and
 * MP reviews → packet reads APPROVED but still does not ship → distribution refused
 * without the reserved send receipt → approve the card in Approvals → distribute →
 * then import an administrator export that disagrees with our NAV → the discrepancy
 * becomes a visible EXCEPTION showing BOTH figures → a human escalates it to the
 * administrator, and the administrator's reported value is unchanged.
 *
 * Runs fully offline: local D1 (miniflare), no credentials. The import is a FIXTURE:
 * no live administrator system is read, and none is ever written. Nothing here claims
 * accounting, valuation, or financial correctness.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P12 reporting journey: review gates → receipted distribution → reconciliation exception, no overwrite", async ({ page, request }) => {
  const marker = `E2E-P12-${Date.now()}`;

  const fund = await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json();

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await page.getByRole("button", { name: "Reporting", exact: true }).click();
  await expect(page.getByTestId("certification-state")).toContainText("NO FINANCIAL, ACCOUNTING, OR VALUATION CORRECTNESS IS CERTIFIED");

  await page.getByTestId("reporting-fund").selectOption({ label: `${marker} Fund` });
  await page.getByTestId("period-label").fill(`${marker} Q1`);
  await page.getByTestId("period-create").click();
  await expect(page.getByTestId("reporting-message")).toContainText("Packet ok");

  // Nothing ships before the reviews exist, let alone before they pass.
  await page.getByTestId("packet-distribute").click();
  await expect(page.getByTestId("reporting-message")).toContainText("reviews_incomplete");

  await page.getByTestId("packet-submit").click();
  await expect(page.getByTestId("packet-outstanding")).toContainText("FINANCE");
  await expect(page.getByTestId("review-FINANCE")).toContainText("PENDING");

  // Partial review is still not enough.
  await page.getByTestId("review-record-FINANCE").click();
  await expect(page.getByTestId("review-FINANCE")).toContainText("COMPLETED");
  await page.getByTestId("packet-distribute").click();
  await expect(page.getByTestId("reporting-message")).toContainText("reviews_incomplete");

  await page.getByTestId("review-record-COMPLIANCE").click();
  await page.getByTestId("review-record-MANAGING_PARTNER").click();
  await expect(page.getByTestId("packet-outstanding")).toContainText("none");
  await expect(page.getByTestId("packet-status")).toContainText("APPROVED");

  // Reviewed is not sent: the reserved LP-communication receipt is a separate gate.
  await page.getByTestId("packet-distribute").click();
  await expect(page.getByTestId("reporting-message")).toContainText("approval_required");

  const packetId = await page.getByTestId("packet-select").inputValue();
  const card = await (
    await request.post("/api/approvals", {
      headers: MP,
      data: {
        action_key: "lp_sensitive_communication.send",
        object_type: "lp_reporting_packet",
        object_id: packetId,
        title: `${marker} distribute packet`,
        submit: true,
      },
    })
  ).json();

  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  const approvalCard = page.locator(`li[data-testid="approval-card-${card.id}"]`);
  await expect(approvalCard).toContainText("pending_review");
  // Targeted by testid, not by role: an approval card now also carries evidence and comment
  // inputs (canon §24.2 context), so "the textbox" is ambiguous.
  await approvalCard.locator('[data-testid^="decision-note-"]').fill("reviewed by finance, compliance, and the MP — E2E");
  await approvalCard.getByRole("button", { name: "Approve" }).click();
  await expect
    .poll(async () => (await (await request.get(`/api/approvals/${card.id}`, { headers: MP })).json()).state)
    .toBe("approved");

  await page.getByRole("button", { name: "Reporting", exact: true }).click();
  await page.getByTestId("packet-select").selectOption(packetId);
  await page.getByTestId("distribute-receipt").fill(card.id);
  await page.getByTestId("packet-distribute").click();
  await expect(page.getByTestId("reporting-message")).toContainText("Distribution ok");
  await expect(page.getByTestId("packet-status")).toContainText("DISTRIBUTED");

  // Reconciliation: the administrator says one thing, our records say another.
  await expect(page.getByTestId("reconciliation-source-state")).toContainText("UNPROVEN");
  await expect(page.getByTestId("reconciliation-source-state")).toContainText("FUND-ADMIN SOURCE CONTRACT GATE");
  await page.getByTestId("reconciliation-fund").selectOption({ label: `${marker} Fund` });
  await page.getByTestId("admin-nav").fill("31500000");
  await page.getByTestId("internal-nav").fill("31000000");
  await page.getByTestId("reconciliation-run").click();
  await expect(page.getByTestId("reporting-message")).toContainText("Reconciliation ok");

  // The discrepancy is an exception showing BOTH figures — not a correction.
  const exception = page.locator('li[data-testid^="exception-"]').first();
  await expect(exception).toContainText("VALUE_MISMATCH");
  await expect(exception).toContainText("31500000");
  await expect(exception).toContainText("31000000");
  await expect(exception).toContainText("difference -500000");
  const exceptionId = (await exception.getAttribute("data-testid"))!.replace("exception-", "");

  await page.getByTestId(`exception-escalate-${exceptionId}`).click();
  await expect(page.getByTestId("reporting-message")).toContainText("Escalation ok");
  await expect(page.getByTestId(`exception-status-${exceptionId}`)).toContainText("ESCALATED");

  // The administrator's reported figure is exactly what they reported.
  const exceptions = await (await request.get("/api/reconciliation/exceptions", { headers: MP })).json();
  const stored = exceptions.exceptions.find((e: { id: string }) => e.id === exceptionId);
  expect(stored.administrator_value).toBe("31500000");
  expect(stored.internal_value).toBe("31000000");

  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-reporting.packet_distributed"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-reconciliation.exception_resolved"]').first()).toBeVisible();
});
