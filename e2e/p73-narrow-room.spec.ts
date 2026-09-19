import { expect, test, type APIRequestContext } from "@playwright/test";
import { signIn, measureSurface, reportLine, type Viewport } from "./support/measure";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1 } from "./support/provision";

/**
 * THE NARROW ROOM, THE DOORS ONTO A CALL, AND THE WAY BACK (owner, 19 Sep 2026).
 *
 * "Join on Meet should give the option to do it inside the Meet tab or external like now; if
 * inside, it loads a new layout, and we can return when it's over." And: until Google's live path
 * lands, "the way to get the room live on a Meet call is the laptop-mic switch while the call plays
 * through the speakers" — a first-class path.
 *
 * Three proofs:
 *   1 · BESIDE THE CALL is one press: the Meet opens in a new tab AND the room, narrow, in this one.
 *       The row is in progress from that press and leaves Coming up.
 *   2 · USE MY LAPTOP MIC opens the Meet and the room's consent prompt — nothing is stored before
 *       "They said yes"; the note says speakers, not headphones.
 *   3 · THE NARROW LAYOUT holds its numbers at 320 / 360 / 390 — 0 overflow, 0 targets under the
 *       floor, hold-to-talk the biggest target — and when the call is over, one primary returns her
 *       to the full After face in the app.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

async function meetMeeting(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post("/api/meetings", { headers: MP, data: { title, meeting_type: "FOUNDER", scheduled_at: new Date(Date.now() + 1_800_000).toISOString() } });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  provisionLocalD1(`UPDATE meeting SET source = 'google_calendar', meet_link = 'https://meet.google.com/svf-nzzr-pax', meet_conference_id = 'svf-nzzr-pax', calendar_key = 'westpeek' WHERE id = '${id}'`);
  return id;
}

test("Beside the call is one press: the Meet opens in a new tab, the narrow room in this one, and the row is in progress", async ({ page, request, context }) => {
  const marker = `E2E-DOORS-${Date.now()}`;
  const id = await meetMeeting(request, `${marker} Deana Oliver, Psyflo — founder call`);
  await signIn(page);
  await gotoSurface(page, "Meetings");

  // The row: the one primary door, the one-room line, and the call's doors beneath it.
  const row = page.getByTestId(`upcoming-${id}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`upcoming-open-${id}`)).toHaveText("Go to this meeting");
  await expect(row.getByTestId(`one-room-line-${id}`)).toContainText("One room for this meeting");
  await expect(row.getByTestId(`join-mode-beside-${id}`)).toBeChecked();

  // Inside the call: not installed for the firm yet — it says so and falls back to beside.
  await row.getByTestId(`join-mode-inside-${id}`).check();
  const popup1 = context.waitForEvent("page");
  await row.getByTestId(`join-${id}`).click();
  const meet1 = await popup1;
  expect(meet1.url()).toContain("meet.google.com");
  await meet1.close();
  // Beside: this tab is now the narrow room, no shell.
  await expect(page.getByTestId("room-standalone")).toBeVisible();
  await expect(page.getByTestId("nav-toggle")).toHaveCount(0);
  await expect(page.getByTestId(`call-doors-note-${id}`).or(page.getByTestId(`room-${id}`))).toBeVisible();
  // The choice was remembered per viewer.
  const remembered = await page.evaluate(() => window.localStorage.getItem("wp-meet-join-mode"));
  expect(remembered).toBe("inside");

  // The row is in progress from that press: off Coming up, on the record as happening now.
  await page.goto("/#/meetings");
  await expect(page.getByTestId("meetings-page")).toBeVisible();
  await expect(page.getByTestId(`upcoming-${id}`)).toHaveCount(0);
  const onRecord = page.getByTestId(`meeting-${id}`);
  await expect(onRecord).toBeVisible();
  await onRecord.getByTestId(`meeting-open-${id}`).click();
  await expect(page.getByTestId("meeting-status")).toHaveText("happening now");
  // "It is happening now" is nowhere; in progress was derived from the press.
  await expect(page.getByText("It is happening now")).toHaveCount(0);
});

test("Use my laptop mic: the Meet opens, the consent prompt opens here, and nothing is stored before They said yes", async ({ page, request, context }) => {
  const marker = `E2E-MIC-${Date.now()}`;
  const id = await meetMeeting(request, `${marker} laptop mic call`);
  // The Managing Partner's recording policy for this meeting, so the only gate left is their yes.
  const card = await request.post("/api/approvals", { headers: MP, data: { action_key: "meeting.recording_policy.activate", object_type: "meeting", object_id: id, title: `${marker} policy`, submit: true } });
  const cardId = ((await card.json()) as { id: string }).id;
  await request.post(`/api/approvals/${cardId}/decide`, { headers: MP, data: { decision: "approved" } });
  expect((await request.post(`/api/meetings/${id}/recording-policy`, { headers: MP, data: { approval_receipt_id: cardId } })).status()).toBe(200);

  await signIn(page);
  await gotoSurface(page, "Meetings");
  await page.getByTestId(`upcoming-open-${id}`).click();
  // Before, with a call: the doors, not Open the room.
  await expect(page.getByTestId("brief-open-room")).toHaveCount(0);
  const doors = page.getByTestId(`call-doors-${id}`).first();
  await expect(doors.getByTestId(`laptop-mic-note-${id}`)).toContainText("speakers, not headphones");

  const popup = context.waitForEvent("page");
  await doors.getByTestId(`laptop-mic-${id}`).click();
  const meet = await popup;
  expect(meet.url()).toContain("meet.google.com");
  await meet.close();

  // This tab: the narrow room, armed — the consent prompt is open, the note is on the line.
  await expect(page.getByTestId("room-standalone")).toBeVisible();
  const room = page.getByTestId(`room-${id}`);
  await expect(room.getByTestId("laptop-mic-note")).toContainText("keep this mic unmuted in Meet");
  await expect(room.getByTestId("consent-prompt")).toBeVisible();
  await expect(room.getByTestId("consent-script")).toBeVisible();
  await expect(room.getByTestId("capture-start")).toHaveAttribute("aria-checked", "false");
  // Nothing stored before their yes.
  const before = (await (await request.get(`/api/meetings/${id}/hearing`, { headers: MP })).json()) as { facts: { turns_captured: number }; sources: unknown[] };
  expect(before.facts.turns_captured).toBe(0);
  expect(before.sources).toEqual([]);
  // The hearing chip says how the room hears before the yes: Google transcribes, read in after.
  await expect(room.getByTestId(`hears-${id}`)).toHaveAttribute("data-state", /^MEET_(PENDING|DEFAULT_OFF)$/);

  // They said yes: the recorder starts (fake microphone), or the line says exactly why it cannot —
  // `wrangler dev --local` binds no transcription service, so the first slice is refused by name and
  // the switch never lies about being on.
  await room.getByTestId("consent-who").fill("Deana Oliver");
  await room.getByTestId("consent-yes").click();
  await expect(room.getByTestId("capture-message")).toContainText(/on the file/);
  const after = (await (await request.get(`/api/meetings/${id}/capture`, { headers: MP })).json()) as { consent: Record<string, string> };
  expect(after.consent.RECORDING).toBe("GRANTED");
  expect(after.consent.TRANSCRIPTION).toBe("GRANTED");
  // Their yes started the meeting (0214) — via the door pressed first.
  const started = (await (await request.get("/api/meetings", { headers: MP })).json()) as { meetings: Array<{ id: string; started_via: string | null }> };
  expect(started.meetings.find((m) => m.id === id)?.started_via).toBe("laptop_mic");
});

test("the narrow room holds its numbers at 320 / 360 / 390, hold-to-talk is the biggest target, and when the call is over one primary returns to After in the app", async ({ page, request }) => {
  const marker = `E2E-NARROW-${Date.now()}`;
  const id = await meetMeeting(request, `${marker} narrow room`);
  await signIn(page);
  const report: string[] = [];
  const widths: Viewport[] = [
    { name: "320 — the narrowest phone", width: 320, height: 720 },
    { name: "360 — the Meet side panel", width: 360, height: 800 },
    { name: "390 — a large phone", width: 390, height: 844 },
  ];
  for (const vp of widths) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/#/room/${id}`);
    await expect(page.getByTestId("room-standalone")).toBeVisible();
    await expect(page.getByTestId("room-status")).not.toContainText("Reading the room");
    await expect(page.getByTestId(`hears-${id}`)).not.toHaveAttribute("data-state", "loading");
    await expect(page.getByTestId("nav-toggle")).toHaveCount(0);
    // The order: chip, head with the doors, recording, draft, stream, seats, dock with the ask box.
    const chip = page.getByTestId("hears-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await chip.click();
    await expect(page.getByTestId("hears-sentence")).toBeVisible();
    await chip.click();
    await expect(page.getByTestId(`call-doors-${id}`)).toBeVisible();
    const ptt = page.getByTestId("room-ptt");
    const ask = page.getByTestId("room-ask-send");
    const pttBox = (await ptt.boundingBox())!;
    const askBox = (await ask.boundingBox())!;
    expect(pttBox.height, `hold-to-talk height at ${vp.width}`).toBeGreaterThanOrEqual(56);
    expect(pttBox.width * pttBox.height, `hold-to-talk is the biggest target at ${vp.width}`).toBeGreaterThan(askBox.width * askBox.height);
    report.push(reportLine("Narrow room", vp, await measureSurface(page, "room-standalone", "Narrow room", vp)));
  }
  console.log("NARROW ROOM MEASURED\n  " + report.join("\n  "));

  // Not over yet: no way back on the head; Done — open the record is the way out.
  await expect(page.getByTestId(`room-over-${id}`)).toHaveCount(0);
  await expect(page.getByTestId(`room-finish-${id}`)).toBeVisible();

  // The call ended: Google reported it (CALL_ENDED_SIGNAL — the inbox row's conference_ended_at).
  provisionLocalD1(`INSERT INTO meet_event_inbox (id, conference_record, meeting_id, delivered_via, state, conference_ended_at, detail) VALUES ('mei_${Date.now()}', 'conferenceRecords/${marker}', '${id}', 'poll', 'RECEIVED', '2026-09-19T15:02:00Z', 'no transcript yet')`);
  await page.reload();
  await expect(page.getByTestId("room-standalone")).toBeVisible();
  const over = page.getByTestId(`room-over-${id}`);
  await expect(over).toBeVisible();
  await expect(page.getByTestId(`hears-${id}`)).toHaveAttribute("data-state", "MEET_WAITING_FOR_TRANSCRIPT");
  await page.getByTestId(`room-return-${id}`).click();
  // Back in the app, on this meeting's After face, in this same tab.
  await expect(page).toHaveURL(new RegExp(`#/meetings\\?open=${id}&face=after`));
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await expect(page.getByTestId("face-after")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("after-sources")).toBeVisible();
  await expect(page.getByTestId("nav-toggle")).toBeVisible();
});
