import { expect, test, type APIRequestContext } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { signIn } from "./support/measure";
import { provisionLocalD1 } from "./support/provision";

/**
 * "HOW DOES THIS PAGE WORK" — the answer is the page as it is, in a shape a person can read.
 *
 * Owner, 19 Sep 2026, on asking Walter on Meetings: "I can't understand anything he said — it's all
 * jumbled … I think he still has the old page instructions." Her pasted example was one paragraph
 * with three bolded phrases — "Prepare for a meeting… Confer with an AI employee during it… Run a
 * close-out…" — the page as it was before that week's redesign.
 *
 * NEGATIVE PROOF IS THE POINT OF THIS SPEC. The retired trio is asserted absent from Walter's
 * answer and from the Help tab's Meetings section, and the current controls are asserted present
 * as a rendered ordered list and bulleted acts — not as text inside one <p>.
 *
 * SAME DAY, THE SECOND HALF. She asked Walter to walk her through a fake meeting and "he skipped
 * over the screen I get to when I open the room and can seat AI employees … If I push Join on Meet
 * what happens? … Is it recording? Are my AI employees there from Join on Meet alone?" So: "walk me
 * through a real meeting" is the guide's walkthrough verbatim — numbered, naming Seat, Join on Meet
 * and what it does NOT do, the transcript arriving after the call, Draft, Approve; "explain what all
 * of the buttons do" is every act grouped by face; and the During face carries a "How this room
 * hears" line whose state is read off the row — one for a calendar Meet call, one for a meeting
 * recorded here.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

/** Ask Walter, and return the HOST turn that opens with `opener` — the thread persists across specs. */
async function ask(page: import("@playwright/test").Page, message: string, opener: string): Promise<import("@playwright/test").Locator> {
  await page.getByTestId("page-chat-input-meetings").fill(message);
  await page.getByTestId("page-chat-send-meetings").click();
  const answer = page.getByTestId("page-chat-thread-meetings").locator('[data-role="HOST"]', { hasText: opener }).last();
  await expect(answer).toBeVisible();
  return answer;
}

