import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P10 browser journey against local `wrangler dev`:
 * dev-header login as Scooter (MP) → record an LP → draft an LP-facing claim →
 * submit it with NO evidence (refused: unsubstantiated_claim) → build a VERIFIED
 * diligence claim on a company and link it → submit (creates the reserved
 * marketing-claim card) → publish with no receipt (refused: approval_required) →
 * approve the card in Approvals → publish with the receipt → register a data-room
 * artifact carrying the published claim → grant recorded access → revoke it.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials. The data
 * room itself stays EXTERNAL — nothing here proves a VDR provider (none selected).
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P10 LP journey: evidence gate → compliance receipt → publish → recorded share → revocation", async ({ page, request }) => {
  const marker = `E2E-P10-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // A VERIFIED diligence claim is the only thing that can substantiate LP language,
  // and only a human can put a claim into that state.
  await page.getByRole("button", { name: "Companies", exact: true }).click();
  await page.getByTestId("company-create-name").fill(`${marker} Co`);
  await page.getByTestId("company-create-submit").click();
  await page.locator('button[data-testid^="company-open-"]', { hasText: `${marker} Co` }).click();
  await page.getByTestId("claim-text").fill(`${marker}: Fund I DPI is 0.4x as of 2026-03-31`);
  await page.getByTestId("claim-source-location").fill("administrator statement 2026-03-31");
  await page.getByTestId("claim-submit").click();
  await expect(page.getByTestId("claim-message")).toContainText("UNVERIFIED");
  await page.locator('button[data-testid^="claim-verify-"]').first().click();
  await expect(page.getByTestId("claim-message")).toContainText("VERIFIED");

  // LP surface: the room is external and labelled as such.
  await page.getByRole("button", { name: "LP", exact: true }).click();
  await expect(page.getByTestId("vdr-state")).toContainText("UNPROVEN");
  await expect(page.getByTestId("vdr-state")).toContainText("PROVIDER NOT SELECTED");

  await page.getByTestId("lp-record-name").fill(`${marker} Family Office`);
  await page.getByTestId("lp-record-submit").click();
  await expect(page.getByTestId("lp-message")).toContainText("LP record ok");

  // Draft the LP-facing claim, then try to submit it with nothing behind it.
  await page.getByTestId("lp-claim-text").fill(`${marker}: Fund I DPI is 0.4x`);
  await page.getByTestId("lp-claim-submit").click();
  await expect(page.getByTestId("lp-message")).toContainText("LP claim draft ok");
  await page.getByTestId("lp-claim-submit-review").click();
  await expect(page.getByTestId("lp-message")).toContainText("unsubstantiated_claim");

  // Link the VERIFIED evidence; now the claim may go to a reviewer.
  await page.getByTestId("lp-evidence-select").selectOption({ label: `${marker}: Fund I DPI is 0.4x as of 2026-03-31`.slice(0, 48) });
  await page.getByTestId("lp-evidence-link").click();
  await expect(page.getByTestId("lp-message")).toContainText("Evidence link ok");
  await page.getByTestId("lp-claim-submit-review").click();
  await expect(page.getByTestId("lp-message")).toContainText("Submit for review ok");
  const cardId = await page.getByTestId("lp-publish-receipt").inputValue();
  expect(cardId).toMatch(/^apc_/);

  // Approved evidence is NOT enough: publication also needs the reserved receipt.
  const receiptField = page.getByTestId("lp-publish-receipt");
  await receiptField.fill("");
  await page.getByTestId("lp-claim-publish").click();
  await expect(page.getByTestId("lp-message")).toContainText("approval_required");

  // Approve the marketing-claim card as the MP, then publish with the receipt.
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  const approvalCard = page.locator(`li[data-testid="approval-card-${cardId}"]`);
  await expect(approvalCard).toContainText("pending_review");
  // Targeted by testid, not by role: an approval card now also carries evidence and comment
  // inputs (canon §24.2 context), so "the textbox" is ambiguous.
  await approvalCard.locator('[data-testid^="decision-note-"]').fill("reviewed against the administrator statement — E2E");
  await approvalCard.getByRole("button", { name: "Approve" }).click();
  await expect
    .poll(async () => (await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()).state)
    .toBe("approved");

  await page.getByRole("button", { name: "LP", exact: true }).click();
  await page.getByTestId("lp-claim-select").selectOption({ index: 1 });
  await receiptField.fill(cardId);
  await page.getByTestId("lp-claim-publish").click();
  await expect(page.getByTestId("lp-message")).toContainText("Publish ok");
  await expect(page.locator('code[data-testid^="lp-claim-status-"]').first()).toContainText("PUBLISHED");

  // Only PUBLISHED language may ride along on shared material.
  await page.getByTestId("artifact-title").fill(`${marker} LP Deck`);
  await page.getByTestId("artifact-create").click();
  await expect(page.getByTestId("lp-message")).toContainText("Artifact ok");

  // Sharing is human-gated: no receipt, no grant.
  const artifact = page.locator('li[data-testid^="artifact-"]', { hasText: `${marker} LP Deck` }).first();
  const artifactId = (await artifact.getAttribute("data-testid"))!.replace("artifact-", "");
  await page.getByTestId(`grant-access-${artifactId}`).click();
  await expect(page.getByTestId("lp-message")).toContainText("approval_required");

  const sendCard = await (
    await request.post("/api/approvals", {
      headers: MP,
      data: {
        action_key: "lp_sensitive_communication.send",
        object_type: "data_room_artifact",
        object_id: artifactId,
        title: `${marker} share deck`,
        submit: true,
      },
    })
  ).json();
  expect((await request.post(`/api/approvals/${sendCard.id}/decide`, { headers: MP, data: { decision: "approved" } })).status()).toBe(200);

  await page.reload();
  await page.getByRole("button", { name: "LP", exact: true }).click();
  await page.getByTestId(`grant-recipient-${artifactId}`).fill(`cio-${marker}@example.com`);
  await page.getByTestId(`grant-receipt-${artifactId}`).fill(sendCard.id);
  await page.getByTestId(`grant-access-${artifactId}`).click();
  await expect(page.getByTestId("lp-message")).toContainText("Access grant ok");

  // The ledger records the version, permission, and expiry; revocation is a new row.
  const grant = page.locator('li[data-testid^="access-"]', { hasText: `cio-${marker}@example.com` }).first();
  await expect(grant).toContainText("VIEW");
  await expect(grant).toContainText("ACTIVE");
  const accessId = (await grant.getAttribute("data-testid"))!.replace("access-", "");
  await page.getByTestId(`access-revoke-${accessId}`).click();
  await expect(page.getByTestId("lp-message")).toContainText("Revocation ok");
  await expect(page.getByTestId(`access-status-${accessId}`)).toContainText("REVOKED");

  // Nothing was actually sent anywhere: any real send is still a P3 external effect.
  const effects = await (await request.get("/api/effects/requests", { headers: MP })).json();
  expect((effects.effect_requests ?? []).filter((r: { state: string }) => r.state === "EXECUTED")).toHaveLength(0);

  // The one spine carries the typed LP events.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-lp.claim_published"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-lp.data_room_access_revoked"]').first()).toBeVisible();
});
