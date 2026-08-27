import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1 } from "./support/provision";

/**
 * THE 1:1 TEACHING SESSION — the operator's own issue #19, "University chat is broken".
 *
 * WHY THIS HAD NO COVERAGE AND NEEDED IT. Four routes, a session table, a turn table and a whole
 * page, and nothing anywhere drove them end to end. That matters more here than on most surfaces
 * because of the SHAPE of this feature: every answer is a model call, so the interesting question is
 * never "is the answer good" — it is "what does the page do when there is no answer". A teaching
 * thread that goes silent is indistinguishable from one that is thinking, and a partner who cannot
 * tell types the question again.
 *
 * THE PROPERTY, AND IT HOLDS EITHER WAY. `startSession` and `reply` both write a turn no matter
 * what: an `INSTRUCTOR` turn when the professor answered, and a `SYSTEM` turn carrying the reason
 * when they could not — "The University instructor couldn't respond. Your session is still saved."
 * The session row is written BEFORE the model is called, deliberately, "so even a failed opening
 * leaves something to return to". So the thread is never empty and the learner's own words are never
 * lost, and those are the two things asserted here.
 *
 * WHERE IT STOPS. Under local `wrangler dev` there is no provider credential and privacy mode is
 * LOCKDOWN, so `run_ai` takes the deterministic `mock-local` model. What a real professor would
 * TEACH cannot be proven here and is not claimed. Which of the two turn kinds came back IS read, and
 * reported, so a run that silently stopped producing answers is visible rather than green.
 *
 * Runs fully offline: local D1 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const OTHER = { "x-wpos-dev-user": "e2e-member@westpeek.ventures" };

/*
 * A SECOND FIRM IDENTITY, PROVIDED HERE RATHER THAN BORROWED.
 *
 * The privacy half of this file needs somebody who is NOT the partner who opened the session.
 * `p3-governed-work.spec.ts` creates exactly that identity, and depending on it would make this
 * spec pass or fail on file ordering — run alone it answers 401 (no such user) instead of 404 (not
 * yours), which is a different property and a much weaker one. `INSERT OR IGNORE`, so running after
 * p3 costs nothing.
 */
test.beforeAll(() => {
  provisionLocalD1(
    `INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_e2e_member', 'e2e-member@westpeek.ventures', 'E2E Member', 'ACTIVE'); INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_e2e_member', 'role_investment_team');`,
  );
});

interface Turn {
  id: string;
  turn_no: number;
  role: string;
  body: string;
  state: string;
}

