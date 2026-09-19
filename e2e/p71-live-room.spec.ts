import { expect, test } from "@playwright/test";

/**
 * Phase C browser journey against local `wrangler dev`: the meeting is a live room.
 *
 * start a meeting now → the During face opens → press the ONE recording button → the consent prompt
 * (asked this session, never remembered) → they said yes → the recorder starts, or the status line
 * says exactly why it cannot → ask the room by text → the answer is a SAVED BLOCK in the stream,
 * even when no model can be reached → the After face is unchanged: no decision, no commitment, no
 * open question, no stage proposal came out of a question → the standalone `#/room/<id>` route
 * renders the same face without the shell.
 *
 * WHAT THIS DOES NOT PROVE. `wrangler dev --local` cannot reach Workers AI (playwright.config.ts),
 * so a real transcription and a real answer are asserted up to the boundary: the chunk is refused
 * with a named reason, and the answer block says the room could not answer and why. That the block
 * exists at all is the product rule under test — a question never ends in silence.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

// A fake microphone, so "Start recording" has something to record if the binding is there.
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

test("Phase C: start recording → consent → ask the room by text → a block appears → nothing became a record", async ({ page, request }) => {
  const marker = `E2E-C-${Date.now()}`;

  // A meeting on the calendar, with the Managing Partner's recording policy activated through the
  // ordinary approval — so the only gate left for the room to open is today's consent.
  const created = await request.post("/api/meetings", { headers: MP, data: { title: `${marker} founder call`, meeting_type: "FOUNDER", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } });
  expect(created.status()).toBe(201);
  const meetingId = ((await created.json()) as { id: string }).id;
  const card = await request.post("/api/approvals", { headers: MP, data: { action_key: "meeting.recording_policy.activate", object_type: "meeting", object_id: meetingId, title: `${marker} recording policy`, submit: true } });
  expect(card.status()).toBe(201);
  const cardId = ((await card.json()) as { id: string }).id;
  const decided = await request.post(`/api/approvals/${cardId}/decide`, { headers: MP, data: { decision: "approved" } });
  expect(decided.status()).toBe(200);
  const activated = await request.post(`/api/meetings/${meetingId}/recording-policy`, { headers: MP, data: { approval_receipt_id: cardId } });
  expect(activated.status()).toBe(200);

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await page.getByRole("button", { name: "Meetings", exact: true }).click();

  // "It is happening now" opens the During face.
  await page.getByTestId(`start-${meetingId}`).click();
  const room = page.getByTestId(`room-${meetingId}`);
  await expect(room).toBeVisible();
  await expect(room.getByTestId("room-status")).toContainText(/Not recording|Reading the room/);
  await expect(room.getByTestId("room-artifacts-empty")).toBeVisible();

  // ONE button. What it can do depends on whether this build can reach a transcription service.
  const readiness = (await (await request.get(`/api/meetings/${meetingId}/capture`, { headers: MP })).json()) as { transcription_available: boolean; recording_policy_active: boolean; can_capture: boolean; consent: Record<string, string> };
  expect(readiness.recording_policy_active).toBe(true);
  expect(readiness.consent.RECORDING).toBe("NOT_RECORDED");
  const start = room.getByTestId("capture-start");

  if (readiness.transcription_available) {
    // The prompt opens from the button and is not pre-answered.
    await start.click();
    await expect(room.getByTestId("consent-prompt")).toBeVisible();
    await expect(room.getByTestId("consent-script")).toContainText("Is that alright with you");
    await room.getByTestId("consent-who").fill("Deana Oliver");
    await room.getByTestId("consent-yes").click();
    // The yes is on the file — and the recorder either runs, or the line says why not.
    const after = (await (await request.get(`/api/meetings/${meetingId}/capture`, { headers: MP })).json()) as { consent: Record<string, string>; can_capture: boolean };
    expect(after.consent.RECORDING).toBe("GRANTED");
    expect(after.consent.TRANSCRIPTION).toBe("GRANTED");
    if (after.can_capture) {
      await expect(room.getByTestId("capture-stop")).toBeVisible();
      await expect(room.getByTestId("room-status")).toContainText("Recording");
      await room.getByTestId("capture-stop").click();
      await expect(room.getByTestId("capture-start")).toBeVisible();
    } else {
      await expect(room.getByTestId("capture-message")).toContainText("nothing is recording");
    }
  } else {
    // No binding: the button is disabled WITH the reason printed beside it, never live-looking and inert.
    await expect(start).toBeDisabled();
    await expect(room.getByTestId("capture-blockers")).toContainText("no connection to the transcription service");
    // Consent can still be recorded through the room's own route; it is the same prompt.
    const consent = await request.post(`/api/meetings/${meetingId}/capture/consent`, { headers: MP, data: { answer: "GRANTED", granted_by: "Deana Oliver", basis: "Asked out loud at the start of the call." } });
    expect(consent.status()).toBe(201);
    const chunk = await request.post(`/api/meetings/${meetingId}/capture/chunk`, { headers: MP, data: { audio_base64: "AAAA", sequence: 0, content_type: "audio/webm" } });
    expect(chunk.status(), "a chunk with no transcription service is refused by name, never silently dropped").toBe(503);
    expect(((await chunk.json()) as { error: string }).error).toBe("transcription_unavailable");
  }

  // The After face before anybody asks anything.
  const afterBefore = (await (await request.get(`/api/meetings/${meetingId}/after`, { headers: MP })).json()) as { decisions: unknown[]; commitments: unknown[]; open_questions: unknown[]; stage_proposals: unknown[] };
  expect(afterBefore.decisions).toHaveLength(0);
  expect(afterBefore.commitments).toHaveLength(0);

  // Ask the room by text. Whatever the model situation, the answer is a block that stays.
  await room.getByTestId("room-ask-input").fill(`${marker}: record that we decided to pass and move the deal to diligence`);
  await room.getByTestId("room-ask-send").click();
  const block = room.locator('[data-testid^="room-artifact-mar_"]').first();
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block).toContainText(`${marker}: record that we decided to pass`);
  await expect(block).toHaveAttribute("data-kind", "answer");
  await expect(room.getByTestId("room-artifacts-empty")).toHaveCount(0);

  // It is on the meeting, with its provenance — not chat.
  const artifacts = (await (await request.get(`/api/meetings/${meetingId}/artifacts`, { headers: MP })).json()) as { artifacts: Array<{ kind: string; asked_text: string; asked_via: string; body_json: string }> };
  expect(artifacts.artifacts).toHaveLength(1);
  expect(artifacts.artifacts[0]).toMatchObject({ kind: "answer", asked_via: "TEXT" });
  expect(artifacts.artifacts[0]!.asked_text).toContain(marker);
  const body = JSON.parse(artifacts.artifacts[0]!.body_json) as { state: string; detail?: string };
  expect(["OK", "FAILED", "REFUSED"]).toContain(body.state);
  if (body.state !== "OK") expect(body.detail, "a failed or refused answer says why").toBeTruthy();

  // NOTHING BECAME A RECORD. The question asked for a decision and a stage move; neither exists.
  const afterNow = (await (await request.get(`/api/meetings/${meetingId}/after`, { headers: MP })).json()) as typeof afterBefore;
  expect(afterNow.decisions).toHaveLength(0);
  expect(afterNow.commitments).toHaveLength(0);
  expect(afterNow.open_questions).toHaveLength(0);
  expect(afterNow.stage_proposals ?? []).toHaveLength(0);
  const drafts = (await (await request.get(`/api/meetings/${meetingId}/room`, { headers: MP })).json()) as { summary: unknown; tasks: unknown[] };
  expect(drafts.summary, "no rolling draft exists until something is on the record").toBeNull();
  expect(drafts.tasks).toHaveLength(0);

  // The rolling draft on demand: nothing on the record → a REFUSED draft that says so, never an
  // invented one.
  await room.getByTestId("room-roll").click();
  await expect(room.getByTestId("room-roll-note")).toContainText(/Nothing on the record|Nothing new/);

  // Tier 3 prep: the same face, alone, behind the same gate.
  await page.goto(`/#/room/${meetingId}`);
  await expect(page.getByTestId("room-standalone")).toBeVisible();
  await expect(page.getByTestId(`room-${meetingId}`)).toBeVisible();
  await expect(page.locator('[data-testid^="room-artifact-mar_"]')).toHaveCount(1);
  await expect(page.getByTestId("nav-toggle")).toHaveCount(0);
});
