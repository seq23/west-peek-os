import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * THE TWO THINGS THE FIRM OWES ITS INVESTORS: an honest number, and an account of it.
 *
 * 7 · AN LP COMMITS AND THE RAISE TOTAL MOVES — and signed and soft are never summed into one
 *     number. This is the single most expensive rounding in venture. Money that is signed is
 *     banked; money that is soft is somebody's word in a meeting, and a partner who tells an
 *     anchor investor "we are at 8" when 3 of it is a maybe has said something they cannot take
 *     back. The product's rule is two figures, side by side, and a percentage computed from the
 *     signed one alone.
 *
 * 8 · A QUARTERLY LETTER IS DRAFTED, READ BY ITS THREE NAMED REVIEWERS, AND SENT BEHIND A MANAGING
 *     PARTNER'S SIGNATURE. Until 22 Aug 2026 none of that was reachable by a person: `packet-submit`,
 *     `review-record-FINANCE` and `packet-distribute` existed nowhere in `src/client/` while every
 *     route behind them stayed live and enforcing all four gates. `p12-reporting.spec.ts` proves the
 *     GATES through the API; this proves a partner can actually walk them, in the browser, which is
 *     the half that was missing and the half that was newly built.
 *
 * Runs fully offline: local D1 (miniflare), no credentials. Nothing here claims accounting,
 * valuation, LP-marketing permissibility or fund-performance correctness (AGENTS.md §Validation
 * honesty) — only that what was signed is reported as signed, and that what went out had been read.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

const TARGET = 30_000_000;
const SIGNED = 5_000_000;
const SOFT = 3_000_000;

interface FundraisingRow {
  id: string;
  target: number | null;
  signed: number;
  signed_count: number;
  soft: number;
  soft_count: number;
  percent_of_target: number | null;
}

