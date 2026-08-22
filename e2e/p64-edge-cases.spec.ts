import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { deliverMail } from "./support/mail";
import { provisionLocalD1, queryLocalD1 } from "./support/provision";

/**
 * TWO EDGE CASES THAT HAVE ALREADY BITTEN THIS FIRM.
 *
 * · A SECOND IDENTICAL ARRIVAL JOINS THE EXISTING WORK CARD RATHER THAN OPENING A DUPLICATE — and
 *   the mirror of it, which is the more expensive half: a second DIFFERENT arrival must not be
 *   swallowed by the first one's card. That is not hypothetical. The dedupe rule matched on
 *   (machine, owner) and left the OBJECT out, and Wyatt owns the top of the funnel while every
 *   arrival runs on the early-stage deal machine — so the second company emailed in joined the
 *   first company's card and vanished. A firm cannot lose an inbound deal to a dedupe rule.
 *
 * · REOPENING A DECIDED APPROVAL SUPERSEDES RATHER THAN EDITS, AND THE ORIGINAL STAYS VISIBLE.
 *   `approval_decision` refuses UPDATE and DELETE at the database, so changing a decision writes a
 *   new row pointing at the one it takes back. The reason that matters is not tidiness: the whole
 *   value of a receipt is that it says what somebody decided at the time, and a decision that can
 *   be rewritten afterwards is not a receipt, it is a note.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const INTAKE_SEAT = "aie_wyatt";

/**
 * Clear the intake seat's hour before these journeys run.
 *
 * Three of the four doors into the funnel open a card for one seat, and that seat trips a breaker
 * at twenty cards an hour — correct behaviour, and one a whole-suite run reaches on its own. This
 * journey is about the dedupe rule and not about the breaker (which has its own test in
 * `p57-deal-intake-and-pipeline.spec.ts`), so only the clock is moved. Nothing is deleted.
 */
test.beforeAll(() => {
  provisionLocalD1(
    `UPDATE work_card SET created_at = '2026-01-01T00:00:00.000Z'
      WHERE owner_id = '${INTAKE_SEAT}'
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours');`,
  );
});

test("the same company arriving twice joins one card; a different company never joins it", async ({ page, request }) => {
  const stamp = Date.now();
  const company = `Duplicate Labs ${stamp}`;
  const other = `Quite Different Co ${stamp}`;

  // The same message twice — a re-read inbox, a forward of a forward, a job that ran twice.
  for (const attempt of [1, 2]) {
    await deliverMail(request, {
      from: `Robin Vale <robin@duplicate.example>`,
      subject: `#wpdealflow ${company}`,
      body: `Company: ${company}\n\nSending again in case the first one bounced (attempt ${attempt}).`,
    });
  }

  /*
   * ONE LIVE CARD, NOT TWO. Counted in the database rather than on the board, because the board
   * shows what the query returns and the property is about what exists.
   */
  const cards = queryLocalD1<{ id: string; state: string }>(
    `SELECT id, state FROM work_card
      WHERE title LIKE '%${company}%' AND state IN ('OPEN','IN_PROGRESS','BLOCKED')`,
  );
  expect(cards, "a second identical arrival must join the card that already exists").toHaveLength(1);

  /*
   * AND THE JOIN IS RECORDED. A duplicate that is silently discarded and a duplicate that joined
   * look identical afterwards — one card either way — so the spine says which happened. Without
   * this event, a dedupe rule that had started eating real arrivals would look exactly like one
   * that was working.
   */
  const joined = queryLocalD1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM event_record
      WHERE event_type = 'work_card.duplicate_joined' AND object_id = '${cards[0]!.id}'`,
  );
  expect(Number(joined[0]!.n), "joining an existing card is recorded, not silent").toBeGreaterThan(0);

  /*
   * ── THE MIRROR, AND THE EXPENSIVE ONE ─────────────────────────────────────────────────────────
   *
   * A DIFFERENT company, same sender, same tag, same seat, same machine — everything the broken
   * rule matched on. It must get its own card.
   */
  await deliverMail(request, {
    from: `Robin Vale <robin@duplicate.example>`,
    subject: `#wpdealflow ${other}`,
    body: `Company: ${other}\n\nAnd a completely different one.`,
  });

  const second = queryLocalD1<{ id: string }>(
    `SELECT id FROM work_card WHERE title LIKE '%${other}%' AND state IN ('OPEN','IN_PROGRESS','BLOCKED')`,
  );
  expect(second, "a different company must never be absorbed into another company's card").toHaveLength(1);
  expect(second[0]!.id).not.toBe(cards[0]!.id);

  // Both are on the board, under a person's name, where somebody will actually see them.
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "Work");
  await expect(page.locator('li[data-testid^="work-card-"]').filter({ hasText: company })).toHaveCount(1);
  await expect(page.locator('li[data-testid^="work-card-"]').filter({ hasText: other })).toHaveCount(1);
});

