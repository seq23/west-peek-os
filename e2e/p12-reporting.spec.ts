import { expect, test } from "@playwright/test";
import { approvalStateWords } from "@shared/help/actionNames";
import { gotoSurface } from "./support/nav";

/**
 * P12: an LP report does not ship until three people have read it, and then only behind a receipt.
 *
 * The gates: distribution refused while reviews are outstanding; refused again after finance alone;
 * APPROVED once finance, compliance and a Managing Partner have each recorded a review — and STILL
 * not sent, because sending to LPs is a reserved external communication with its own receipt. Then
 * the administrator's export disagrees with our NAV, and the disagreement becomes a visible
 * EXCEPTION showing BOTH figures rather than a correction to either.
 *
 * ── WHERE THIS NOW RUNS ─────────────────────────────────────────────────────────────────────────
 *
 * "Reporting" is no longer a destination. It folded into **LP** — "an LP is somebody who gave the
 * fund money and whom the fund owes an account of it" (App.tsx) — and the surface that came with it
 * is the half a partner actually uses: opening a period, and checking the administrator against our
 * own numbers. The PACKET machinery (submit, the three reviews, distribute, the certification
 * banner) has no interface at all: `certification-state`, `packet-distribute` and `review-FINANCE`
 * exist nowhere in `src/client/`, while every route behind them is still mounted and still governed
 * (`/api/reporting/packets/*`).
 *
 * So the review-and-receipt gates are proved through the API, the reserved decision is made by a
 * person in the browser, and the period and the reconciliation are driven on the page that now holds
 * them. The missing surface is asserted at the bottom of this file rather than quietly dropped.
 *
 * Runs fully offline: local D1 (miniflare), no credentials. The import is a FIXTURE: no live
 * administrator system is read, and none is ever written. Nothing here claims accounting,
 * valuation, or financial correctness.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P12 reporting journey: review gates → receipted distribution → reconciliation exception, no overwrite", async ({ page, request }) => {
  const marker = `E2E-P12-${Date.now()}`;

  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json()) as { id: string };

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // The period is opened on the page a partner actually has. "Q1 2026" is enough — the surface
  // derives the dates, deliberately, because typing two ISO dates to say "Q1" is the kind of small
  // tax that stops a thing being used.
  await gotoSurface(page, "LP");
  await page.getByTestId("period-fund").selectOption(fund.id);
  await page.getByTestId("period-label").fill(`${marker} Q1 2026`);
  await page.getByTestId("period-open").click();
  await expect(page.getByTestId("period-list")).toContainText(`${marker} Q1 2026`);

  const periods = (await (await request.get(`/api/reporting/periods?fund_id=${fund.id}`, { headers: MP })).json()) as {
    periods: Array<{ id: string; label: string }>;
  };
  const period = periods.periods.find((p) => p.label === `${marker} Q1 2026`)!;

  const packet = await request.post(`/api/reporting/periods/${period.id}/packets`, {
    headers: MP,
    data: { title: `${marker} Q1 letter` },
  });
  expect(packet.status(), await packet.text()).toBe(201);
  const packetId = ((await packet.json()) as { id: string }).id;

  // Nothing ships before the reviews exist, let alone before they pass.
  const recipients = [{ recipient_label: `${marker} Family Office` }];
  const tooEarly = await request.post(`/api/reporting/packets/${packetId}/distribute`, { headers: MP, data: { recipients } });
  expect(tooEarly.status()).not.toBe(200);
  expect(await tooEarly.text()).toContain("reviews_incomplete");

  const submitted = await request.post(`/api/reporting/packets/${packetId}/submit`, { headers: MP, data: {} });
  expect(submitted.status(), await submitted.text()).toBe(200);

  // Partial review is still not enough — which is the whole point of naming three reviewers.
  const review = async (role: string) =>
    request.post(`/api/reporting/packets/${packetId}/reviews`, {
      headers: MP,
      data: { review_type: role, status: "COMPLETED", note: `${marker} reviewed` },
    });
  expect((await review("FINANCE")).status()).toBe(200);
  const stillShort = await request.post(`/api/reporting/packets/${packetId}/distribute`, { headers: MP, data: { recipients } });
  expect(await stillShort.text()).toContain("reviews_incomplete");

  expect((await review("COMPLIANCE")).status()).toBe(200);
  expect((await review("MANAGING_PARTNER")).status()).toBe(200);

  const reviewed = (await (await request.get(`/api/reporting/packets/${packetId}`, { headers: MP })).json()) as {
    status: string;
    outstanding: string[];
    all_complete: boolean;
  };
  expect(reviewed.outstanding, "with all three reviews in, nothing is outstanding").toHaveLength(0);
  expect(reviewed.all_complete).toBe(true);
  expect(reviewed.status).toBe("APPROVED");

  // Reviewed is NOT sent: the reserved LP-communication receipt is a separate gate.
  const noReceipt = await request.post(`/api/reporting/packets/${packetId}/distribute`, { headers: MP, data: { recipients } });
  expect(noReceipt.status()).not.toBe(200);
  expect(await noReceipt.text()).toContain("approval_required");

  const card = (await (
    await request.post("/api/approvals", {
      headers: MP,
      data: {
        action_key: "lp_sensitive_communication.send",
        object_type: "lp_reporting_packet",
        object_id: packetId,
        title: `${marker} distribute packet`,
        submit: true,
      },
    })
  ).json()) as { id: string };

  // The decision itself is a person's, and it is made in the browser.
  await gotoSurface(page, "Approvals");
  const approvalCard = page.getByTestId(`approval-card-${card.id}`);
  await expect(approvalCard).toBeVisible();
  await expect(approvalCard).toContainText(approvalStateWords("pending_review").label);
  await approvalCard.getByTestId(`decision-note-${card.id}`).fill("reviewed by finance, compliance, and the MP — E2E");
  await approvalCard.getByTestId(`approve-${card.id}`).click();
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${card.id}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("approved");

  const distributed = await request.post(`/api/reporting/packets/${packetId}/distribute`, {
    headers: MP,
    data: { recipients, approval_receipt_id: card.id },
  });
  expect(distributed.status(), await distributed.text()).toBe(200);
  const after = (await (await request.get(`/api/reporting/packets/${packetId}`, { headers: MP })).json()) as {
    status: string;
    distribution_receipts: unknown[];
  };
  expect(after.status).toBe("DISTRIBUTED");
  // Who it went to is recorded. A distribution with no record of its recipients is a send nobody
  // can answer for later.
  expect(after.distribution_receipts.length).toBeGreaterThan(0);

  // ── Reconciliation, on the page that holds it ────────────────────────────────────────────────
  await gotoSurface(page, "LP");
  await page.getByTestId("reconciliation-fund").selectOption(fund.id);
  await page.getByTestId("admin-nav").fill("31500000");
  await page.getByTestId("our-nav").fill("31000000");
  await page.getByTestId("reconciliation-run").click();
  await expect(page.getByTestId("reconciliation-message")).toContainText("Compared");

  /*
   * THE DISCREPANCY IS AN EXCEPTION SHOWING BOTH FIGURES — never a correction to either.
   *
   * "Telling investors a figure the administrator disagrees with is the most expensive mistake
   * available on this page", and the answer to a disagreement is to show it, not to pick a side.
   */
  const exception = page.locator('li[data-testid^="exception-"]').first();
  await expect(exception).toBeVisible();
  await expect(exception).toContainText("31500000");
  await expect(exception).toContainText("31000000");
  await expect(exception).toContainText("apart");

  const exceptionId = (await exception.getAttribute("data-testid"))!.replace("exception-", "");
  const escalated = await request.post(`/api/reconciliation/exceptions/${exceptionId}/resolve`, {
    headers: MP,
    data: { resolution: "ESCALATE_TO_ADMINISTRATOR", note: `${marker}: raised with the administrator` },
  });
  // 201: the resolution is a new row against the exception, not an edit to it.
  expect(escalated.status(), await escalated.text()).toBe(201);

  // The administrator's reported figure is exactly what they reported. Nothing overwrote it.
  const exceptions = (await (await request.get("/api/reconciliation/exceptions", { headers: MP })).json()) as {
    exceptions: Array<{ id: string; administrator_value: string; internal_value: string; status: string }>;
  };
  const stored = exceptions.exceptions.find((e) => e.id === exceptionId)!;
  expect(stored.administrator_value).toBe("31500000");
  expect(stored.internal_value).toBe("31000000");
  expect(stored.status).toBe("ESCALATED");

  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-reporting.packet_distributed"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-event-reconciliation.exception_resolved"]').first()).toBeVisible();
});

