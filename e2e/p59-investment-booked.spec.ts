import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * THE FUND ACTUALLY BUYS SOMETHING, and a `position` exists afterwards.
 *
 * This is the ladder nothing had ever walked. A `position` row — the fund's record that it owns a
 * piece of a company — is created in exactly ONE place in the entire system: inside
 * `executeTransaction` (`src/worker/services/investment.ts:1145`). Every rung below it was built,
 * authorized and unit-tested years apart from any surface, and production held zero positions, zero
 * transactions and zero security classes. Portfolio, follow-on detection, the ownership panel and
 * Company 360 are all structurally empty downstream of that, while two other surfaces separately
 * invented a portfolio out of closed opportunities — so the product could report "1 holding" and
 * "owns nothing" on the same afternoon.
 *
 * WHAT THIS PROVES, RUNG BY RUNG, AND IN THE BROWSER:
 *   a share class → a draft that commits nothing, naming the fund → submission, which raises the
 *   MP-reserved card → the explicit execute route BEFORE the decision, refused → a partner's
 *   decision on Approvals, WHICH IS THE BOOKING (Phase D, design §6, Q1: approval executes through
 *   `executeTransaction` with the card as the receipt; the "paste the receipt, press Book it" rung
 *   is gone from the page) → a position that exists, for the right quantity and the right cost
 *   basis → and a receipt that cannot be spent twice.
 *
 * THE REFUSAL IS ASSERTED BEFORE THE APPROVAL, deliberately. A booking that succeeds after a
 * decision proves the happy path; only a booking REFUSED before one proves the decision was load
 * bearing. And it is asserted by looking at `positions` — the message can be reworded, and a
 * position that exists cannot be talked out of existing.
 *
 * Runs fully offline: local D1 (miniflare), no credentials. Nothing here claims accounting,
 * valuation or fund-performance correctness (AGENTS.md §Validation honesty); it claims only that
 * what a partner approved is what got booked.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

const SHARES = 125_000;
const PRICE = 4;
/** No fees on this deal, so the cost basis is the gross — `net = gross + fees` on the buy side. */
const COST_BASIS = SHARES * PRICE;