async function createMeeting(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post("/api/meetings", { headers: MP, data: { title, meeting_type: "FOUNDER", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const RETIRED_MEETINGS_TRIO = ["Prepare for a meeting", "Confer with an AI employee", "Run a close-out"];
const CURRENT_MEETINGS_CONTROLS = ["Open the room", "They said yes — record", "Approve — make these the record", "Move it", "Google Meet"];

test("ask Walter on Meetings how the page works: an ordered list of the current page, not the old trio in a paragraph", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Meetings");

  const host = page.getByTestId("page-host-meetings");
  await expect(host).toBeVisible();
  await expect(host).toContainText("Walter");

  await page.getByTestId("page-chat-toggle-meetings").click();
  await page.getByTestId("page-chat-input-meetings").fill("how does this page work?");
  await page.getByTestId("page-chat-send-meetings").click();

  const thread = page.getByTestId("page-chat-thread-meetings");
  const answer = thread.locator('[data-role="HOST"]').first();
  await expect(answer).toBeVisible();

  // STRUCTURE, RENDERED: a numbered list of the bands and a bulleted list of the acts, painted as
  // real <ol>/<ul> elements — the defect was the structure being flattened into one <p>.
  const ordered = answer.locator("ol.md-lite-list");
  await expect(ordered).toHaveCount(1);
  expect(await ordered.locator("li").count()).toBeGreaterThanOrEqual(7);
  const bulleted = answer.locator("ul.md-lite-list");
  expect(await bulleted.count()).toBeGreaterThanOrEqual(1);
  expect(await answer.locator("strong").count()).toBeGreaterThan(10);
  expect(await answer.locator("p").count()).toBeLessThan(4);

  const text = (await answer.innerText()).replace(/\s+/g, " ");
  for (const control of CURRENT_MEETINGS_CONTROLS) expect(text, control).toContain(control);
  for (const phrase of RETIRED_MEETINGS_TRIO) expect(text, phrase).not.toContain(phrase);
  for (const face of ["Before", "During", "After"]) expect(text, face).toContain(face);
  // The committee's new address is named, and no question is asked back.
  expect(text).toContain("Dealflow");
  expect(text.trim().endsWith("?")).toBe(false);
});

test("ask Walter to walk you through a real meeting: a numbered scenario from the guide — Seat, Join on Meet and what it does not do, the transcript after the call, Draft, Approve", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Meetings");
  await page.getByTestId("page-chat-toggle-meetings").click();

  const answer = await ask(page, "walk me through a real meeting", "Here is how you would use Meetings, start to finish");
  // Two scenarios — the calendar Meet call and the in-person one — each a real <ol>.
  const ordered = answer.locator("ol.md-lite-list");
  await expect(ordered).toHaveCount(2);
  expect(await ordered.first().locator("li").count()).toBeGreaterThanOrEqual(10);
  const text = (await answer.innerText()).replace(/\s+/g, " ");
  expect(text).toMatch(/^WALTER Here is how you would use Meetings, start to finish — 2 scenarios/);
  for (const control of ["Go to this meeting", "Seat", "Join on Meet", "Use my laptop mic for this Meet call", "Done — open the record", "Draft what came out of it", "Approve — make these the record", "Move it", "They said yes — record"]) expect(text, control).toContain(control);
  // What does not happen, and when the transcript lands — the two things she could not find out.
  expect(text).toContain("What does not happen: nothing joins for you");
  expect(text).toContain("no employee is in the call");
  expect(text).toContain("one room, several doors");
  expect(text).toContain("Within the hour Google's transcript");
  expect(text).toContain("laptop microphone");
  for (const phrase of RETIRED_MEETINGS_TRIO) expect(text, phrase).not.toContain(phrase);
  expect(text.trim().endsWith("?")).toBe(false);

  // The buttons, grouped by face: a heading per band and every act under one.
  const buttons = await ask(page, "explain what all of the buttons do", "Every control on Meetings, band by band");
  const heads = await buttons.locator("h2, h3, h4, .md-lite-head").allInnerTexts();
  for (const face of ["Before", "During", "After", "Coming up", "Google Meet"]) expect(heads.map((h) => h.trim()), face).toContain(face);
  expect(await buttons.locator("ul.md-lite-list").count()).toBeGreaterThanOrEqual(5);
  const btext = (await buttons.innerText()).replace(/\s+/g, " ");
  expect(btext).toMatch(/^WALTER Every control on Meetings, band by band/);
  for (const control of CURRENT_MEETINGS_CONTROLS) expect(btext, control).toContain(control);
  expect(btext).toContain("Seat");
});

test("the During face says how this room hears — a calendar Meet call, then a meeting recorded here — from named states off the row", async ({ page, request }) => {
  const marker = `E2E-HEARS-${Date.now()}`;
  const meetId = await createMeeting(request, `${marker} Deana Oliver, Psyflo — founder call`);
  const manualId = await createMeeting(request, `${marker} coffee with a founder`);
  // The calendar sync's own columns (migration 0202), written as the sync writes them.
  provisionLocalD1(`UPDATE meeting SET source = 'google_calendar', meet_link = 'https://meet.google.com/svf-nzzr-pax', meet_conference_id = 'svf-nzzr-pax', calendar_key = 'westpeek' WHERE id = '${meetId}'`);

  await signIn(page);
  await gotoSurface(page, "Meetings");

  // ── The Meet call ──
  // The row: one primary door with the one-room line, the call's doors beneath it, and no
  // "It is happening now" (retired 19 Sep 2026 — "wtf is that button").
  await expect(page.getByTestId(`start-${meetId}`)).toHaveCount(0);
  await expect(page.getByTestId(`one-room-line-${meetId}`)).toContainText("One room for this meeting");
  await expect(page.getByTestId(`join-${meetId}`).first()).toBeVisible();
  await expect(page.getByTestId(`laptop-mic-${meetId}`).first()).toBeVisible();
  await page.getByTestId(`upcoming-open-${meetId}`).click();
  // With a call, Before carries the call's doors instead of Open the room.
  await expect(page.getByTestId("face-before")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("brief-open-room")).toHaveCount(0);
  await page.getByTestId("face-during").click();
  await expect(page.getByTestId("face-during")).toHaveAttribute("aria-selected", "true");
  const hears = page.getByTestId(`hears-${meetId}`);
  await expect(hears).toBeVisible();
  // The firm default is off in a fresh firm, so the state is MEET_DEFAULT_OFF — read, not guessed.
  await expect(hears).toHaveAttribute("data-state", "MEET_DEFAULT_OFF");
  await expect(hears).toContainText("How this room hears · Google Meet call");
  await expect(hears.getByTestId("hears-sentence")).toContainText("Join on Meet only opens the call");
  await expect(hears.getByTestId("hears-sentence")).toContainText("firm default is off");
  await expect(hears.getByTestId("hears-live-path")).toBeVisible();
  // Join on Meet says what it does and does not do, on the button and under it, and offers the
  // two ways — inside the call, beside the call — remembered per viewer.
  const join = page.getByTestId(`join-${meetId}`).first();
  await expect(join).toHaveAttribute("title", /new tab.*no employee is in the call.*does not hear it live/);
  await expect(page.getByTestId(`join-line-${meetId}`).first()).toContainText("Nothing joins for you");
  await expect(page.getByTestId(`join-mode-inside-${meetId}`).first()).toBeAttached();
  await expect(page.getByTestId(`join-mode-beside-${meetId}`).first()).toBeChecked();
  // Beside Seat, what a seated employee can and cannot do; the standalone link says what it is.
  await expect(page.getByTestId("seat-line")).toContainText("never in the Meet call");
  await expect(page.getByTestId(`room-standalone-line-${meetId}`)).toContainText("same room, in its own window");
  const popup = page.waitForEvent("popup");
  await page.getByTestId(`room-standalone-link-${meetId}`).click();
  const standalone = await popup;
  await standalone.waitForLoadState();
  expect(standalone.url()).toContain(`#/room/${meetId}`);
  await expect(standalone.getByTestId("room-standalone")).toBeVisible();
  await standalone.close();

  // Turn the firm default on through its own route (the receipt path is proven in p-meet); the
  // line moves to MEET_PENDING and names the cadence from the job row — the real number, 60.
  provisionLocalD1("INSERT INTO meet_recording_policy (firm_scope, active, receipt_id) VALUES ('west-peek', 1, 'apr_e2e_hears') ON CONFLICT (firm_scope) DO UPDATE SET active = 1");
  await page.getByTestId("face-before").click();
  await page.getByTestId("face-during").click();
  await expect(hears).toHaveAttribute("data-state", "MEET_PENDING");
  await expect(hears.getByTestId("hears-sentence")).toContainText("within ~60 min of the call ending");
  await expect(hears.getByTestId("hears-sentence")).toContainText("this room does not hear it live");
  provisionLocalD1("UPDATE meet_recording_policy SET active = 0 WHERE firm_scope = 'west-peek'");

  // After says where its material came from — nothing yet, and says so.
  await page.getByTestId("face-after").click();
  await expect(page.getByTestId("after-sources")).toHaveAttribute("data-state", "empty");
  await expect(page.getByTestId("after-sources-empty")).toContainText("no Meet transcript, no laptop capture");

  // ── The meeting recorded here ──
  await page.getByTestId("record-back").click();
  await page.getByTestId(`upcoming-open-${manualId}`).click();
  // No call: Open the room stands on Before and goes into the same room.
  await expect(page.getByTestId("brief-open-room-line")).toContainText("the same room, not a second one");
  await page.getByTestId("brief-open-room").click();
  await expect(page.getByTestId("face-during")).toHaveAttribute("aria-selected", "true");
  const manualHears = page.getByTestId(`hears-${manualId}`);
  await expect(manualHears).toBeVisible();
  await expect(manualHears).toContainText("How this room hears · In person or by phone");
  // `wrangler dev --local` binds no transcription service, so the first shut gate is the service;
  // the state is read off the same readiness the recording switch is disabled by.
  await expect(manualHears).toHaveAttribute("data-state", /^MANUAL_(NO_SERVICE|POLICY_OFF)$/);
  await expect(manualHears.getByTestId("hears-sentence")).toContainText("Notes");
  await expect(manualHears.getByTestId("hears-sentence")).not.toContainText("Google");
  await expect(page.getByTestId(`join-${manualId}`)).toHaveCount(0);

  // Phone width: the line, the Join explanation and the seat sentence stay on the page with no
  // horizontal overflow.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(manualHears).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal overflow at 375px").toBeLessThanOrEqual(0);
});

test("the Help tab's Meetings section is the same guide, and 'How everything works' from Meetings lands on it", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Meetings");

  await page.getByTestId("page-purpose-help-meetings").click();
  await expect(page.getByTestId("help-center-page")).toBeVisible();

  const section = page.getByTestId("help-page-meetings");
  await expect(section).toBeVisible();
  // Landed on the section, not the top of the page.
  const inView = await section.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= -8 && r.top < window.innerHeight;
  });
  expect(inView, "the Meetings section is scrolled into view on arrival").toBe(true);

  // The guide's one numbered band list, plus one numbered list per walkthrough scenario — the
  // walkthrough is on the Help tab under the guide, the same text Walter speaks.
  await expect(section.locator("ol.md-lite-list")).toHaveCount(3);
  const walkthrough = section.getByTestId("help-walkthrough-meetings");
  await expect(walkthrough).toContainText("How you would use it");
  await expect(walkthrough).toContainText("A founder call that arrived from the calendar, on Google Meet");
  await expect(walkthrough).toContainText("In person or by phone");
  await expect(walkthrough).toContainText("Join on Meet");
  await expect(section).toContainText("Hosted by Walter");
  const text = (await section.innerText()).replace(/\s+/g, " ");
  for (const control of CURRENT_MEETINGS_CONTROLS) expect(text, control).toContain(control);
  for (const phrase of RETIRED_MEETINGS_TRIO) expect(text, phrase).not.toContain(phrase);

  // Every page in the nav's rooms has a section, and the search narrows to a page by its controls.
  for (const key of ["thesis", "dealflow", "companies", "secondaries", "portfolio", "fund-strategy", "lp", "rooms", "community", "employees", "record", "research", "university", "documents", "approvals", "work", "notifications", "home"]) {
    await expect(page.getByTestId(`help-page-${key}`), key).toBeAttached();
  }
  await page.getByTestId("help-search").fill("hold to talk");
  await expect(page.getByTestId("help-page-meetings")).toBeVisible();
  await expect(page.getByTestId("help-page-thesis")).toBeHidden();
  await page.getByTestId("help-search").fill("");
  await expect(page.getByTestId("help-page-thesis")).toBeVisible();

  // The door back to the page.
  await page.getByTestId("help-page-open-meetings").click();
  await expect(page.getByTestId("page-host-meetings")).toBeVisible();
});