/*
 * THE SURFACE THAT WAS MISSING, NOW BUILT.
 *
 * A quarterly LP letter could not be drafted, reviewed or sent from anywhere in the interface:
 * `packet-submit`, `review-record-FINANCE`, `packet-distribute` and the certification banner had
 * all gone from `src/client/` while `/api/reporting/packets/*` stayed live and enforcing all four
 * gates. The disclaimer was the worst of it — a promise made to whoever reads the numbers, being
 * made to nobody.
 *
 * The LP surface carries the letter again: drafting it, putting it in front of its three named
 * reviewers, recording each review, and sending it behind a Managing Partner's signature. The
 * certification is printed as the server states it, on first paint, whether or not any letter
 * exists — which is what this asserts, because a promise that only appears once there is something
 * to disclaim is not a promise.
 */
/*
 * TITLE NARROWED 22 Aug 2026 TO WHAT THIS ACTUALLY ASSERTS. It read "…and lets a reviewed packet be
 * sent", which no line in it proves — it opens the page and reads one sentence. The drafting, the
 * three named reviews and the send behind a partner's signature are all driven in the browser in
 * `p61-lp-raise-and-letter.spec.ts`; what is left here is the property that belongs here, and it is
 * a real one: the certification is printed on FIRST PAINT, whether or not any letter exists.
 * A promise that only appears once there is something to disclaim is a promise made to nobody,
 * which is precisely what it was for as long as no page rendered it.
 */
test("the LP surface states what it does not certify, before there is anything to disclaim", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "LP");
  await expect(page.getByTestId("certification-state")).toContainText("NO FINANCIAL, ACCOUNTING, OR VALUATION CORRECTNESS IS CERTIFIED");
});
