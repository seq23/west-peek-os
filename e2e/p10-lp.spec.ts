import { expect, test } from "@playwright/test";
import { approvalStateWords } from "@shared/help/actionNames";
import { gotoSurface, openDisclosure } from "./support/nav";

/**
 * P10: what the firm may TELL an LP, and what it may HAND them.
 *
 * The gates, in order: a VERIFIED diligence claim is the only thing that can substantiate LP
 * language; a claim with nothing behind it is refused; publication needs the reserved receipt on top
 * of an approved review; sharing a data-room artifact needs its own receipt; and revocation is a new
 * row rather than an edit. Nothing is ever actually sent — a real send is still a P3 external effect,
 * and the data room stays EXTERNAL (no VDR provider is selected, and none is proven).
 *
 * ── WHY HALF OF THIS IS NOW DRIVEN THROUGH THE API ──────────────────────────────────────────────
 *
 * The LP surface was rebuilt around fundraising: commitments, the raise against target, reporting
 * periods, administrator reconciliation. The LP-CLAIM workbench and the DATA ROOM went with it —
 * `grep -rn "lp/claims\|data-room" src/client/` returns nothing — while every route behind them is
 * still mounted and still governed (`src/worker/index.ts` lines 1062–1074).
 *
 * That is worth saying plainly rather than quietly rewriting around: **the LP marketing-claim
 * evidence gate and the data-room access ledger have no interface.** A partner cannot draft an
 * LP-facing claim, see what it rests on, publish it, or read who currently holds access to material
 * the firm has shared. An access ledger nobody can read is an access ledger nobody will revoke. It
 * is asserted as its own expected-to-fail test at the bottom of this file.
 *
 * So this spec proves the GOVERNANCE — unchanged, and the reason those routes exist — through the
 * API, and proves in the browser what a partner can still reach: the evidence that substantiates the
 * claim, the LP surface itself, and the reserved approval that gates publication.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P10 LP journey: evidence gate → compliance receipt → publish → recorded share → revocation", async ({ page, request }) => {
  const marker = `E2E-P10-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  /*
   * A VERIFIED diligence claim is the only thing that can substantiate LP language, and only a human
   * can put a claim into that state. The evidence workbench folded into the `company-identity`
   * disclosure under the register — everything inside a closed `<details>` is in the DOM and
   * invisible, which is why this step used to time out on a control that was there the whole time.
   */
  await gotoSurface(page, "Companies");
  await openDisclosure(page, "company-identity");
  await page.getByTestId("company-create-name").fill(`${marker} Co`);
  await page.getByTestId("company-create-submit").click();
  await page.locator('button[data-testid^="company-open-"]', { hasText: `${marker} Co` }).click();
  await page.getByTestId("claim-text").fill(`${marker}: Fund I DPI is 0.4x as of 2026-03-31`);
  await page.getByTestId("claim-source-location").fill("administrator statement 2026-03-31");
  await page.getByTestId("claim-submit").click();
  await expect(page.getByTestId("claim-message")).toContainText("UNVERIFIED");
  await page.locator('button[data-testid^="claim-verify-"]').first().click();
  await expect(page.getByTestId("claim-message")).toContainText("VERIFIED");

  const claims = (await (await request.get("/api/claims", { headers: MP })).json()) as {
    claims: Array<{ id: string; claim_text: string; claim_status: string }>;
  };
  const evidence = claims.claims.find((c) => c.claim_text.startsWith(`${marker}:`))!;
  expect(evidence.claim_status).toBe("VERIFIED");

  // The LP surface a partner actually has: who the LPs are, and what the raise stands at.
  await gotoSurface(page, "LP");
  await expect(page.getByTestId("lp-page")).toBeVisible();
  await page.getByTestId("lp-name").fill(`${marker} Family Office`);
  await page.getByTestId("lp-add").click();
  await expect(page.getByTestId("lp-message")).toContainText(`${marker} Family Office`);

  // ── The evidence gate ─────────────────────────────────────────────────────────────────────────
  const draft = await request.post("/api/lp/claims", {
    headers: MP,
    data: { claim_text: `${marker}: Fund I DPI is 0.4x`, claim_type: "TRACK_RECORD", privacy_label: "LP_PRIVATE" },
  });
  expect(draft.status(), await draft.text()).toBe(201);
  const claimId = ((await draft.json()) as { id: string }).id;

  // Nothing behind it → refused. LP language may not outrun the evidence.
  const unsubstantiated = await request.post(`/api/lp/claims/${claimId}/submit`, { headers: MP, data: {} });
  expect(unsubstantiated.status()).toBe(409);
  expect(await unsubstantiated.text()).toContain("unsubstantiated_claim");

  // The VERIFIED diligence claim is what substantiates it — and the link says so in its answer.
  const linked = await request.post(`/api/lp/claims/${claimId}/evidence`, {
    headers: MP,
    data: { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: evidence.id },
  });
  expect(linked.status(), await linked.text()).toBe(201);
  expect((await linked.json()) as { approved: boolean; reason: string }).toMatchObject({ approved: true, reason: "verified" });

  const submitted = await request.post(`/api/lp/claims/${claimId}/submit`, { headers: MP, data: {} });
  expect(submitted.status(), await submitted.text()).toBe(200);
  const reviewCardId = ((await submitted.json()) as { claim: { approval_card_id: string } }).claim.approval_card_id;
  expect(reviewCardId).toMatch(/^apc_/);

  // Approved evidence is NOT enough: publication also needs the reserved receipt.
  const noReceipt = await request.post(`/api/lp/claims/${claimId}/publish`, { headers: MP, data: {} });
  expect(noReceipt.status()).toBe(409);
  expect(await noReceipt.text()).toContain("approval_required");

  // ── The reserved decision, made by a person, in the browser ───────────────────────────────────
  await gotoSurface(page, "Approvals");
  const approvalCard = page.getByTestId(`approval-card-${reviewCardId}`);
  await expect(approvalCard).toBeVisible();
  await expect(approvalCard).toContainText(approvalStateWords("pending_review").label);
  await approvalCard.getByTestId(`decision-note-${reviewCardId}`).fill("reviewed against the administrator statement — E2E");
  // By testid rather than by role name: a delegable card also carries "Approve, and don't ask
  // again…", so "the Approve button" is now two different acts (ADR-018).
  await approvalCard.getByTestId(`approve-${reviewCardId}`).click();
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${reviewCardId}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("approved");

  const published = await request.post(`/api/lp/claims/${claimId}/publish`, {
    headers: MP,
    data: { approval_receipt_id: reviewCardId },
  });
  expect(published.status(), await published.text()).toBe(200);
  expect(((await published.json()) as { status: string }).status).toBe("PUBLISHED");

  // ── The data room: sharing is human-gated, and revocation is a new row ────────────────────────
  const artifact = await request.post("/api/lp/data-room/artifacts", {
    headers: MP,
    data: { title: `${marker} LP Deck`, lp_claim_ids: [claimId], status: "READY" },
  });
  expect(artifact.status(), await artifact.text()).toBe(201);
  const created = (await artifact.json()) as { id: string; provider: string };
  // The room is EXTERNAL and labelled as such: this system records access, it never serves bytes.
  expect(created.provider).toBe("EXTERNAL_VDR_UNSELECTED");

  const ungranted = await request.post("/api/lp/data-room/access", {
    headers: MP,
    data: { artifact_id: created.id, recipient_label: `cio-${marker}@example.com`, permission: "VIEW" },
  });
  expect(ungranted.status()).not.toBe(201);
  expect(await ungranted.text()).toContain("approval_required");

  const sendCard = (await (
    await request.post("/api/approvals", {
      headers: MP,
      data: {
        action_key: "lp_sensitive_communication.send",
        object_type: "data_room_artifact",
        object_id: created.id,
        title: `${marker} share deck`,
        submit: true,
      },
    })
  ).json()) as { id: string };
  expect((await request.post(`/api/approvals/${sendCard.id}/decide`, { headers: MP, data: { decision: "approved" } })).status()).toBe(200);

  const granted = await request.post("/api/lp/data-room/access", {
    headers: MP,
    data: {
      artifact_id: created.id,
      recipient_label: `cio-${marker}@example.com`,
      permission: "VIEW",
      approval_receipt_id: sendCard.id,
    },
  });
  expect(granted.status(), await granted.text()).toBe(201);
  const accessId = ((await granted.json()) as { id: string }).id;

  // A reason is REQUIRED to revoke — a withdrawal of access with no reason on it is a row nobody
  // can interpret later, which is the same failure as a grant with no receipt.
  const revoked = await request.post(`/api/lp/data-room/access/${accessId}/revoke`, {
    headers: MP,
    data: { reason: "E2E: the diligence window closed" },
  });
  // 201: a revocation is a NEW row on the ledger, not an edit to the grant.
  expect(revoked.status(), await revoked.text()).toBe(201);
  // Revocation is a NEW state on the ledger, not the disappearance of the grant: who held what, and
  // until when, is the question the ledger exists to answer years later.
  const ledger = (await (await request.get("/api/lp/data-room/access", { headers: MP })).json()) as {
    access_records: Array<{ id: string; effective_status: string; revocation_reason: string | null; granted_at: string }>;
  };
  const row = ledger.access_records.find((g) => g.id === accessId);
  expect(row, "a revoked grant stays on the ledger").toBeTruthy();
  expect(row!.effective_status).toBe("REVOKED");
  // When it was granted, and why it was taken back — both kept. A revocation with no reason is a
  // row nobody can interpret later.
  expect(row!.granted_at).toBeTruthy();
  expect(row!.revocation_reason).toContain("diligence window");

  // Nothing was actually sent anywhere: any real send is still a P3 external effect.
  const effects = (await (await request.get("/api/effects/requests", { headers: MP })).json()) as {
    effect_requests?: Array<{ state: string }>;
  };
  expect((effects.effect_requests ?? []).filter((r) => r.state === "EXECUTED")).toHaveLength(0);

  // The one spine carries the typed LP events.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-lp.claim_published"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-lp.data_room_access_revoked"]').first()).toBeVisible();
});

/*
 * THE MISSING SURFACE, ASSERTED RATHER THAN ONLY MENTIONED.
 *
 * Every gate above is real and enforced, and a person can reach none of it: there is no control
 * anywhere in `src/client/` for drafting an LP-facing claim, linking what it rests on, publishing
 * it, or reading who currently holds access to shared material. The routes are live, so anything
 * with an API client can share LP-private material and nothing in the interface will show it.
 *
 * Left as the behaviour that should hold, marked expected-to-fail. Remove `test.fail()` when the LP
 * surface carries the access ledger again.
 */
test("a partner can see who currently holds access to LP material", async ({ page }) => {
  test.fail();
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "LP");
  await expect(page.getByTestId("lp-data-room")).toBeVisible();
});
