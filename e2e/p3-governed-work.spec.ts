import { expect, test } from "@playwright/test";
import { approvalStateWords } from "@shared/help/actionNames";
import { stateMeaning } from "@shared/work/workCards";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1 } from "./support/provision";

/**
 * P3 browser journey against local `wrangler dev`:
 * dev-header login → +Capture creates a capture → route to a work card →
 * request an approval-requiring action → approve in Approvals → Activity shows
 * the typed events including the approval decision. Plus: a second identity
 * without the required scope sees 401s / hidden restricted content.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "e2e-member@westpeek.ventures" };

test.beforeAll(() => {
  // A second identity WITHOUT the Managing Partner role or privacy scopes,
  // inserted into the same local D1 the dev server serves.
  provisionLocalD1(
    `INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_e2e_member', 'e2e-member@westpeek.ventures', 'E2E Member', 'ACTIVE'); INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_e2e_member', 'role_investment_team');`,
  );
});

test("governed work journey: capture → work card → approval → activity spine", async ({ page, request }) => {
  const marker = `E2E follow-up ${Date.now()}`;

  // Login (dev header, local mode).
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // +Capture creates a capture.
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await page.getByTestId("capture-text").fill(marker);
  await page.getByTestId("capture-submit").click();
  const captureResult = page.getByTestId("capture-result");
  await expect(captureResult).toBeVisible();
  /*
   * The capture is UNROUTED, and the page proves it by offering the routing form.
   *
   * This used to read `toContainText("NEW")` — the raw capture state, printed on the page. The
   * state vocabulary came off every surface in the plain-English pass, and asserting the enum was
   * always the weaker test anyway: `route-form` renders only while `status === "NEW"` (App.tsx), so
   * its presence is the same fact stated through the interface rather than through the database.
   */
  await expect(captureResult.getByTestId("route-form")).toBeVisible();

  // Route to a machine, creating a work card in the same step.
  await page.getByTestId("route-machine").selectOption({ label: "#21 Meeting Intelligence Machine" });
  await page.getByTestId("route-submit").click();
  await expect(page.getByTestId("route-result")).toContainText("machine #21");
  await expect(page.getByTestId("route-result")).toContainText("work card was opened");

  // Work Cards: the new card is listed OPEN; request an approval-requiring action.
  // The rail says "Work" now — Work cards and the scheduled machinery are one surface.
  await gotoSurface(page, "Work");
  const workCard = page.locator('li[data-testid^="work-card-"]').filter({ hasText: marker }).first();
  await expect(workCard).toBeVisible();
  // Same reasoning as the approval badge below: the state is read from the one module that decides
  // how a work-card state is spoken, so the assertion cannot be broken by a rewording.
  await expect(workCard).toContainText(stateMeaning("OPEN")!.label);

  /*
   * THE APPROVAL IS RAISED AGAINST THIS CARD, THROUGH THE ROUTE THE PRODUCT STILL HAS.
   *
   * This step used to press a "Request approval" button on the card. That control is gone — and so
   * is any route behind it: `src/worker/index.ts` exposes no work-card approval endpoint, and
   * `WorkCardsPage.tsx` offers assign / start / done / drop / look and nothing else. An approval is
   * now raised by the ACTION that needs one, with the work card as its object, which is also what
   * makes "approve, and don't ask again until this task is done" attachable (ADR-018).
   *
   * So the card is raised the way anything else raises one, and it is deliberately raised ABOUT the
   * work card the browser just watched appear — `object_type: "work_card"` is what puts
   * `work_card_id` on the row. The rest of the journey is unchanged and still runs in the browser:
   * the queue shows it, a partner decides it, and the spine records both.
   */
  const workCardId = (await workCard.getAttribute("data-testid"))!.replace("work-card-", "");
  const raised = await request.post("/api/approvals", {
    headers: MP,
    data: {
      action_key: "governance.policy_change",
      object_type: "work_card",
      object_id: workCardId,
      title: marker,
      summary: "Raised against the work card this journey just opened.",
      submit: true,
    },
  });
  expect(raised.status(), await raised.text()).toBe(201);

  // Approvals: the pending card is visible; approve it with a note.
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  const approvalCard = page.locator('li[data-testid^="approval-card-"]').filter({ hasText: marker }).first();
  await expect(approvalCard).toBeVisible();
  /*
   * The badge reads the STATE, in the firm's own words rather than the database's.
   *
   * Taken from `APPROVAL_STATE_WORDS` — the single place the product decides how a state is
   * spoken — instead of the string "pending_review", which is what this line said until the
   * vocabulary changed underneath it. Reading the label from the source means a future rewording
   * moves this assertion with it, and a state that stops being offered breaks the import.
   */
  await expect(approvalCard).toContainText(approvalStateWords("pending_review").label);
  const cardId = (await approvalCard.getAttribute("data-testid"))!.replace("approval-card-", "");
  // Targeted by testid, not by role: an approval card now also carries evidence and comment
  // inputs (canon §24.2 context), so "the textbox" is ambiguous.
  await approvalCard.locator('[data-testid^="decision-note-"]').fill("looks good — E2E");
  await approvalCard.getByRole("button", { name: "Approve" }).click();

  // The decision landed: card is approved, decision history recorded.
  await expect
    .poll(async () => {
      const res = await request.get(`/api/approvals/${cardId}`, { headers: MP });
      const body = await res.json();
      return body.state;
    })
    .toBe("approved");
  const detail = await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json();
  expect(detail.decisions.map((d: { decision: string }) => d.decision)).toEqual(["approved"]);
  expect(detail.decisions[0].note).toBe("looks good — E2E");

  // Activity shows the typed events, newest first, including the approval decision.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-approval.decided"]', { hasText: cardId })).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-approval.requested"]', { hasText: cardId })).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-work_card.created"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-capture.routed"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-capture.created"]').first()).toBeVisible();
});

test("second identity without roles/scope: 401 unauthenticated, restricted content hidden", async ({ request }) => {
  // No identity at all → 401 on the P3 surface.
  expect((await request.get("/api/captures")).status()).toBe(401);
  expect((await request.get("/api/approvals")).status()).toBe(401);
  expect((await request.get("/api/activity")).status()).toBe(401);

  // A valid firm user without the MP role or privacy scopes.
  const me = await request.get("/api/me", { headers: MEMBER });
  expect(me.status()).toBe(200);
  expect(((await me.json()) as { roles: string[] }).roles).toEqual(["INVESTMENT_TEAM"]);

  // MP plants a RESTRICTED capture.
  const created = await request.post("/api/captures", {
    headers: MP,
    data: { capture_type: "note", raw_text: `restricted e2e ${Date.now()}`, source_channel: "web", privacy_label: "RESTRICTED" },
  });
  expect(created.status()).toBe(201);
  const capture = (await created.json()) as { id: string };

  // The member cannot see it: absent from lists, 404 on direct read.
  const list = await (await request.get("/api/captures", { headers: MEMBER })).json();
  expect(list.captures.map((c: { id: string }) => c.id)).not.toContain(capture.id);
  expect((await request.get(`/api/captures/${capture.id}`, { headers: MEMBER })).status()).toBe(404);

  // …and cannot decide approvals (no required role).
  const card = await request.post("/api/approvals", {
    headers: MP,
    data: { action_key: "investment.approve", object_type: "canonical_company", object_id: "cc_e2e", title: "e2e role probe", submit: true },
  });
  const cardId = ((await card.json()) as { id: string }).id;
  const decide = await request.post(`/api/approvals/${cardId}/decide`, { headers: MEMBER, data: { decision: "approved" } });
  expect(decide.status()).toBe(403);
});