test("reopening a decided approval supersedes it, needs a reason, and the original stays on the trail", async ({
  page,
  request,
}) => {
  const marker = `E2E-P64-${Date.now()}`;

  const created = await request.post("/api/approvals", {
    headers: MP,
    data: {
      action_key: "investment.approve",
      object_type: "canonical_company",
      object_id: `cc_${marker}`,
      title: `${marker} the decision that changes`,
      submit: true,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const cardId = ((await created.json()) as { id: string }).id;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // Decided, by a person, with a note.
  await gotoSurface(page, "Approvals");
  await page.getByTestId(`decision-note-${cardId}`).fill(`${marker}: approved on the numbers as they stood`);
  await page.getByTestId(`approve-${cardId}`).click();
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("approved");
  const originalDecisionId = (await decisionsOn(request, cardId))[0]!.id;

  /*
   * ── CHANGING IT NEEDS A REASON, AND NOTHING IS RECORDED WITHOUT ONE ───────────────────────────
   *
   * "Changing a decision needs a reason — say what changed, in a sentence. Nothing has been
   * recorded." The refusal is asserted through the state of the card rather than the wording: a
   * blank reason must leave the decision exactly where it was.
   */
  const bare = await request.post(`/api/approvals/${cardId}/reopen`, { headers: MP, data: {} });
  expect(bare.status(), await bare.text()).toBe(400);
  expect(await bare.text()).toContain("reason_required");
  expect(
    ((await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as { state: string }).state,
    "a refused reopen must not have moved the card",
  ).toBe("approved");

  // ── Reopened by a person, in the browser, on the card they already decided ───────────────────
  await page.getByTestId("approval-filter").selectOption("approved");
  await ensureOpen(page, cardId);
  await page.getByTestId(`reopen-reason-${cardId}`).fill("The valuation the approval rested on turned out to be stale");
  await page.getByTestId(`reopen-${cardId}`).click();

  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("pending_review");

  /*
   * ── SUPERSEDED, NOT EDITED ────────────────────────────────────────────────────────────────────
   *
   * The original row is untouched and still says "approved" with the note its decider wrote. The
   * new row is a SECOND decision that points at it. This is the difference between a receipt and a
   * note, and it is enforced by triggers on the table rather than by the service that happens to
   * write it.
   */
  const trail = await decisionsOn(request, cardId);
  expect(trail.length, "a reopen is a new row on the trail, never a rewrite of the old one").toBe(2);

  const original = trail.find((d) => d.id === originalDecisionId)!;
  expect(original, "the original decision is still there").toBeTruthy();
  expect(original.decision).toBe("approved");
  expect(original.note, "and still carries the words its decider used").toContain("as they stood");

  const reopened = trail.find((d) => d.id !== originalDecisionId)!;
  expect(reopened.decision).toBe("reopened");
  expect(reopened.supersedes_decision_id, "the new row names the decision it takes back").toBe(originalDecisionId);
  expect(reopened.note).toContain("stale");

  /*
   * AND A PERSON CAN SEE BOTH, with the superseded one marked as superseded rather than removed.
   * A trail that quietly drops what was taken back leaves a reader with only the current answer,
   * which is the one thing an audit trail is not for.
   */
  await page.getByTestId("approval-filter").selectOption("pending_review");
  await ensureOpen(page, cardId);
  const history = page.getByTestId(`decision-history-${cardId}`);
  await expect(history).toBeVisible();
  await expect(history, "the trail shows the decision that was taken back").toContainText("Approved");
  await expect(history, "and that it was taken back").toContainText("Took this decision back");
  await expect(
    history.getByTestId(`superseded-${originalDecisionId}`),
    "the superseded decision is marked as superseded, and kept",
  ).toBeVisible();

  // The spine carries it too, so this is auditable away from the page that did it.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-approval.reopened"]').first()).toBeVisible();

  /*
   * AND IT CAN BE DECIDED AGAIN, differently. A reopened card that could not then be re-decided
   * would be a dead end wearing an audit trail.
   */
  await gotoSurface(page, "Approvals");
  await page.getByTestId(`decision-note-${cardId}`).fill(`${marker}: rejected on the corrected valuation`);
  await page.getByTestId(`reject-${cardId}`).click();
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("rejected");

  const finalTrail = await decisionsOn(request, cardId);
  expect(finalTrail.length, "three acts happened and all three are on the record").toBe(3);
  expect(finalTrail.map((d) => d.decision)).toEqual(["approved", "reopened", "rejected"]);
});

test("an approval that has already been carried out cannot be reopened", async ({ request }) => {
  /*
   * THE LIMIT ON THE ABOVE, AND IT IS THE IMPORTANT ONE. A receipt that has been SPENT — the effect
   * executed, the position booked, the letter sent — cannot be taken back by editing the paperwork,
   * because the thing it authorised has already happened in the world. The product says so in those
   * terms rather than silently refusing.
   */
  const marker = `E2E-P64-SPENT-${Date.now()}`;
  const company = (await (
    await request.post("/api/companies", { headers: MP, data: { canonical_name: `${marker} Co` } })
  ).json()) as { id: string };
  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json()) as {
    id: string;
  };
  const cls = (await (
    await request.post("/api/security-classes", { headers: MP, data: { company_id: company.id, class_name: "Common" } })
  ).json()) as { id: string };
  const txn = (await (
    await request.post("/api/transactions", {
      headers: MP,
      data: {
        company_id: company.id,
        transaction_type: "PRIMARY_INVESTMENT",
        security_class_id: cls.id,
        quantity: 500,
        price_per_share: 2,
        transaction_date: "2026-04-01",
      },
    })
  ).json()) as { id: string };
  expect((await request.post(`/api/transactions/${txn.id}/submit`, { headers: MP, data: {} })).status()).toBe(200);

  const pending = (await (await request.get("/api/approvals?state=pending_review", { headers: MP })).json()) as {
    approvals: Array<{ id: string; object_type: string; object_id: string }>;
  };
  const cardId = pending.approvals.find((a) => a.object_type === "transaction" && a.object_id === txn.id)!.id;
  expect((await request.post(`/api/approvals/${cardId}/decide`, { headers: MP, data: { decision: "approved" } })).status()).toBe(200);
  expect(
    (
      await request.post(`/api/transactions/${txn.id}/execute`, {
        headers: MP,
        data: { approval_receipt_id: cardId, fund_id: fund.id },
      })
    ).status(),
  ).toBe(200);

  const tooLate = await request.post(`/api/approvals/${cardId}/reopen`, {
    headers: MP,
    data: { reason: "we would like to un-buy this company please" },
  });
  expect(tooLate.status(), await tooLate.text()).toBe(409);
  expect(await tooLate.text()).toContain("already_carried_out");

  // And the holding it authorised is untouched by the attempt.
  const positions = (await (await request.get(`/api/positions?company_id=${company.id}`, { headers: MP })).json()) as {
    positions: Array<{ status: string }>;
  };
  expect(positions.positions.filter((p) => p.status === "OPEN")).toHaveLength(1);
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

/**
 * Open an approval card's body, and only if it is shut.
 *
 * A card waiting on somebody opens itself (`startOpen` is true for `pending_review`) and a decided
 * one does not, so an unconditional press closes half the cards it is meant to open. The header
 * carries `aria-expanded`, which is the state itself rather than a guess at it — and it is also
 * what a screen reader is told, so asserting through it keeps the two honest with each other.
 */
async function ensureOpen(page: import("@playwright/test").Page, cardId: string): Promise<void> {
  const toggle = page.getByTestId(`approval-toggle-${cardId}`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

interface DecisionRow {
  id: string;
  decision: string;
  note: string | null;
  supersedes_decision_id: string | null;
}

async function decisionsOn(
  request: import("@playwright/test").APIRequestContext,
  cardId: string,
): Promise<DecisionRow[]> {
  const body = (await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as {
    decisions: DecisionRow[];
  };
  return body.decisions ?? [];
}
