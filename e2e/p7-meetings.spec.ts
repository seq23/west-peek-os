import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P7 browser journey against local `wrangler dev`:
 * record a meeting → transcript import REFUSED (recording policy not activated,
 * refusal itself recorded) → record consent → still refused → activate the
 * recording policy through an approved MP receipt → import succeeds → manual note
 * → commitment → converted into a governed work card that appears in Work Cards.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P7 meeting journey: consent + recording gates, then commitment → work card", async ({ page, request }) => {
  const marker = `E2E-P7-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByTestId("meeting-title").fill(`${marker} founder call`);
  await page.getByTestId("meeting-create-submit").click();
  await expect(page.getByTestId("meetings-message")).toContainText("Recorded as mtg_");
  await page.locator('button[data-testid^="meeting-open-"]', { hasText: `${marker} founder call` }).click();
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await expect(page.getByTestId("meeting-recording")).toHaveText("NOT ACTIVATED");
  await expect(page.getByTestId("meeting-consent")).toHaveText("NOT RECORDED");

  // Gate 1: no recording policy → refused, and the refusal is recorded.
  await page.getByTestId("transcript-import").click();
  await expect(page.getByTestId("meeting-message")).toContainText("Transcript import refused: recording_policy_not_activated");
  await expect(page.getByTestId("transcript-list")).toContainText("REFUSED");

  /*
   * Consent alone is not enough — the recording policy is a separate gate.
   *
   * THE SECOND REFUSAL IS COUNTED, NOT JUST READ. Waiting on the refusal SENTENCE could not prove
   * anything here: the identical sentence was already on the page from the attempt above, so the
   * assertion was satisfied before the second import had even been answered and this gate would
   * have passed wide open. The record is what cannot be stale — a second attempt that was refused
   * leaves a second REFUSED row, and one that was allowed leaves an IMPORTED one.
   */
  await page.getByTestId("consent-grant").click();
  await expect(page.getByTestId("meeting-consent")).toHaveText("GRANTED");
  await page.getByTestId("transcript-import").click();
  await expect(page.getByTestId("meeting-message")).toContainText("Transcript import refused: recording_policy_not_activated");
  const refusals = page.locator('[data-testid^="transcript-"] .help-tag-warn', { hasText: "REFUSED" });
  await expect(refusals, "consent without a recording policy must be refused AND recorded, twice").toHaveCount(2);
  await expect(
    page.locator('[data-testid^="transcript-"]', { hasText: "IMPORTED" }),
    "nothing may have been imported while the recording policy is still off",
  ).toHaveCount(0);

  // Activate the recording policy through the MP-reserved approval receipt.
  const meetingId = /mtg_[0-9a-f-]+/.exec((await page.getByTestId("meetings-message").textContent()) ?? "")?.[0];
  expect(meetingId).toBeTruthy();
  const cardRes = await request.post("/api/approvals", {
    headers: MP,
    data: {
      action_key: "meeting.recording_policy.activate",
      object_type: "meeting",
      object_id: meetingId,
      title: `${marker} recording policy`,
      submit: true,
    },
  });
  expect(cardRes.status()).toBe(201);
  const cardId = ((await cardRes.json()) as { id: string }).id;

  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("meeting.recording_policy.activate");
  await page.getByTestId(`approve-${cardId}`).click();
  await page.getByTestId("approval-filter").selectOption("approved");
  // The badge reads "Approved" now: a decided card is collapsed and its state is the badge, not
  // a raw enum printed twice on the same screen.
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("Approved");

  const activated = await request.post(`/api/meetings/${meetingId}/recording-policy`, { headers: MP, data: { approval_receipt_id: cardId } });
  expect(activated.status()).toBe(200);

  // Both gates satisfied: the transcript imports.
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.locator('button[data-testid^="meeting-open-"]', { hasText: `${marker} founder call` }).click();
  await expect(page.getByTestId("meeting-recording")).toHaveText("ACTIVE");
  await page.getByTestId("transcript-import").click();
  await expect(page.getByTestId("meeting-message")).toContainText("Transcript import ok");
  await expect(page.getByTestId("transcript-list")).toContainText("IMPORTED");

  // Manual note + commitment → governed work card.
  await page.getByTestId("note-body").fill(`${marker}: founder walked through the hiring plan`);
  await page.getByTestId("note-submit").click();
  await expect(page.getByTestId("note-list")).toContainText("MANUAL");

  await page.getByTestId("commitment-text").fill(`${marker}: send the diligence question list`);
  await page.getByTestId("commitment-submit").click();
  await page.locator('button[data-testid^="commitment-convert-"]').first().click();
  await expect(page.getByTestId("commitment-list")).toContainText("CONVERTED");

  await gotoSurface(page, "Work");
  // The board is a list of card ROWS; there is no single list container to assert against, and the
  // row is the thing that has to exist. Same locator the P3 journey uses.
  const promised = page
    .locator('li[data-testid^="work-card-"]')
    .filter({ hasText: `${marker}: send the diligence question list` })
    .first();
  await expect(promised).toBeVisible();

  /*
   * ── AND THE WORK IT PRODUCED REACHES A PARTNER ────────────────────────────────────────────────
   *
   * The journey is not "a promise becomes a card"; it is "a promise made out loud in a room becomes
   * work somebody decides on". A card that appears on a board and is never put in front of anybody
   * is the same as a note in a notebook — which is what this whole meeting record exists to replace.
   *
   * Raised the way everything raises an approval, with the work card as its object, because there
   * is no work-card approval route and there deliberately is not one: an approval belongs to the
   * ACTION that needs it, and `object_type: "work_card"` is what ties the decision back to the
   * promise (ADR-018, and the same pattern `p3-governed-work.spec.ts` uses).
   */
  const promisedCardId = (await promised.getAttribute("data-testid"))!.replace("work-card-", "");
  const raised = await request.post("/api/approvals", {
    headers: MP,
    data: {
      action_key: "governance.policy_change",
      object_type: "work_card",
      object_id: promisedCardId,
      title: `${marker} act on what was promised`,
      summary: "Raised against the work card this meeting's commitment produced.",
      submit: true,
    },
  });
  expect(raised.status(), await raised.text()).toBe(201);
  const promiseCardId = ((await raised.json()) as { id: string }).id;

  await gotoSurface(page, "Approvals");
  const decision = page.getByTestId(`approval-card-${promiseCardId}`);
  await expect(decision).toBeVisible();
  await decision.getByTestId(`decision-note-${promiseCardId}`).fill(`${marker}: yes, send it today`);
  await decision.getByTestId(`approve-${promiseCardId}`).click();
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${promiseCardId}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("approved");

  // The decision is tied back to the promise, so "what came of what we said in that meeting" has an
  // answer that does not depend on anybody remembering the meeting.
  const decided = (await (await request.get(`/api/approvals/${promiseCardId}`, { headers: MP })).json()) as {
    object_type: string;
    object_id: string;
    decisions: Array<{ decision: string; note: string | null }>;
  };
  expect(decided.object_type).toBe("work_card");
  expect(decided.object_id).toBe(promisedCardId);
  expect(decided.decisions.map((d) => d.decision)).toEqual(["approved"]);

  // Revoking consent re-closes the gate for any further import.
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.locator('button[data-testid^="meeting-open-"]', { hasText: `${marker} founder call` }).click();
  await page.getByTestId("consent-revoke").click();
  await expect(page.getByTestId("meeting-consent")).toHaveText("REVOKED");
  await page.getByTestId("transcript-import").click();
  await expect(page.getByTestId("meeting-message")).toContainText("Transcript import refused: consent_not_granted");
});