test("an LP commits, the raise moves, and what is signed is never added to what is only promised", async ({
  page,
  request,
}) => {
  const marker = `E2E-P61-${Date.now()}`;
  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json()) as {
    id: string;
  };

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await gotoSurface(page, "LP");

  /*
   * THE TARGET IS ASKED FOR RATHER THAN ASSUMED. Until a partner says how much the fund is raising
   * there is nothing to measure the raise against, and the surface says exactly that instead of
   * drawing a bar against a number nobody chose.
   */
  const raiseCard = page.getByTestId(`fund-raise-${fund.id}`);
  await expect(raiseCard).toBeVisible();
  await expect(raiseCard).toContainText("Nobody has said yet");
  await raiseCard.getByTestId(`fund-target-${fund.id}`).fill(String(TARGET));
  await raiseCard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("lp-message")).toContainText("Saved");

  // Two investors, because one of each kind of commitment is the whole point.
  for (const name of [`${marker} Cedar Family Office`, `${marker} Ridgeline Partners`]) {
    await page.getByTestId("lp-name").fill(name);
    await page.getByTestId("lp-kind").selectOption("FAMILY_OFFICE");
    await page.getByTestId("lp-add").click();
    await expect(page.getByTestId("lp-message")).toContainText(name);
  }

  // One signed. One said yes and has not signed.
  await recordCommitment(page, fund.id, `${marker} Cedar Family Office`, SIGNED, "SIGNED");
  await recordCommitment(page, fund.id, `${marker} Ridgeline Partners`, SOFT, "SOFT");

  /*
   * ── THE RAISE MOVED, AS TWO FIGURES ──────────────────────────────────────────────────────────
   *
   * Asserted on the page a partner reads a number off before a call, and asserted NEGATIVELY too:
   * the combined figure must appear nowhere. A page that prints 8,000,000 anywhere on this card has
   * already made the mistake, whichever label happens to sit above it.
   */
  const numbers = page.getByTestId(`fund-numbers-${fund.id}`);
  await expect(numbers).toBeVisible();
  await expect(numbers).toContainText("5,000,000");
  await expect(numbers).toContainText("3,000,000");
  await expect(numbers).toContainText("30,000,000");
  await expect(numbers, "signed and soft must never be shown as one total").not.toContainText("8,000,000");
  // The two figures are told apart in words, not by position.
  await expect(numbers).toContainText("Signed");
  await expect(numbers).toContainText("Said yes, not signed");

  /*
   * AND THE PERCENTAGE IS COMPUTED FROM THE SIGNED FIGURE ALONE. 5 of 30 is 16.7%. If soft money
   * were counted it would read 26.7%, and the bar under it would be telling the same lie.
   */
  await expect(numbers).toContainText("16.7% signed");
  await expect(page.getByRole("progressbar", { name: `${marker} Fund signed against target` })).toHaveAttribute(
    "aria-valuenow",
    "16.7",
  );

  const raise = await fundraisingFor(request, fund.id);
  expect(raise.signed).toBe(SIGNED);
  expect(raise.soft).toBe(SOFT);
  expect(raise.signed_count).toBe(1);
  expect(raise.soft_count).toBe(1);
  expect(raise.percent_of_target).toBe(16.7);
  // There is no combined key to read by accident. A caller cannot add them up without meaning to.
  expect(Object.values(raise as unknown as Record<string, unknown>)).not.toContain(SIGNED + SOFT);

  /*
   * ── A COMMITMENT THAT GROWS IS A REVISION, NOT A SECOND INVESTOR ──────────────────────────────
   *
   * An LP raising their number is the ordinary case of a raise going well, and recording it twice
   * would report the fund as having twice as many investors and twice the money. The pair (LP, fund)
   * is unique, so the row is amended and the count does not move.
   */
  await recordCommitment(page, fund.id, `${marker} Cedar Family Office`, 7_000_000, "SIGNED");
  await expect(numbers).toContainText("7,000,000");
  const revised = await fundraisingFor(request, fund.id);
  expect(revised.signed).toBe(7_000_000);
  expect(revised.signed_count, "raising a commitment must not invent a second investor").toBe(1);
  expect(revised.soft, "amending a signed commitment must leave the soft figure alone").toBe(SOFT);

  /*
   * AND A COMMITMENT THAT FELL THROUGH LEAVES BOTH FIGURES. It is neither signed money nor a live
   * maybe, and quietly leaving it in either column is how a raise reports itself as healthier than
   * it is.
   */
  await recordCommitment(page, fund.id, `${marker} Ridgeline Partners`, SOFT, "WITHDRAWN");
  const afterWithdrawal = await fundraisingFor(request, fund.id);
  expect(afterWithdrawal.soft).toBe(0);
  expect(afterWithdrawal.soft_count).toBe(0);
  expect(afterWithdrawal.signed, "a withdrawal must not touch what was signed").toBe(7_000_000);
});