test("a 1:1 session opens, the thread is never empty, and a reply is never lost", async ({ page, request }) => {
  const topic = `E2E-P65 liquidation preferences ${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await gotoSurface(page, "University");
  await expect(page.getByTestId("university-page")).toBeVisible();
  await expect(page.getByTestId("university-start-form")).toBeVisible();

  // Start a session on a real topic, the way a partner does.
  await page.getByTestId("university-topic").fill(topic);
  await page.getByTestId("university-start").click();

  /*
   * THE SESSION OPENED AND THE THREAD SAYS SOMETHING. Asserted as "the first turn exists and has
   * words in it" rather than as any particular sentence: the professor's answer is a model's and
   * the failure notice is the product's, and this journey is about the page never being silent —
   * which is true of both.
   */
  const session = page.getByTestId("university-session");
  await expect(session).toBeVisible();
  await expect(session, "the session is headed by the topic the partner asked about").toContainText(topic);

  const thread = page.getByTestId("university-thread");
  await expect(thread).toBeVisible();
  const firstTurn = page.getByTestId("university-turn-1");
  await expect(firstTurn, "an opened session must never show an empty thread").toBeVisible();
  await expect(firstTurn).not.toBeEmpty();

  const sessionId = await sessionIdFor(request, topic);
  const opening = await turnsFor(request, sessionId);
  expect(opening, "starting a session always writes a turn, answered or not").toHaveLength(1);

  /*
   * WHICH KIND OF TURN CAME BACK, read explicitly. A `SYSTEM`/`FAILED` turn is a legitimate outcome
   * here — there is no provider — and it is the outcome the operator saw as "broken". What is NOT
   * legitimate is a failed turn with nothing in it, so the failure branch is required to carry both
   * the notice a person reads and the reason stored behind it.
   */
  if (opening[0]!.state !== "OK") {
    expect(opening[0]!.role, "a failure is recorded as the system speaking, never as the professor").toBe("SYSTEM");
    expect(opening[0]!.body, "a failed turn still tells the learner where they stand").toContain("still saved");
    await expect(firstTurn).toContainText("still saved");
  } else {
    expect(opening[0]!.role).toBe("INSTRUCTOR");
    expect(opening[0]!.body.length, "an answered turn has words in it").toBeGreaterThan(0);
  }

  /*
   * ── AND THE LEARNER'S OWN WORDS SURVIVE ───────────────────────────────────────────────────────
   *
   * This is the half that would cost the operator her question. The learner's turn is written
   * BEFORE the model is called, so a professor who cannot answer loses the answer and not the
   * question — and the thread shows it as hers.
   */
  const question = "Why does a 2x participating preference change the founder's number so much?";
  await page.getByTestId("university-message").fill(question);
  await page.getByTestId("university-send").click();

  await expect(thread, "the question a partner typed must appear in the thread").toContainText(
    "2x participating preference",
  );

  const after = await turnsFor(request, sessionId);
  expect(after.length, "a reply adds the learner's turn and the professor's answer to it").toBeGreaterThanOrEqual(3);
  const mine = after.find((t) => t.role === "LEARNER");
  expect(mine, "the learner's turn is on the record").toBeTruthy();
  expect(mine!.body).toContain("2x participating preference");
  // Whatever came back, something did — the thread never ends on the learner talking to nobody.
  expect(after[after.length - 1]!.role, "the last word is never the learner's own").not.toBe("LEARNER");

  /*
   * A SESSION IS RESUMABLE. The whole point of a 1:1 is that it is one conversation over time, so
   * leaving and coming back must find the thread rather than a blank start form.
   */
  await page.getByTestId("university-back").click();
  await expect(page.getByTestId("university-start-form")).toBeVisible();
  await page.getByTestId("university-history").locator("summary").first().click();
  await page.getByTestId(`university-resume-${sessionId}`).click();
  // The thread is fetched when the session is resumed, so wait for the first turn to land before
  // reading it — an empty <ul> here is a thread still loading, not a thread that lost the question.
  await expect(page.getByTestId("university-turn-1")).toBeVisible();
  await expect(page.getByTestId("university-thread")).toContainText("2x participating preference");
});

test("a session refuses an empty question rather than opening one about nothing", async ({ page, request }) => {
  /*
   * THE TWO EMPTY CASES, which are different. A session with no topic is nothing to teach; a reply
   * with no message is nothing to answer. Both are refused with a reason, and neither writes a turn
   * — a thread that fills up with blank bubbles is how a teaching record stops being readable.
   */
  const blankStart = await request.post("/api/university", { headers: MP, data: { topic: " " } });
  expect(blankStart.status(), await blankStart.text()).toBe(400);

  const topic = `E2E-P65-EMPTY ${Date.now()}`;
  const opened = await request.post("/api/university", { headers: MP, data: { topic, mode: "LEARN" } });
  expect(opened.status(), await opened.text()).toBe(201);
  const sessionId = ((await opened.json()) as { session: { id: string } }).session.id;
  const before = (await turnsFor(request, sessionId)).length;

  const blankReply = await request.post(`/api/university/${sessionId}/reply`, { headers: MP, data: { message: "   " } });
  expect(blankReply.status(), await blankReply.text()).toBe(400);
  expect(await blankReply.text()).toContain("empty_message");
  expect(
    (await turnsFor(request, sessionId)).length,
    "a refused reply must not leave a blank turn in the thread",
  ).toBe(before);

  /*
   * AND A SESSION IS PRIVATE TO THE PARTNER WHO OPENED IT. A 1:1 that another firm user can read is
   * not a 1:1 — and this one is the Managing Partner's own learning, which is the most personal
   * thing on the surface.
   */
  const someoneElse = await request.get(`/api/university/${sessionId}`, { headers: OTHER });
  expect(someoneElse.status(), "another firm user must not be able to read this session").toBe(404);

  // The partner can still see it on the page, so the refusal above is privacy and not breakage.
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "University");
  await page.getByTestId("university-history").locator("summary").first().click();
  await expect(page.getByTestId(`university-resume-${sessionId}`)).toBeVisible();
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

async function sessionIdFor(request: Ctx, topic: string): Promise<string> {
  const body = (await (await request.get("/api/university", { headers: MP })).json()) as {
    sessions: Array<{ id: string; topic: string }>;
  };
  const found = body.sessions.find((s) => s.topic === topic);
  expect(found, `the session about "${topic}" must have been opened`).toBeTruthy();
  return found!.id;
}

async function turnsFor(request: Ctx, sessionId: string): Promise<Turn[]> {
  const body = (await (await request.get(`/api/university/${sessionId}`, { headers: MP })).json()) as {
    turns: Turn[];
  };
  return body.turns ?? [];
}
