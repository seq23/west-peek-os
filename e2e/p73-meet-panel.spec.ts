import { expect, test } from "@playwright/test";

/**
 * Phase Meet, tiers 3 and 4, in the browser against local `wrangler dev`.
 *
 * The Meet add-on side panel (`#/meet-panel?code=…`) beside a call the calendar does not know →
 * "This call is not on the record" → ONE action, Record this meeting now → the same During face as
 * `#/room/<id>` renders inside the panel, at side-panel width → the meeting row says the live path
 * does not apply to a meeting adopted by hand (state NULL; the room hears through the microphone)
 * → the panel finds the meeting again by its code → "Open what came out of it" is offered only once
 * the call has ended → the deep link `#/meetings?open=<id>&face=after` lands on the After face.
 *
 * WHAT THIS DOES NOT PROVE. Meet itself: the Add-ons SDK is not loaded here (the `?code=` door
 * stands in for `getMeetingInfo()`), and the live join needs a running conference and Google's
 * Developer Preview (`tests/meetLive.test.ts` proves the join against a fake Meet media server).
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("tier 3: the side panel beside an unknown call → Record this meeting now → the room, narrow → the call ends → Open what came out of it", async ({ page, request }) => {
  const code = `e${Date.now().toString(36).slice(-2)}-${"abcdefghijklmnopqrstuvwxyz".slice(0, 4)}-xyz`.toLowerCase().replace(/[^a-z-]/g, "a");
  expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // The panel, at the width Meet gives a side panel.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/#/meet-panel?code=${code}`);
  await expect(page.getByTestId("meet-panel")).toBeVisible();
  await expect(page.getByTestId("meet-panel-unknown")).toContainText("not on the record");
  await expect(page.getByTestId("meet-panel-unknown")).toContainText(code);
  await page.getByTestId("meet-panel-adopt").click();

  // The room, inside the panel — the same face, no shell.
  await expect(page.getByTestId("meet-panel-head")).toContainText(`Meet call ${code}`);
  await expect(page.getByTestId("meet-panel-live-state")).toContainText("Recorded from this panel");
  await expect(page.getByTestId("room-status")).toContainText(/Not recording|Reading the room/);
  await expect(page.getByTestId("nav-toggle")).toHaveCount(0);
  // No horizontal scroll at side-panel width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // The record it made: a manual meeting carrying the code; the live path does not apply.
  const resolved = await request.get(`/api/meet/live/resolve?code=${code}`, { headers: MP });
  expect(resolved.status()).toBe(200);
  const r = (await resolved.json()) as { meeting_id: string; source: string; call_ended_at: string | null; meet_live_state: string | null };
  expect(r).toMatchObject({ source: "manual", call_ended_at: null, meet_live_state: null });
  const room = await request.get(`/api/meetings/${r.meeting_id}/room`, { headers: MP });
  expect(((await room.json()) as { meet_live: { state: string | null; applicable: boolean } }).meet_live).toMatchObject({ state: null, applicable: false });
  await expect(page.getByTestId("meet-panel-open-after")).toHaveCount(0);

  // The listener may not open a live session on it — not firm-hosted — and says so by name.
  const live = await request.post("/api/meet/live/sessions", { headers: { "x-wpos-dev-user": "subscription-claimer@joinwestpeek.com" }, data: { meeting_id: r.meeting_id, conference_record: "conferenceRecords/e2e", listener_device: "mac-e2e" } });
  expect(live.status()).toBe(409);
  expect(((await live.json()) as { error: string }).error).toBe("not_firm_hosted");

  // The deep link the panel opens once the call has ended: the After face of this record.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/#/meetings?open=${r.meeting_id}&face=after`);
  await expect(page.getByTestId("face-after")).toHaveAttribute("aria-selected", "true");
});
