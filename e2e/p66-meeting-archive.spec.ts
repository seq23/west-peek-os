import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * A MEETING IS TAKEN OFF THE RECORD, AND WHAT IT PRODUCED SURVIVES.
 *
 * Operator, 22 Aug 2026: "the call with scooter meeting has no way to delete it. it was a test and
 * some meetings i want to delete….we need a way to delete them and we can have an audit trail if
 * someone deletes."
 *
 * The product's answer is deliberately NOT a delete, and the whole risk lives in that gap. A
 * meeting is referenced by its consent records, its transcript imports, its notes and — the
 * expensive one — every work card its close-out made out of a promise somebody made out loud. If
 * archiving quietly took those with it, the firm would lose committed work while believing it had
 * only tidied up a test row, and nothing on any surface would say so.
 *
 * So this journey is the pair: the meeting leaves the list WITH a reason attached to a name and a
 * time, and the work card it produced is still on the board afterwards. Neither half proves
 * anything alone — a meeting that vanishes with its work is a delete wearing an audit trail, and a
 * meeting that stays on the list is not archived at all.
 *
 * Runs fully offline: local D1 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("a meeting is taken off the record with a reason, and the work it produced stays on the board", async ({
  page,
  request,
}) => {
  const marker = `E2E-P66-${Date.now()}`;
  const promise = `${marker}: send the follow-up memo`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await gotoSurface(page, "Meetings");
  await page.getByTestId("meeting-title").fill(`${marker} founder call`);
  await page.getByTestId("meeting-create-submit").click();
  await expect(page.getByTestId("meetings-message")).toContainText("Recorded as mtg_");
  const meetingId = /mtg_[0-9a-f-]+/.exec((await page.getByTestId("meetings-message").textContent()) ?? "")?.[0];
  expect(meetingId, "the meeting id is needed to prove the archived row still resolves").toBeTruthy();

  // A promise made in the meeting, converted into work somebody carries.
  await page.getByTestId(`meeting-open-${meetingId}`).click();
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await page.getByTestId("commitment-text").fill(promise);
  await page.getByTestId("commitment-submit").click();
  await page.locator('button[data-testid^="commitment-convert-"]').first().click();
  await expect(page.getByTestId("commitment-list")).toContainText("CONVERTED");

  const workCard = page.locator('li[data-testid^="work-card-"]').filter({ hasText: promise }).first();
  await gotoSurface(page, "Work");
  await expect(workCard, "the promise must be on the board before anything is archived").toBeVisible();
  const cardId = (await workCard.getAttribute("data-testid"))!.replace("work-card-", "");

  /*
   * A REASON IS REQUIRED, and the control enforces it before the request is made.
   *
   * "Say why in a few words. Six months from now the reason is the only part of this that still
   * helps." The confirm button is disabled under three characters, so this asserts the DISABLED
   * control rather than a 400 — a refusal the operator never has to see is the better half of the
   * same rule, and if the button ever stops being disabled the API refusal below still holds.
   */
  await gotoSurface(page, "Meetings");
  await page.getByTestId(`archive-${meetingId}`).click();
  await expect(page.getByTestId(`archive-confirm-${meetingId}`)).toBeDisabled();
  // What stops being shown, and what stays, is said BEFORE the press rather than implied after it.
  await expect(page.getByTestId(`archive-keeps-${meetingId}`)).not.toBeEmpty();

  await page.getByTestId(`archive-reason-${meetingId}`).fill("it was a test");
  await expect(page.getByTestId(`archive-confirm-${meetingId}`)).toBeEnabled();
  await page.getByTestId(`archive-confirm-${meetingId}`).click();

  // It left the everyday list.
  await expect(page.getByTestId(`meeting-${meetingId}`)).toHaveCount(0);

  /*
   * AND IT IS STILL FINDABLE, with who took it off, when, and why.
   *
   * A removal nobody can see afterwards is indistinguishable from a deletion — which is the one
   * thing this deliberately is not. The reason is asserted as the operator's own words, because the
   * reason IS the property: an audit trail with the "why" missing answers nothing six months later.
   */
  await page.getByTestId("meetings-archived-toggle").click();
  const archived = page.getByTestId(`archived-${meetingId}`);
  await expect(archived).toBeVisible();
  await expect(archived).toContainText("it was a test");

  // THE WORK SURVIVED. This is the half that costs the firm something if it ever stops being true.
  await gotoSurface(page, "Work");
  await expect(
    page.getByTestId(`work-card-${cardId}`),
    "archiving a meeting must never take the work cards its commitments produced with it",
  ).toBeVisible();

  // The archived meeting row still resolves — the references from the card and the consent records
  // point at a row that is still there, rather than at a hole.
  const stillThere = await request.get(`/api/meetings/${meetingId}`, { headers: MP });
  expect(stillThere.status(), await stillThere.text()).toBe(200);
  const record = (await stillThere.json()) as { archive_reason?: string | null; archived_at?: string | null };
  expect(record.archived_at, "the archived row keeps its own record of when").toBeTruthy();
  expect(record.archive_reason).toContain("it was a test");

  // The spine carries it as a typed event, so this is auditable outside the page that did it.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-meeting.archived"]').first()).toBeVisible();
});

test("archiving refuses without a reason, and a second press is a no-op rather than an error", async ({ request }) => {
  const marker = `E2E-P66-API-${Date.now()}`;
  const created = await request.post("/api/meetings", {
    headers: MP,
    data: { title: `${marker} duplicate row`, meeting_type: "FOUNDER" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const meetingId = ((await created.json()) as { id: string }).id;

  // No reason at all.
  const bare = await request.post(`/api/meetings/${meetingId}/archive`, { headers: MP, data: {} });
  expect(bare.status(), await bare.text()).toBe(400);
  expect(await bare.text()).toContain("reason_required");

  // A reason too short to mean anything is the same refusal — the gate is a reason, not a keypress.
  const thin = await request.post(`/api/meetings/${meetingId}/archive`, { headers: MP, data: { reason: "x" } });
  expect(thin.status()).toBe(400);

  const first = await request.post(`/api/meetings/${meetingId}/archive`, {
    headers: MP,
    data: { reason: "entered twice by mistake" },
  });
  expect(first.status(), await first.text()).toBe(200);
  expect(((await first.json()) as { already_archived: boolean }).already_archived).toBe(false);

  /*
   * A SECOND PRESS SAYS "already off" RATHER THAN FAILING.
   *
   * "A second press is somebody who could not tell whether the first one worked; answering it with
   * an error teaches them the product is broken." Asserted as a 200 carrying `already_archived`,
   * not as a string, because the sentence is allowed to be reworded and the behaviour is not.
   */
  const second = await request.post(`/api/meetings/${meetingId}/archive`, {
    headers: MP,
    data: { reason: "entered twice by mistake" },
  });
  expect(second.status(), await second.text()).toBe(200);
  expect(((await second.json()) as { already_archived: boolean }).already_archived).toBe(true);

  // The first reason is the one kept. A second press must not overwrite the trail it just read.
  const record = (await (await request.get(`/api/meetings/${meetingId}`, { headers: MP })).json()) as {
    archive_reason: string;
  };
  expect(record.archive_reason).toBe("entered twice by mistake");
});