test("a quarterly letter is drafted, read by its three named reviewers, and sent behind a partner's signature", async ({
  page,
  request,
}) => {
  const marker = `E2E-P61-LETTER-${Date.now()}`;
  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json()) as {
    id: string;
  };

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "LP");

  // Somebody has to receive it. A letter sent to nobody proves nothing about sending.
  await page.getByTestId("lp-name").fill(`${marker} Anchor Institution`);
  await page.getByTestId("lp-kind").selectOption("INSTITUTION");
  await page.getByTestId("lp-add").click();
  await expect(page.getByTestId("lp-message")).toContainText(`${marker} Anchor Institution`);

  /*
   * THE PROMISE IS ON THE PAGE BEFORE THERE IS ANYTHING TO DISCLAIM.
   *
   * The certification is printed as the server states it, on first paint, whether or not a letter
   * exists — because a promise that only appears once there is something to qualify is a promise
   * made to nobody, which is precisely what it was for as long as no page rendered it.
   */
  await expect(page.getByTestId("certification-state")).toContainText(
    "NO FINANCIAL, ACCOUNTING, OR VALUATION CORRECTNESS IS CERTIFIED",
  );

  // The period. "Q1 2026" is enough — the dates are derived rather than typed twice.
  await page.getByTestId("period-fund").selectOption(fund.id);
  await page.getByTestId("period-label").fill(`${marker} Q1 2026`);
  await page.getByTestId("period-open").click();
  await expect(page.getByTestId("period-list")).toContainText(`${marker} Q1 2026`);

  const periodId = await periodFor(request, fund.id, `${marker} Q1 2026`);
  const periodRow = page.getByTestId(`period-${periodId}`);
  await expect(periodRow).toContainText("nothing drafted yet");

  // Draft it.
  await periodRow.getByTestId(`packet-start-${periodId}`).click();
  await periodRow.getByTestId(`packet-title-${periodId}`).fill(`${marker} Q1 investor letter`);
  await periodRow.getByTestId(`packet-draft-${periodId}`).click();
  await expect(page.getByTestId("reporting-message")).toContainText("Three people have to read it");

  const packetId = await packetFor(request, periodId);
  await periodRow.getByTestId(`packet-open-${packetId}`).click();
  const letter = page.getByTestId(`packet-${packetId}`);
  await expect(letter).toBeVisible();

  /*
   * THE REVIEWERS ARE NAMED, AND NAMED AS ROLES RATHER THAN AS A COUNT. "Three people have read it"
   * is not the same claim as "finance, compliance and a partner have read it", and only the second
   * one survives an LP asking who checked the numbers.
   */
  const reviews = letter.getByTestId(`packet-reviews-${packetId}`);
  for (const who of ["Finance", "Compliance", "A Managing Partner"]) {
    await expect(reviews).toContainText(who);
  }
  await expect(reviews, "nobody has been asked yet, and the page says so rather than showing blanks").toContainText(
    "not asked yet",
  );

  // A DRAFT CANNOT BE SENT. The control is not there to be pressed and refused.
  await expect(letter.getByTestId("packet-distribute")).toHaveCount(0);

  await letter.getByTestId("packet-submit").click();
  await expect(letter).toContainText("with its reviewers");
  // Still not sendable: being in review is not being reviewed.
  await expect(letter.getByTestId("packet-distribute")).toHaveCount(0);

  /*
   * EACH REVIEWER RECORDS THEIR OWN READ, and the letter counts down out loud. Partial review is
   * asserted in the middle rather than only at the ends, because "all three" is a rule that fails
   * quietly by accepting two.
   */
  await letter.getByTestId("review-record-FINANCE").click();
  await expect(letter).toContainText("2 of the three still to read it");
  await expect(letter.getByTestId("packet-distribute"), "one review is not three").toHaveCount(0);

  await letter.getByTestId("review-record-COMPLIANCE").click();
  await expect(letter).toContainText("1 of the three still to read it");
  await letter.getByTestId("review-record-MANAGING_PARTNER").click();
  await expect(letter).toContainText("reviewed, and cleared to go");

  /*
   * ── REVIEWED IS NOT SENT ──────────────────────────────────────────────────────────────────────
   *
   * Sending anything LP-facing is a Managing Partner's signature and never a role, so the first
   * press raises the card and says so, in words a partner can follow, rather than failing.
   */
  await letter.getByTestId("packet-distribute").click();
  await expect(letter.getByTestId(`packet-message-${packetId}`)).toContainText("waiting in Approvals");
  const sendCard = await sendCardFor(request, packetId);
  expect(sendCard, "pressing send on a reviewed letter must raise the reserved card").toBeTruthy();

  // The signature itself, made by a person on the Approvals surface.
  await gotoSurface(page, "Approvals");
  const card = page.getByTestId(`approval-card-${sendCard}`);
  await expect(card).toBeVisible();
  await card.getByTestId(`decision-note-${sendCard}`).fill(`${marker}: read by all three, cleared to go`);
  await card.getByTestId(`approve-${sendCard}`).click();
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${sendCard}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("approved");

  /*
   * AND NOW IT GOES — from the same button, after coming back the way the product told them to.
   *
   * WALKING BACK THROUGH THE NAV IS THE POINT, not an incidental detail of this spec. The message
   * above says "It is waiting in Approvals; come back and press send again once it is signed", and
   * going to Approvals unmounts this panel: the card id it was holding in component state is gone
   * by the time the partner returns. Before 22 Aug 2026 the next press therefore raised a SECOND
   * card and sent nothing — every press raised another, none was ever spent, and a reviewed letter
   * could not be sent from the browser at all. `send()` now finds the standing approved card first.
   *
   * So this asserts the send AND that no duplicate card was left behind by it.
   */
  await gotoSurface(page, "LP");
  await page.getByTestId(`period-${periodId}`).getByTestId(`packet-open-${packetId}`).click();
  const sending = page.getByTestId(`packet-${packetId}`);
  await sending.getByTestId("packet-distribute").click();
  await expect(sending.getByTestId(`packet-message-${packetId}`)).toContainText("with a receipt kept for each one");

  // WHO IT WENT TO IS RECORDED. A distribution with no record of its recipients is a send nobody
  // can answer for later.
  await expect(sending.getByTestId(`packet-sent-${packetId}`)).toContainText(`${marker} Anchor Institution`);
  await expect(sending).toContainText("sent");

  const stored = (await (await request.get(`/api/reporting/packets/${packetId}`, { headers: MP })).json()) as {
    status: string;
    distribution_receipts: unknown[];
  };
  expect(stored.status).toBe("DISTRIBUTED");
  expect(stored.distribution_receipts.length).toBeGreaterThan(0);

  // NO SECOND SIGNATURE WAS ASKED FOR. A partner returning from Approvals must not leave a trail of
  // unspent cards behind them, one for every time they looked.
  expect(
    await sendCardFor(request, packetId),
    "coming back from Approvals must spend the signature, not ask for another",
  ).toBeNull();

  // The spine carries it, so this is auditable away from the page that did it.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-reporting.packet_distributed"]').first()).toBeVisible();
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

