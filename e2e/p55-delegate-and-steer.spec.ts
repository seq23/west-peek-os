import { expect, test } from "@playwright/test";
import { approvalStateWords } from "@shared/help/actionNames";
import { gotoSurface } from "./support/nav";

/**
 * Two things a partner does to work that is already moving.
 *
 * ── APPROVE, AND DON'T ASK AGAIN (ADR-018) ──────────────────────────────────────────────────────
 *
 * Operator ask, 22 Aug 2026: a way to approve something and stop being asked about it again for
 * this task, today, or this week. The design's whole safety property is that it is DELEGATED
 * AUTHORITY rather than dismissal — scope, a use limit and an expiry, all three required — and that
 * it can never reach a human-reserved action or an external effect. Both halves are enforced in the
 * choke point, and the interface has to tell the truth about which is which: a card that offered the
 * control and then refused would teach the operator that the control does not work, and a card that
 * refused without saying why would look broken.
 *
 * ── A PARTNER STEERS WORK IN FLIGHT ─────────────────────────────────────────────────────────────
 *
 * Operator: "can the MPs give feedback on a work card that we want the ai employee to acknowledge
 * while they are doing the work?" A note lands in the employee's prompt on their NEXT step and is
 * answered rather than ticked off. Where that can be proven locally, and where it cannot, is set
 * out on the test itself.
 *
 * Runs fully offline: local D1 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

/** A real work card for the delegation to attach to — "until this task is done" needs a task. */
async function openWorkCard(request: import("@playwright/test").APIRequestContext, title: string): Promise<string> {
  const res = await request.post("/api/work-cards", {
    headers: MP,
    data: { title, description: "Opened by the e2e suite.", owner_type: "AI", owner_id: "Wyatt", priority: "NORMAL" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function raiseCard(
  request: import("@playwright/test").APIRequestContext,
  input: { action_key: string; object_type: string; object_id: string; title: string },
): Promise<string> {
  const res = await request.post("/api/approvals", { headers: MP, data: { ...input, submit: true } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test("a reserved action offers no delegate control, and says why", async ({ page, request }) => {
  const marker = `E2E-DELEGATE-RESERVED-${Date.now()}`;
  const cardId = await raiseCard(request, {
    action_key: "governance.policy_change",
    object_type: "governance_update",
    object_id: `gov_${Date.now()}`,
    title: marker,
  });

  await signIn(page);
  await gotoSurface(page, "Approvals");
  const card = page.getByTestId(`approval-card-${cardId}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(approvalStateWords("pending_review").label);

  // The control is ABSENT — not disabled, not hidden behind a refusal after the fact.
  await expect(card.getByTestId(`delegate-${cardId}`)).toHaveCount(0);
  // And the card says why, in the words that explain the rule rather than restating it.
  await expect(card.getByTestId(`not-delegable-${cardId}`)).toContainText("judgement is the work");
});

test("an external effect offers no delegate control either, and gives its own reason", async ({ page, request }) => {
  const marker = `E2E-DELEGATE-EXTERNAL-${Date.now()}`;
  const cardId = await raiseCard(request, {
    action_key: "effect.email.send",
    object_type: "external_effect",
    object_id: `eff_${Date.now()}`,
    title: marker,
  });

  await signIn(page);
  await gotoSurface(page, "Approvals");
  const card = page.getByTestId(`approval-card-${cardId}`);
  await expect(card.getByTestId(`delegate-${cardId}`)).toHaveCount(0);
  /*
   * A DIFFERENT REASON FROM THE RESERVED ONE, and that distinction is the point. Reserved means the
   * judgement itself cannot be handed over; external means it leaves the building. Collapsing them
   * into one sentence would tell a partner the wrong thing about half the queue.
   */
  await expect(card.getByTestId(`not-delegable-${cardId}`)).toContainText("outside the firm");
  await expect(card.getByTestId(`not-delegable-${cardId}`)).not.toContainText("judgement is the work");
});

test("a delegable card offers it, insists on a reason, and the next one of its kind does not wait", async ({ page, request }) => {
  const marker = `E2E-DELEGATE-${Date.now()}`;

  /*
   * START WITH NO LIVE GRANT FOR THIS ACTION — and the reason is the feature working.
   *
   * A "until this task is done" grant carries `object_type` with NO `object_id`, so while its task
   * is open it covers EVERY card of that action key, not only cards about that task. An earlier run
   * of this spec therefore leaves a grant that silently approves the first card this run raises,
   * and the card never reaches the queue to be looked at. Clearing them keeps this re-runnable —
   * a hard requirement of this suite — and the revocation path is worth exercising anyway: an
   * authority you cannot take back is not delegation.
   */
  const existing = (await (await request.get("/api/standing-authority", { headers: MP })).json()) as {
    live: Array<{ id: string; action_key: string }>;
  };
  for (const g of existing.live.filter((x) => x.action_key === "work_card.update")) {
    const revoked = await request.post(`/api/standing-authority/${g.id}/revoke`, {
      headers: MP,
      data: { reason: "E2E: clearing a grant left by an earlier run" },
    });
    expect(revoked.status(), await revoked.text()).toBe(200);
  }

  const workCardId = await openWorkCard(request, `${marker} task`);
  const firstCard = await raiseCard(request, {
    action_key: "work_card.update",
    object_type: "work_card",
    object_id: workCardId,
    title: `${marker} first`,
  });

  await signIn(page);
  await gotoSurface(page, "Approvals");
  const card = page.getByTestId(`approval-card-${firstCard}`);
  await expect(card).toBeVisible();

  // The control IS offered here — and the card does not claim it is undelegable.
  const delegate = card.getByTestId(`delegate-${firstCard}`);
  await expect(delegate).toBeVisible();
  await expect(card.getByTestId(`not-delegable-${firstCard}`)).toHaveCount(0);
  await delegate.locator("summary").click();

  /*
   * A WRITTEN REASON IS REQUIRED. "Any grant without a written reason" was refused deliberately:
   * an unexplained standing authority is unreviewable, and the person who has to review it is
   * usually the same person six months later.
   */
  const thisTask = card.getByTestId(`delegate-this_task-${firstCard}`);
  await expect(thisTask).toBeDisabled();
  await card.getByTestId(`delegate-reason-${firstCard}`).fill("routine edits on this task are mine to make");
  await expect(thisTask).toBeEnabled();

  // All three windows, and no fourth. "Until this task is done" leads because its lifetime is a real
  // event rather than a clock that keeps running overnight.
  for (const window of ["this_task", "today", "this_week"]) {
    await expect(card.getByTestId(`delegate-${window}-${firstCard}`)).toBeVisible();
  }

  await thisTask.click();

  // It still approves the card in front of you.
  await expect
    .poll(async () => {
      const res = await request.get(`/api/approvals/${firstCard}`, { headers: MP });
      return ((await res.json()) as { state: string }).state;
    })
    .toBe("approved");

  /*
   * THE GRANT IS BOUNDED THREE WAYS AT CREATION — scope, a use limit, and an expiry. `ends_at` is
   * NOT NULL by design: "a grant that never expires becomes permanent through neglect", because
   * revoking one requires first remembering it exists, and the reason it was granted was to stop
   * thinking about the thing.
   */
  const grants = (await (await request.get("/api/standing-authority", { headers: MP })).json()) as {
    live: Array<Record<string, unknown>>;
    finished: Array<Record<string, unknown>>;
  };
  const grant = grants.live.find((g) => g.action_key === "work_card.update" && g.work_card_id === workCardId);
  expect(grant, "delegating must record a grant that can be found and revoked").toBeTruthy();
  expect(grant!.ends_at, "a grant with no expiry becomes permanent through neglect").toBeTruthy();
  expect(Number(grant!.max_uses)).toBeGreaterThan(0);
  expect(String(grant!.reason)).toContain("routine edits");

  /*
   * AND THE NEXT ONE DOES NOT WAIT. The card is still created, still carries its action and its
   * requester, and still lands on the spine — it simply does not sit in the queue. A delegation that
   * made the record disappear would be a blind spot rather than an authority.
   */
  const secondCard = await raiseCard(request, {
    action_key: "work_card.update",
    object_type: "work_card",
    object_id: workCardId,
    title: `${marker} second`,
  });
  const second = (await (await request.get(`/api/approvals/${secondCard}`, { headers: MP })).json()) as {
    state: string;
    decision_note: string | null;
  };
  expect(second.state).toBe("approved");
  expect(second.decision_note ?? "").toContain("standing authority");

  // Nothing new is waiting on the partner: the second card never reached the queue.
  await gotoSurface(page, "Approvals");
  await page.getByTestId("approval-filter").selectOption("pending_review");
  await expect(page.getByTestId(`approval-card-${secondCard}`)).toHaveCount(0);

  /*
   * AND SHE CAN STOP IT, ON A SCREEN.
   *
   * The delegate panel promises "and you can stop it at any time". The route to revoke existed and
   * the only thing the client ever called was the POST that CREATES a grant — so the promise was
   * true of the system and false of the product, and every test above this line went through
   * `request` and could not tell the difference. Standing authority's own rule is that a control
   * making the system do LESS must never be harder to reach than the one that made it do more.
   */
  const panel = page.getByTestId("standing-authority");
  await expect(panel).toBeVisible();
  const row = page.getByTestId(`standing-authority-${grant!.id}`);
  await expect(row).toBeVisible();
  // What is left of it, said as a count rather than a percentage nobody can act on.
  await expect(row).toContainText("routine edits");

  await page.getByTestId(`standing-authority-revoke-${grant!.id}`).click();

  // Gone from what is live — immediately, and with no reason asked for. Stopping is always safe.
  await expect(page.getByTestId(`standing-authority-revoke-${grant!.id}`)).toHaveCount(0);
  const after = (await (await request.get("/api/standing-authority", { headers: MP })).json()) as {
    live: Array<{ id: string }>;
    finished: Array<{ id: string; revoked_at: string | null }>;
  };
  expect(after.live.some((g) => g.id === grant!.id)).toBe(false);
  // Kept, not deleted: a revoked authority is part of the record of what the firm once allowed.
  expect(after.finished.find((g) => g.id === grant!.id)?.revoked_at).toBeTruthy();

  // And the next card of that kind waits again, which is the only proof revocation MEANT anything.
  const thirdCard = await raiseCard(request, {
    action_key: "work_card.update",
    object_type: "work_card",
    object_id: workCardId,
    title: `${marker} third`,
  });
  const third = (await (await request.get(`/api/approvals/${thirdCard}`, { headers: MP })).json()) as { state: string };
  expect(third.state).toBe("pending_review");
});

test("a partner's note on running work reaches the employee and waits to be answered", async ({ request }) => {
  /*
   * WHAT THIS PROVES, AND WHERE IT STOPS.
   *
   * The note is stored against the card, it is UNANSWERED until the employee says what it changes,
   * and a note on finished work is refused with a sentence rather than accepted into a void. All of
   * that is drivable here.
   *
   * The last link — that the note appears in the employee's next PROMPT — cannot be proven in this
   * environment and is not claimed. `employeeWork.ts` re-reads unanswered notes on every step and
   * places them above the original brief, but the prompt itself is never persisted (`ai_run` stores
   * a hash of the inputs, not the inputs), and the local provider is the deterministic `mock-local`
   * model, so no step would produce the `ACKNOWLEDGED:` line the acknowledgement is recorded from.
   * That leg is unit-testable and belongs in `tests/`; asserting it here would be a claim this suite
   * cannot support.
   */
  const cardId = await openWorkCard(request, `E2E-STEER-${Date.now()}`);

  const left = await request.post(`/api/work-cards/${cardId}/notes`, {
    headers: MP,
    data: { body: "Do not contact the founder directly — go through the introducer." },
  });
  expect(left.status(), await left.text()).toBe(201);
  expect(((await left.json()) as { waiting: boolean }).waiting).toBe(true);

  const notes = (await (await request.get(`/api/work-cards/${cardId}/notes`, { headers: MP })).json()) as {
    notes: Array<{ body: string; response: string | null; acknowledged_at: string | null; author: string | null }>;
  };
  expect(notes.notes).toHaveLength(1);
  expect(notes.notes[0]!.body).toContain("go through the introducer");
  // Unanswered, and the author is named — a steering note is part of the record of how a piece of
  // work came out the way it did.
  expect(notes.notes[0]!.acknowledged_at).toBeNull();
  expect(notes.notes[0]!.author).toBe("Scooter Taylor");

  // ACKNOWLEDGEMENT IS NOT A CHECKBOX. The table makes "acknowledged" and "answered" one event, so
  // nothing can mark a partner's instruction read without saying what it changed.
  const done = await request.patch(`/api/work-cards/${cardId}`, { headers: MP, data: { state: "DONE" } });
  expect(done.status(), await done.text()).toBe(200);

  const tooLate = await request.post(`/api/work-cards/${cardId}/notes`, {
    headers: MP,
    data: { body: "One more thought before you finish." },
  });
  // Refused plainly rather than accepted into a void: the loop only re-reads notes on a card it is
  // still working, so a note on finished work would never be read by anybody.
  expect(tooLate.status()).toBe(409);
  expect(await tooLate.text()).toContain("Reopen the card first");
});

test("a partner can actually leave that note — through the screen, not the API", async ({ page, request }) => {
  /*
   * WHY THIS TEST EXISTS AND THE ONE ABOVE WAS NOT ENOUGH.
   *
   * The test above proves the note is stored, unanswered, attributed, and refused on finished work.
   * Every assertion in it goes through `request` — it never opens a browser. So it passed, in full,
   * over a feature that had NO INTERFACE AT ALL: a table, two routes, and a loop that re-reads the
   * notes, with no button anywhere in `src/client` to leave one. The operator asked for this in her
   * own words and could not do it.
   *
   * That is the same failure as an approval you cannot revoke, and it is the reason an API-only e2e
   * test is worth less than it looks: it proves the machine works, not that anyone can reach it.
   * This test drives the screen a partner actually uses.
   */
  const marker = `E2E-STEER-UI-${Date.now()}`;
  const cardId = await openWorkCard(request, marker);

  await signIn(page);
  await gotoSurface(page, "Work");

  // Cards rest collapsed, so the control lives one press in — the same press a person makes.
  await page.getByTestId(`work-card-toggle-${cardId}`).click();
  const steer = page.getByTestId(`work-card-steer-${cardId}`);
  await expect(steer).toBeVisible();
  // Named, not generic: "Tell Wyatt something" says who is listening.
  await expect(steer).toContainText("Wyatt");

  await steer.click();
  await page.getByTestId(`work-card-steer-input-${cardId}`).fill("Go through the introducer, not the founder.");
  await page.getByTestId(`work-card-steer-send-${cardId}`).click();

  // It appears in the thread, and says plainly that nobody has picked it up yet — an operator who
  // cannot tell whether it landed will send it twice.
  const thread = page.getByTestId(`work-card-notes-${cardId}`);
  await expect(thread).toContainText("Go through the introducer");
  await expect(thread).toContainText("Not picked up yet");

  // And it is really on the card, not only on the screen.
  const stored = (await (await request.get(`/api/work-cards/${cardId}/notes`, { headers: MP })).json()) as {
    notes: Array<{ body: string; author: string | null }>;
  };
  expect(stored.notes).toHaveLength(1);
  expect(stored.notes[0]!.author).toBe("Scooter Taylor");
});
