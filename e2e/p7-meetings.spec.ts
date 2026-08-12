import { expect, test } from "@playwright/test";

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
  await expect(page.getByTestId("meetings-message")).toContainText("recorded");
  await page.locator('button[data-testid^="meeting-open-"]', { hasText: `${marker} founder call` }).click();
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await expect(page.getByTestId("meeting-recording")).toHaveText("NOT ACTIVATED");
  await expect(page.getByTestId("meeting-consent")).toHaveText("NOT RECORDED");

  // Gate 1: no recording policy → refused, and the refusal is recorded.
  await page.getByTestId("transcript-import").click();
  await expect(page.getByTestId("meeting-message")).toContainText("Transcript import refused: recording_policy_not_activated");
  await expect(page.getByTestId("transcript-list")).toContainText("REFUSED");

  // Consent alone is not enough — the recording policy is a separate gate.
  await page.getByTestId("consent-grant").click();
  await expect(page.getByTestId("meeting-consent")).toHaveText("GRANTED");
  await page.getByTestId("transcript-import").click();
  await expect(page.getByTestId("meeting-message")).toContainText("Transcript import refused: recording_policy_not_activated");

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
  await expect(page.getByTestId(`approval-card-${cardId}`)).toContainText("approved");

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

  await page.getByRole("button", { name: "Work Cards", exact: true }).click();
  await expect(page.getByTestId("work-card-list")).toContainText(`${marker}: send the diligence question list`);

  // Revoking consent re-closes the gate for any further import.
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.locator('button[data-testid^="meeting-open-"]', { hasText: `${marker} founder call` }).click();
  await page.getByTestId("consent-revoke").click();
  await expect(page.getByTestId("meeting-consent")).toHaveText("REVOKED");
  await page.getByTestId("transcript-import").click();
  await expect(page.getByTestId("meeting-message")).toContainText("Transcript import refused: consent_not_granted");
});