async function recordCommitment(
  page: import("@playwright/test").Page,
  fundId: string,
  lpName: string,
  amount: number,
  state: "SIGNED" | "SOFT" | "WITHDRAWN",
): Promise<void> {
  await page.getByTestId("commitment-lp").selectOption({ label: lpName });
  await page.getByTestId("commitment-fund").selectOption(fundId);
  await page.getByTestId("commitment-amount").fill(String(amount));
  await page.getByTestId("commitment-state").selectOption(state);
  await page.getByTestId("commitment-save").click();
  await expect(page.getByTestId("lp-message")).toContainText("Recorded");
}

async function fundraisingFor(request: Ctx, fundId: string): Promise<FundraisingRow> {
  const body = (await (await request.get("/api/lp/fundraising", { headers: MP })).json()) as {
    funds: FundraisingRow[];
  };
  const row = body.funds.find((f) => f.id === fundId);
  expect(row, "the fund must appear on the fundraising summary").toBeTruthy();
  return row!;
}

async function periodFor(request: Ctx, fundId: string, label: string): Promise<string> {
  const body = (await (await request.get(`/api/reporting/periods?fund_id=${fundId}`, { headers: MP })).json()) as {
    periods: Array<{ id: string; label: string }>;
  };
  const row = body.periods.find((p) => p.label === label);
  expect(row, `the period "${label}" must have been opened`).toBeTruthy();
  return row!.id;
}

async function packetFor(request: Ctx, periodId: string): Promise<string> {
  const body = (await (await request.get("/api/reporting/packets", { headers: MP })).json()) as {
    packets: Array<{ id: string; period_id: string }>;
  };
  const row = body.packets.find((p) => p.period_id === periodId);
  expect(row, "drafting the letter must create a packet against the period").toBeTruthy();
  return row!.id;
}

/** The reserved LP-communication card raised for THIS packet — never the first one in the queue. */
async function sendCardFor(request: Ctx, packetId: string): Promise<string | null> {
  const body = (await (await request.get("/api/approvals?state=pending_review", { headers: MP })).json()) as {
    approvals: Array<{ id: string; action_key: string; object_id: string }>;
  };
  return (
    body.approvals.find((a) => a.action_key === "lp_sensitive_communication.send" && a.object_id === packetId)?.id ??
    null
  );
}