test("a partner books an investment end to end, and the fund holds a position afterwards", async ({ page, request }) => {
  const marker = `E2E-P59-${Date.now()}`;
  const companyName = `${marker} Robotics`;

  /*
   * A FUND HAS TO EXIST, and the panel names the FIRST one on the draft rather than asking.
   *
   * `RecordInvestment` drafts with `funds[0].id` — "the partner should not have to know an id" — so
   * the fund this books against is whichever is oldest in this database, not necessarily one this
   * spec made. That is the product's behaviour and this asserts against it rather than around it:
   * read the list, create one only if the firm has none, and expect the position on whichever the
   * panel would have picked.
   */
  const fundsBefore = (await (await request.get("/api/funds", { headers: MP })).json()) as {
    funds: Array<{ id: string; name: string }>;
  };
  if (fundsBefore.funds.length === 0) {
    const made = await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund I` } });
    expect(made.status(), await made.text()).toBe(201);
  }
  const bookingFund = (
    (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: Array<{ id: string; name: string }> }
  ).funds[0]!;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // A company and a deal on it, through the ordinary door — the panel only exists inside a deal
  // record, because the fund does not buy shares in something that never entered the funnel.
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-add-toggle").click();
  await page.getByTestId("dealflow-new-name").fill(companyName);
  await page.getByTestId("dealflow-sleeve").selectOption("EARLY_STAGE_PRIMARY");
  await page.getByTestId("dealflow-stage").selectOption("IC_DECIDED");
  await page.getByTestId("dealflow-add-submit").click();
  await expect(page.getByTestId("dealflow-message")).toContainText(companyName);

  await page.getByTestId("deal-record-company").selectOption({ label: companyName });
  await expect(page.getByTestId("deal-record")).toBeVisible();
  const panel = page.getByTestId("record-investment");
  await expect(panel).toBeVisible();

  // NOTHING IS BOOKED YET, and the panel says so rather than showing a blank.
  await expect(panel).toContainText("the fund holds no position");

  // ── Rung 1: a share class. Shares are shares OF something. ──────────────────────────────────
  await panel.getByTestId("security-class-name").fill("Series A Preferred");
  await panel.getByTestId("security-class-add").click();
  await expect(panel.getByTestId("transaction-form")).toBeVisible();

  // ── Rung 2: a draft. Arithmetic, committing nothing. ────────────────────────────────────────
  await panel.getByTestId("txn-class").selectOption({ label: "Series A Preferred" });
  await panel.getByTestId("txn-type").selectOption("PRIMARY_INVESTMENT");
  await panel.getByTestId("txn-quantity").fill(String(SHARES));
  await panel.getByTestId("txn-price").fill(String(PRICE));
  await panel.getByTestId("txn-draft").click();
  await expect(panel.getByTestId("record-investment-message")).toContainText("Nothing is booked yet");

  const companyId = await companyIdFor(request, companyName);
  const txnId = await onlyTransactionFor(request, companyId);
  await expect(panel.getByTestId(`txn-status-${txnId}`)).toContainText("drafted");

  // A DRAFT BOOKS NOTHING. Asserted against the table, not against the sentence above it.
  expect(await positionsFor(request, companyId), "a draft must never create a position").toHaveLength(0);

  // The draft names the fund it will be booked to (0209) — that is what lets approval be the booking.
  const drafted = (await (await request.get(`/api/transactions/${txnId}`, { headers: MP })).json()) as { fund_id: string | null; vehicle: string | null };
  expect(drafted.fund_id, "the panel's draft names the fund").toBe(bookingFund.id);
  expect(drafted.vehicle, "the panel's draft names the vehicle").toBe("Fund I direct");

  // ── Rung 3: submission, which raises the reserved card. ─────────────────────────────────────
  await panel.getByTestId(`txn-submit-${txnId}`).click();
  await expect(panel.getByTestId(`txn-status-${txnId}`)).toContainText("waiting on a partner");
  await expect(panel.getByTestId(`txn-pending-${txnId}`)).toContainText("Approving it books the position");

  /*
   * The card is found BY THE TRANSACTION it was raised about. Every spec in this suite drives the
   * same local D1, so `investment.approve` matched by action key alone would eventually be another
   * journey's card — p6 raises one too.
   */
  await expect
    .poll(async () => await reservedCardFor(request, txnId), {
      message: "submitting must raise the MP-reserved approval card for THIS transaction",
    })
    .not.toBeNull();
  const cardId = (await reservedCardFor(request, txnId))!;

  /*
   * ── THE REFUSAL, BEFORE ANYBODY HAS DECIDED ──────────────────────────────────────────────────
   *
   * The page no longer offers an execute button — approval is the booking — so the refusal is
   * pressed on the route itself. The receipt id is real and it names the right card; the card
   * simply has not been approved yet. `verifyAuthorizationReceipt` requires state `approved`, so
   * this is refused — and the property being proved is not the wording of the refusal but that
   * NOTHING WAS BOOKED by it. The page has no such control at all: asserted, so the rung cannot
   * grow back unnoticed.
   */
  await expect(panel.getByTestId(`txn-execute-${txnId}`), "the receipt-paste rung is gone from the page").toHaveCount(0);
  const early = await request.post(`/api/transactions/${txnId}/execute`, { headers: MP, data: { approval_receipt_id: cardId } });
  expect(early.status(), await early.text()).toBe(409);
  expect(
    await positionsFor(request, companyId),
    "an undecided card must not book a position, however real its id looks",
  ).toHaveLength(0);

  // ── Rung 4, WHICH IS THE LAST: a partner decides it, personally, on Approvals — and that books it. ──
  await gotoSurface(page, "Approvals");
  const card = page.getByTestId(`approval-card-${cardId}`);
  await expect(card).toBeVisible();
  await expect(card, "the card says what approving it does").toContainText("Approving books the position");
  await card.getByTestId(`decision-note-${cardId}`).fill(`${marker}: committee approved, terms as drafted`);
  await card.getByTestId(`approve-${cardId}`).click();
  // `executed`, not `approved`: the booking consumed the card the moment the partner said yes.
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as { state: string }).state, {
      message: "approving must execute the booking, which consumes the card",
    })
    .toBe("executed");

  await gotoSurface(page, "Dealflow");
  await page.getByTestId("deal-record-company").selectOption({ label: companyName });
  const booked = page.getByTestId("record-investment");
  await expect(booked.getByTestId(`txn-status-${txnId}`)).toContainText("booked");

  /*
   * A POSITION EXISTS. One row, for the shares the partner approved, against the fund the panel
   * books to — and its cost basis is the transaction's net amount rather than a number typed twice.
   */
  const positions = await positionsFor(request, companyId);
  expect(positions, "executing is what creates a position, and it must have").toHaveLength(1);
  expect(positions[0]!.quantity).toBe(SHARES);
  expect(positions[0]!.cost_basis).toBe(COST_BASIS);
  expect(positions[0]!.status).toBe("OPEN");
  expect(positions[0]!.fund_id, "the position belongs to the fund the panel booked it against").toBe(bookingFund.id);
  expect(positions[0]!.acquired_via_transaction_id, "a position names the transaction that made it").toBe(txnId);

  // THE RECEIPT IS SPENT. A second execution with the same card is refused, so an approval is a
  // single decision rather than a standing licence.
  const replay = await request.post(`/api/transactions/${txnId}/execute`, {
    headers: MP,
    data: { approval_receipt_id: cardId, fund_id: bookingFund.id },
  });
  expect(replay.status(), await replay.text()).toBe(409);
  expect(await positionsFor(request, companyId), "a refused replay must not double the holding").toHaveLength(1);

  // The spine carries both halves as typed events — the decision and the effect it authorized.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-investment.transaction_executed"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-investment.position_opened"]').first()).toBeVisible();

  /*
   * ── RUNG 6: AND THERE IS A WAY BACK, on the same screen. ─────────────────────────────────────
   *
   * `POST /api/transactions/:id/void` was live, governed and correct — MP-reserved, receipt-gated,
   * and it REVERSES the position rather than deleting it — and nothing in `src/client` ever called
   * it. The only mention of voiding anywhere in the product was a past-tense line on the activity
   * feed describing something no control could cause. Same defect as the missing "Book it" rung
   * this file was written for, one step further along and worse: a booking is a mistake somebody
   * notices AFTER the fund's own records say it owns something.
   *
   * Asserted HERE rather than in a test of its own, because the control must appear exactly when
   * there is something to undo. A standalone test on a fresh firm proved only that a button was
   * absent from a screen with nothing booked on it, which is correct behaviour.
   */
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("deal-record-company").selectOption({ label: companyName });
  const panelAfter = page.getByTestId("record-investment");
  const undo = panelAfter.getByTestId(`txn-void-${txnId}`);
  await expect(undo, "a booking must be reversible from the screen that made it").toBeVisible();
  // It says what it does. "Void" is the record's word; the partner is undoing a booking, and the
  // difference between reversing a position and deleting a row is the thing to be plain about.
  await expect(undo).toContainText("Undo this booking");
});

test("a booked deal cannot have its record quietly removed, and voiding it reverses the holding", async ({ request }) => {
  /*
   * THE OTHER DIRECTION, WHICH IS WHERE MONEY GOES MISSING.
   *
   * Archiving is for a row that should not exist — a duplicate, a typo. Once the fund has actually
   * bought something the record is not a mistake, and removing it would leave a position pointing
   * at a deal nobody can find. Undoing a real booking is a second reserved decision, not an edit.
   */
  const marker = `E2E-P59-VOID-${Date.now()}`;
  const company = (await (
    await request.post("/api/companies", { headers: MP, data: { canonical_name: `${marker} Co` } })
  ).json()) as { id: string };
  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json()) as {
    id: string;
  };
  const opportunity = (await (
    await request.post("/api/opportunities", {
      headers: MP,
      data: { company_id: company.id, opportunity_type: "EARLY_STAGE_PRIMARY", title: `${marker} deal` },
    })
  ).json()) as { id: string };
  const cls = (await (
    await request.post("/api/security-classes", { headers: MP, data: { company_id: company.id, class_name: "Common" } })
  ).json()) as { id: string };
  const txn = (await (
    await request.post("/api/transactions", {
      headers: MP,
      data: {
        company_id: company.id,
        opportunity_id: opportunity.id,
        transaction_type: "PRIMARY_INVESTMENT",
        security_class_id: cls.id,
        quantity: 1000,
        price_per_share: 10,
        transaction_date: "2026-03-01",
      },
    })
  ).json()) as { id: string };

  expect((await request.post(`/api/transactions/${txn.id}/submit`, { headers: MP, data: {} })).status()).toBe(200);
  const cardId = (await reservedCardFor(request, txn.id))!;
  expect(cardId, "submission raises the reserved card").toBeTruthy();
  // This draft named no fund (the older API shape), so approval decides it and does not book it:
  // the explicit route books it with the fund named. Both shapes are pinned in tests/portfolioBooking.test.ts.
  expect(
    (await request.post(`/api/approvals/${cardId}/decide`, { headers: MP, data: { decision: "approved" } })).status(),
  ).toBe(200);
  expect(await positionsFor(request, company.id), "a draft with no fund is approved, not booked").toHaveLength(0);
  const executed = await request.post(`/api/transactions/${txn.id}/execute`, {
    headers: MP,
    data: { approval_receipt_id: cardId, fund_id: fund.id },
  });
  expect(executed.status(), await executed.text()).toBe(200);
  expect(await positionsFor(request, company.id)).toHaveLength(1);

  /*
   * ARCHIVING IS REFUSED WHILE THE FUND HOLDS IT. This is the one that would cost real money: the
   * deal record disappears from the board and the position stays on the books, pointing at nothing.
   */
  const archived = await request.post(`/api/opportunities/${opportunity.id}/archive`, {
    headers: MP,
    data: { reason: "tidying up the board" },
  });
  expect(archived.status(), await archived.text()).toBe(409);
  expect(await archived.text()).toContain("has_booked_transactions");

  // Undoing it is a SECOND reserved decision, with its own card and its own receipt.
  const voidNoReceipt = await request.post(`/api/transactions/${txn.id}/void`, { headers: MP, data: {} });
  expect(voidNoReceipt.status(), await voidNoReceipt.text()).toBe(409);

  const voidCard = (await (
    await request.post("/api/approvals", {
      headers: MP,
      data: {
        action_key: "transaction.void",
        object_type: "transaction",
        object_id: txn.id,
        title: `${marker} void the booking`,
        submit: true,
      },
    })
  ).json()) as { id: string };
  expect(
    (await request.post(`/api/approvals/${voidCard.id}/decide`, { headers: MP, data: { decision: "approved" } })).status(),
  ).toBe(200);
  const voided = await request.post(`/api/transactions/${txn.id}/void`, {
    headers: MP,
    data: { approval_receipt_id: voidCard.id },
  });
  expect(voided.status(), await voided.text()).toBe(200);

  /*
   * THE HOLDING IS REVERSED, AND THE ROW IS NOT DESTROYED. `position` keeps its history — the
   * quantity goes to zero and the row closes — because a holding that vanishes leaves no trail of
   * having existed, and the transaction stays readable as VOID.
   */
  const after = await positionsFor(request, company.id);
  expect(after, "the position row survives the reversal").toHaveLength(1);
  expect(after[0]!.quantity).toBe(0);
  expect(after[0]!.status).toBe("CLOSED");
  const finalTxn = (await (await request.get(`/api/transactions/${txn.id}`, { headers: MP })).json()) as {
    status: string;
  };
  expect(finalTxn.status).toBe("VOID");
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

interface PositionRow {
  id: string;
  fund_id: string;
  quantity: number;
  cost_basis: number;
  status: string;
  acquired_via_transaction_id: string | null;
}

async function positionsFor(request: Ctx, companyId: string): Promise<PositionRow[]> {
  const body = (await (await request.get(`/api/positions?company_id=${companyId}`, { headers: MP })).json()) as {
    positions: PositionRow[];
  };
  return body.positions;
}

async function companyIdFor(request: Ctx, canonicalName: string): Promise<string> {
  const body = (await (await request.get("/api/companies", { headers: MP })).json()) as {
    companies: Array<{ id: string; canonical_name: string }>;
  };
  const found = body.companies.find((c) => c.canonical_name === canonicalName);
  expect(found, `the company "${canonicalName}" must exist before a transaction can name it`).toBeTruthy();
  return found!.id;
}

async function onlyTransactionFor(request: Ctx, companyId: string): Promise<string> {
  const body = (await (await request.get(`/api/transactions?company_id=${companyId}`, { headers: MP })).json()) as {
    transactions: Array<{ id: string }>;
  };
  expect(body.transactions, "the draft must be the only transaction on this company").toHaveLength(1);
  return body.transactions[0]!.id;
}

/** The MP-reserved card raised for THIS transaction, never "the first one of its kind". */
async function reservedCardFor(request: Ctx, txnId: string): Promise<string | null> {
  const body = (await (await request.get("/api/approvals?state=pending_review", { headers: MP })).json()) as {
    approvals: Array<{ id: string; object_type: string; object_id: string }>;
  };
  return body.approvals.find((a) => a.object_type === "transaction" && a.object_id === txnId)?.id ?? null;
}
