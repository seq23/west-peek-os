import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1, queryLocalD1 } from "./support/provision";

/**
 * TWO JOURNEYS THAT ONLY EXIST ONCE SOMETHING REAL IS ON THE BOOKS.
 *
 * 6 · A FOLLOW-ON CANDIDATE IS DETECTED, A REVIEW IS OPENED, A PARTNER DECIDES IT. "Pulling ahead"
 *     is a stated rule and not a model's opinion — a position the fund actually holds, and a metric
 *     that improved against its own previous reading. Every part of that is downstream of a booked
 *     position, which is why this could never have worked while production held zero of them: the
 *     candidate list was structurally empty and read as "nothing is going well".
 *
 * 10 · AN EMPLOYEE IS EMPLOYED, IS GIVEN A CARD, WORKS IT, AND THE RUN IS ATTRIBUTED TO THEM AND TO
 *     A MACHINE. The attribution is the point. Sixty-four runs had happened and $0.31 had been
 *     spent, and the Machines page showed 0 runs and $0.0000 against all forty-five machines:
 *     `ai_run_attribution.machine_id` was NULL in every row, because the one caller that ever set it
 *     was a flow nobody used. Every number on that page was reporting the truth about an empty
 *     column, and the operator's reading was that the tab "tells me nothing".
 *
 * Runs fully offline: local D1 (miniflare), no credentials. The employee's actual work is a model
 * call and routes to the deterministic `mock-local` model here, so what the employee CONCLUDED is
 * not claimed — what is claimed is that the run happened, under their name, against their machine.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

/** A seat no other spec drives, put back to unemployed so this journey has somebody to employ. */
const SEAT = { id: "aie_pippa", name: "Pippa", machineKey: "marketing_pr_content" };

test("a company pulling ahead becomes a follow-on candidate, a review, and a partner's decision", async ({
  page,
  request,
}) => {
  const marker = `E2E-P63-${Date.now()}`;

  // ── A position the fund actually holds. Nothing about follow-on means anything without one. ──
  const company = (await (
    await request.post("/api/companies", { headers: MP, data: { canonical_name: `${marker} Co` } })
  ).json()) as { id: string };
  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund` } })).json()) as {
    id: string;
  };
  const positionId = await bookAPosition(request, company.id, fund.id, marker);
  expect(positionId, "the candidate rule reads open positions; there has to be one").toBeTruthy();

  /*
   * ── AND A METRIC THAT IMPROVED AGAINST ITS OWN PREVIOUS READING ──────────────────────────────
   *
   * Two readings, not one. A single number is a fact about a company; the SECOND one is the only
   * thing that can say it is pulling ahead, and the rule is written that way on purpose so nobody
   * has to guess what the list meant.
   */
  const metricKey = `arr_${Date.now()}`;
  expect(
    (
      await request.post("/api/portfolio/metric-definitions", {
        headers: MP,
        data: { metric_key: metricKey, name: `${marker} ARR`, direction: "HIGHER_IS_BETTER", unit: "USD" },
      })
    ).status(),
  ).toBe(201);
  for (const [as_of_date, value] of [
    ["2026-01-31", 1_000_000],
    ["2026-02-28", 1_800_000],
  ] as const) {
    const snap = await request.post("/api/portfolio/snapshots", {
      headers: MP,
      data: { company_id: company.id, metric_key: metricKey, as_of_date, value, source: `${marker} founder update` },
    });
    expect(snap.status(), await snap.text()).toBe(201);
  }

  const centre = (await (await request.get("/api/follow-on", { headers: MP })).json()) as {
    candidates: Array<{ company_id: string; metric_key: string; latest_value: number; previous_value: number }>;
    candidate_rule: string;
  };
  const candidate = centre.candidates.find((c) => c.company_id === company.id);
  expect(candidate, "an open position plus a rising metric is exactly what the published rule says").toBeTruthy();
  expect(candidate!.previous_value).toBe(1_000_000);
  expect(candidate!.latest_value).toBe(1_800_000);

  // On the page, with the rule printed beside it — nobody has to guess what "pulling ahead" meant.
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  // THE CANDIDATE IS WHERE THE COMPANY IS (19 Sep 2026, design/FUND_STRATEGY_DESIGN.md §2): Portfolio's
  // "Pulling ahead" panel names it and opens the review; the review then sits on Fund strategy's
  // reserves band beside the headroom it draws on.
  await gotoSurface(page, "Portfolio");
  await expect(page.getByTestId("follow-on-rule")).toContainText("higher than the previous reading");
  await expect(page.getByTestId(`follow-on-candidate-${company.id}`)).toContainText(`${marker} Co`);

  /*
   * ── A REVIEW IS OPENED, AGAINST A SCENARIO THAT PINS THE POLICY IT WAS JUDGED UNDER ──────────
   *
   * A follow-on review is not "shall we put more in" in the abstract; it is that question against
   * the reserve and concentration policy AS THEY STOOD. Pinning the versions is what makes the
   * decision re-readable in two years, when the policy has moved on.
   */
  const scenarioId = await openScenario(request, fund.id, marker);
  const review = await request.post(`/api/allocation/scenarios/${scenarioId}/follow-on-reviews`, {
    headers: MP,
    data: {
      company_id: company.id,
      position_id: positionId,
      path: {
        currentOwnershipPct: 12,
        currentFullyDilutedShares: 10_000_000,
        roundSize: 20_000_000,
        primaryPps: 5,
        secondaryPps: 4.5,
        secondaryCapital: 0,
        secondaryFeesPct: 0,
        targetOwnershipPct: 12,
        maxAllocation: 3_000_000,
        extraDilutionPct: 0,
        futureDilutionPct: 20,
        exitValue: 500_000_000,
        holdYears: 5,
        existingCost: 500_000,
        fundSize: 30_000_000,
      },
    },
  });
  expect(review.status(), await review.text()).toBe(201);
  const reviewId = ((await review.json()) as { id: string }).id;

  /*
   * IT IS WAITING ON A PARTNER, AND THE PAGE SAYS SO.
   *
   * This is the assertion the product could not have passed this morning: `pending_count` filtered
   * on the string "PENDING", which `follow_on_review.status` cannot hold — the column's CHECK is
   * ('OPEN','REVIEWED','CLOSED'). So the count was permanently zero, the "N pending" badge could
   * never render, and an undecided review was painted with the same good-news tag as a finished
   * one. A decision nobody has made must not read as settled.
   */
  await page.reload();
  await gotoSurface(page, "Fund strategy");
  const row = page.getByTestId(`follow-on-review-${reviewId}`);
  await expect(row).toContainText(`${marker} Co`);
  await expect(row, "an undecided review says it is waiting on a partner, never 'reviewed'").toContainText("waiting on a partner");
  await expect(row).not.toContainText("reviewed");
  await expect(page.getByTestId("fund-reserves-pending"), "and it is counted where a partner looks — the band's own pill").toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId("fund-reserves")).toContainText(/review(s)? waiting on a partner/);

  // ── A PARTNER DECIDES IT, and the note they leave IS the decision. ───────────────────────────
  const decided = await request.post(`/api/allocation/follow-on-reviews/${reviewId}/review`, {
    headers: MP,
    data: { review_note: `${marker}: pro-rata only, reserve draw accepted at the pinned concentration limit` },
  });
  expect(decided.status(), await decided.text()).toBe(200);

  // A second decision on the same review is refused: a review is decided once, not amended.
  const again = await request.post(`/api/allocation/follow-on-reviews/${reviewId}/review`, {
    headers: MP,
    data: { review_note: "on reflection, more" },
  });
  expect(again.status(), await again.text()).toBe(409);
  expect(await again.text()).toContain("already_reviewed");

  await page.reload();
  await gotoSurface(page, "Fund strategy");
  const settled = page.getByTestId(`follow-on-review-${reviewId}`);
  await expect(settled).toContainText("reviewed");
  await expect(settled, "the partner's own words are the record of what was decided").toContainText("pro-rata only");
});

/*
 * THE OTHER HALF OF THE FOLLOW-ON JOURNEY, AND IT HAS NO SURFACE.
 *
 * The journey above opens the review through `POST /api/allocation/scenarios/:id/follow-on-reviews`,
 * because that is the only way in: `FollowOnPage` LISTS reviews and candidates and offers no control
 * to open one, and nothing anywhere else in `src/client` posts to that route. So the product can
 * tell a partner "Sensori is pulling ahead" and give her nowhere to press.
 *
 * The gap was the join, not the machinery: detection worked, the review worked, the decision
 * worked, and a person could not get from the first to the second.
 *
 * FIXED 23 Aug 2026. The candidate row carries the control, and the position it is a follow-on TO
 * now travels with the candidate so the shares and cost are taken from the record rather than
 * retyped. It is a FORM and not a button on purpose: the review IS the economics — the route
 * computes and stores a modelled path — so a one-press version would have had to invent a round
 * size, which is exactly the fabricated-inputs defect that had Fund strategy answering against a
 * fund the firm does not have.
 */
test("a partner can open a follow-on review from the candidate that prompted it", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "Portfolio");
  await expect(page.getByTestId("follow-on-rule")).toBeVisible();

  const candidates = page.locator('[data-testid^="follow-on-candidate-"]');
  if ((await candidates.count()) === 0) {
    /*
     * NO CANDIDATE IS A REAL STATE, and it is asserted rather than skipped. The rule is "an open
     * position whose latest metric beat its previous reading" — deliberately narrow, so an empty
     * list is the common case and must say so rather than showing a bare gap.
     */
    await expect(page.getByTestId("follow-on-candidates-empty")).toBeVisible();
    return;
  }

  const opener = page.locator('[data-testid^="follow-on-open-review-"]').first();
  await expect(
    opener,
    "a company pulling ahead must be openable into a review from the page that named it",
  ).toBeVisible();
  await opener.click();

  // The form says what it already knows before it asks for anything, and will not submit on
  // invented figures — the guard against the defect that made Fund strategy model a fund the firm
  // does not have.
  const form = page.locator('[data-testid^="follow-on-form-"]').first();
  await expect(form).toBeVisible();
  await expect(form).toContainText("shares the fund already");
  await expect(page.locator('[data-testid^="follow-on-submit-"]').first()).toBeDisabled();
});

test("an employee is employed, given a card, works it — and the run is attributed to them and a machine", async ({
  page,
  request,
}) => {
  const marker = `E2E-P63-WORK-${Date.now()}`;

  /*
   * THE SEAT IS PUT BACK TO UNEMPLOYED FIRST, and it has to be. Migration 0136 employed the whole
   * roster on the partners' direction, so nothing on the seeded roster is INACTIVE and this journey
   * would have nobody to hire — the same silent skip `p28-activation-chain.spec.ts` was written to
   * stop. One seat, chosen because no other spec drives it.
   */
  provisionLocalD1(`UPDATE ai_employee SET status = 'INACTIVE' WHERE id = '${SEAT.id}';`);

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await gotoSurface(page, "Employees");
  await expect(page.getByTestId(`employee-card-${SEAT.id}`)).toHaveAttribute("data-status", "INACTIVE");

  /*
   * ── EMPLOYED, THROUGH THE SCREEN, AT EVERY RUNG ──────────────────────────────────────────────
   *
   * Driven in the browser rather than through `request`, deliberately. An API-only version of this
   * passes over a chain with no interface at all — which is exactly what happened here once before:
   * `request-activation` and `activate` were both live and correct, Approvals could approve the
   * card, and NOTHING in `src/client` ever called the last one. The approved receipt sat unspent,
   * the employee stayed INACTIVE for ever, and no error anywhere explained why. A test that proves
   * the machine works is not a test that proves anybody can reach it.
   */
  await openRecord(page, SEAT.id);
  await page.getByTestId(`employee-request-activation-${SEAT.id}`).click();
  await expect(page.getByTestId(`employee-detail-${SEAT.id}`)).toContainText("Managing Partner must approve");

  const card = await cardFor(request, SEAT.id);
  expect(card, "asking for an employee must raise the reserved activation card").toBeTruthy();

  await gotoSurface(page, "Approvals");
  await page.getByTestId(`decision-note-${card!.id}`).fill(`${marker}: approved`);
  await page.getByTestId(`approve-${card!.id}`).click();
  await expect
    .poll(async () => ((await (await request.get(`/api/approvals/${card!.id}`, { headers: MP })).json()) as { state: string }).state)
    .toBe("approved");

  /*
   * AND THE LAST RUNG, PRESSED. The control appears only once an approved receipt exists — which is
   * the property that makes it a completion step rather than a switch.
   */
  await page.reload();
  await gotoSurface(page, "Employees");
  /*
   * OPEN THE RECORD, AND WAIT FOR IT TO BE OPEN.
   *
   * The completion control lives inside the detail panel and the panel is a toggle, so a click that
   * lands before the roster has painted opens nothing and the control is simply absent — which
   * reads as "the button is missing" and is really "the record never opened". Asserting the panel
   * first separates those two, and they need different fixes.
   */
  await openRecord(page, SEAT.id);
  const activate = page.getByTestId(`employee-activate-${SEAT.id}`);
  await expect(activate).toBeVisible();
  await activate.click();
  await expect(page.getByTestId(`employee-detail-${SEAT.id}`)).toContainText("ACTIVE");
  await expect(page.getByTestId(`employee-card-${SEAT.id}`)).toHaveAttribute("data-status", "ACTIVE");

  // ── Given a card, by name, on the machine they sit on ────────────────────────────────────────
  const made = await request.post("/api/work-cards", {
    headers: MP,
    data: {
      title: `${marker}: draft the quarterly note for the website`,
      next_action: "Write a first draft and say what is still missing.",
      owner_type: "AI",
      owner_id: SEAT.id,
      machine_id: machineIdFor(SEAT.machineKey),
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const cardId = ((await made.json()) as { id: string }).id;

  await gotoSurface(page, "Work");
  const board = page.locator('li[data-testid^="work-card-"]').filter({ hasText: `${marker}: draft the quarterly note` }).first();
  await expect(board, "a card handed to an employee is on the board under their name").toBeVisible();
  await expect(board).toContainText(SEAT.name);

  /*
   * ── AND THEY WORK IT ─────────────────────────────────────────────────────────────────────────
   *
   * WHERE THIS STOPS. Working a card is a model call, and under local `wrangler dev` there is no
   * provider credential and privacy mode is LOCKDOWN, so `run_ai` takes the deterministic
   * `mock-local` model, which answers with a fixed sentence rather than a draft. What the employee
   * CONCLUDED is therefore not asserted and is not claimed. What is asserted is everything around
   * it, which is the part that was broken: a run happened, it was theirs, and the money came out of
   * a named machine's line rather than out of nobody's.
   */
  const worked = await request.post(`/api/work-cards/${cardId}/work`, { headers: MP, data: {} });
  expect(worked.status(), await worked.text()).toBe(200);
  const outcome = (await worked.json()) as { steps: Array<{ step: number }>; detail: string };
  expect(outcome.steps.length, `the employee must actually take a step: ${outcome.detail}`).toBeGreaterThan(0);

  /*
   * ATTRIBUTED TO THE PERSON AND TO THE MACHINE. Read from the cost centre, which is the same
   * aggregate the Machines page draws — so this fails if either half of the attribution is null,
   * which is exactly the state that made every number on that page a zero.
   */
  const cost = (await (await request.get("/api/ai/cost", { headers: MP })).json()) as {
    by_employee: Array<{ key: string | null; runs: number }>;
    by_machine: Array<{ key: string | null; runs: number }>;
  };
  const theirs = cost.by_employee.find((e) => e.key === SEAT.id);
  expect(theirs, `the run must be attributed to ${SEAT.name}, not to nobody`).toBeTruthy();
  expect(theirs!.runs).toBeGreaterThan(0);

  const machineId = String(machineIdFor(SEAT.machineKey));
  const onMachine = cost.by_machine.find((m) => m.key === machineId);
  expect(onMachine, "and to the machine they sit on — the column that was NULL in all 64 rows").toBeTruthy();
  expect(onMachine!.runs).toBeGreaterThan(0);

  // The same fact, on the page the operator said told her nothing: this machine has run something.
  await gotoSurface(page, "Machines");
  await expect(page.getByTestId(`machine-row-${machineId}`)).toBeVisible();
  await expect(
    page.getByTestId(`machine-row-${machineId}`),
    "the run count on this machine must no longer be zero",
  ).not.toContainText("0 / 0");

  // The run itself names them, so the attribution is not only an aggregate.
  const runs = (await (await request.get("/api/ai/runs", { headers: MP })).json()) as {
    runs: Array<{ purpose: string; employee_name?: string | null }>;
  };
  expect(runs.runs.some((r) => r.purpose.includes(SEAT.name)), "the run's own purpose names who did the work").toBe(true);
});

test("a retired employee's work still resolves, and reads as retired", async ({ page, request }) => {
  /*
   * AN EDGE CASE THAT HAS ALREADY BITTEN. A seat is retired and everything that seat ever did is
   * still on the books: runs, cards, deliverables. If a retired employee's rows stopped resolving,
   * the firm would lose the authorship of finished work — and `deliverable.prepared_by` is
   * deliberately a plain name and not a foreign key for exactly that reason: "an employee can
   * retire, and a deliverable they prepared still says they prepared it".
   *
   * This runs AFTER the journey above, on the same seat, so there is real work to lose.
   */
  const before = queryLocalD1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM work_card WHERE owner_id = '${SEAT.id}'`,
  );
  expect(Number(before[0]!.n), "this needs the seat to have done something first").toBeGreaterThan(0);

  /*
   * RETIRED FROM THE LOUNGE, not through the API. The lifecycle controls "only lower authority, so
   * they fail safe" — and a control that lowers authority is precisely the one an operator must be
   * able to reach in a hurry.
   */
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "Employees");
  await openRecord(page, SEAT.id);
  await page.getByTestId(`employee-lifecycle-retired-${SEAT.id}`).click();
  await expect(page.getByTestId(`employee-detail-${SEAT.id}`)).toContainText("Now RETIRED");

  try {
    // The record still answers, and it answers "retired" rather than 404.
    const seat = await request.get(`/api/workforce/employees/${SEAT.id}`, { headers: MP });
    expect(seat.status(), await seat.text()).toBe(200);
    expect(JSON.stringify(await seat.json())).toContain("RETIRED");

    /*
     * THEIR CARDS STILL SAY WHOSE THEY WERE. A board that stopped naming the owner of a retired
     * seat's card would leave work with no author at all.
     */
    // Read from the board's own query rather than the raw row list: `owner_name` is the JOIN, and
    // the JOIN is the thing that has to keep resolving after a seat is retired.
    const cards = (await (await request.get("/api/work-cards/by-owner", { headers: MP })).json()) as {
      cards: Array<{ owner_id: string | null; owner_name: string | null }>;
    };
    const theirs = cards.cards.filter((c) => c.owner_id === SEAT.id);
    expect(theirs.length, "their cards are still on the board").toBeGreaterThan(0);
    expect(theirs[0]!.owner_name, "and still resolve to their name").toBe(SEAT.name);

    await page.reload();
    await gotoSurface(page, "Employees");

    /*
     * AND THEY READ AS RETIRED, in a place a person can find. A retired seat leaves the everyday
     * grid — it is not somebody you can hand work to — and lands in "Former employees", which is
     * the difference between retiring somebody and deleting them.
     */
    await expect(page.getByTestId(`employee-card-${SEAT.id}`), "a retired seat is off the working grid").toHaveCount(0);
    await page.getByTestId("lounge-retired").locator("summary").first().click();
    await expect(page.getByTestId(`retired-${SEAT.id}`)).toContainText(SEAT.name);

    // Switching them back on is not a toggle. It was a deliberate decision and it is undone
    // deliberately — a retired seat returns INACTIVE and still needs a partner to activate it.
    const back = await request.post(`/api/workforce/${SEAT.id}/unretire`, {
      headers: MP,
      data: { reason: "E2E-P63: we need the seat again" },
    });
    expect(back.status(), await back.text()).toBe(200);
    expect(((await back.json()) as { status: string }).status, "coming back is not the same as being switched on").toBe(
      "INACTIVE",
    );
  } finally {
    // Leave the roster as this suite found it: employed, like every other seat after migration 0136.
    provisionLocalD1(`UPDATE ai_employee SET status = 'ACTIVE' WHERE id = '${SEAT.id}';`);
  }
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

/**
 * Open one employee's record and wait until it is open.
 *
 * The roster is a grid of toggles: pressing one that is already open CLOSES it, and pressing before
 * the grid has painted does nothing at all. Both failures look identical afterwards — a missing
 * control — so this presses only when the panel is shut and then proves it opened.
 */
async function openRecord(page: import("@playwright/test").Page, employeeId: string): Promise<void> {
  const detail = page.getByTestId(`employee-detail-${employeeId}`);
  if (await detail.isVisible().catch(() => false)) return;
  await page.getByTestId(`employee-open-${employeeId}`).click();
  await expect(detail).toBeVisible();
}

/** The reserved activation card raised for THIS seat — never "the first one of its kind". */
async function cardFor(request: Ctx, employeeId: string): Promise<{ id: string } | null> {
  const body = (await (await request.get("/api/approvals?state=pending_review", { headers: MP })).json()) as {
    approvals: Array<{ id: string; action_key: string; object_id: string }>;
  };
  return body.approvals.find((a) => a.action_key === "ai_employee.activate" && a.object_id === employeeId) ?? null;
}

function machineIdFor(key: string): number {
  const rows = queryLocalD1<{ id: number }>(`SELECT id FROM machine WHERE key = '${key}'`);
  expect(rows[0], `the machine "${key}" must exist in the registry`).toBeTruthy();
  return Number(rows[0]!.id);
}

/** Walk the booking ladder far enough to leave one OPEN position on the books. */
async function bookAPosition(request: Ctx, companyId: string, fundId: string, marker: string): Promise<string> {
  const cls = (await (
    await request.post("/api/security-classes", { headers: MP, data: { company_id: companyId, class_name: "Seed Preferred" } })
  ).json()) as { id: string };
  const txn = (await (
    await request.post("/api/transactions", {
      headers: MP,
      data: {
        company_id: companyId,
        transaction_type: "PRIMARY_INVESTMENT",
        security_class_id: cls.id,
        quantity: 100_000,
        price_per_share: 5,
        transaction_date: "2026-01-15",
      },
    })
  ).json()) as { id: string };
  expect((await request.post(`/api/transactions/${txn.id}/submit`, { headers: MP, data: {} })).status()).toBe(200);

  const pending = (await (await request.get("/api/approvals?state=pending_review", { headers: MP })).json()) as {
    approvals: Array<{ id: string; object_type: string; object_id: string }>;
  };
  const cardId = pending.approvals.find((a) => a.object_type === "transaction" && a.object_id === txn.id)!.id;
  expect(
    (await request.post(`/api/approvals/${cardId}/decide`, { headers: MP, data: { decision: "approved", note: marker } })).status(),
  ).toBe(200);
  const executed = await request.post(`/api/transactions/${txn.id}/execute`, {
    headers: MP,
    data: { approval_receipt_id: cardId, fund_id: fundId },
  });
  expect(executed.status(), await executed.text()).toBe(200);

  const positions = (await (await request.get(`/api/positions?company_id=${companyId}`, { headers: MP })).json()) as {
    positions: Array<{ id: string; status: string }>;
  };
  const open = positions.positions.find((p) => p.status === "OPEN");
  expect(open, "executing the transaction must leave an open position").toBeTruthy();
  return open!.id;
}

/** A fund with its four policies and a scenario pinning them — what a review is judged against. */
async function openScenario(request: Ctx, fundId: string, marker: string): Promise<string> {
  expect(
    (
      await request.patch(`/api/funds/${fundId}/size`, {
        headers: MP,
        data: { target_size: 30_000_000, currency: "USD", vintage_year: 2026 },
      })
    ).status(),
  ).toBe(200);
  for (const [kind, policy] of [
    ["mandate", { stages: ["seed"] }],
    ["sleeve", { sleeves: [{ key: "early", target_pct: 60 }] }],
    ["reserve", { reserve_pct: 40 }],
    ["concentration", { max_single_company_pct: 10 }],
  ] as const) {
    expect(
      (
        await request.post(`/api/funds/${fundId}/policies/${kind}`, {
          headers: MP,
          data: { version_no: 1, effective_from: "2026-01-01", policy },
        })
      ).status(),
      kind,
    ).toBe(201);
  }
  const versionOf = async (kind: string): Promise<string> => {
    const body = (await (await request.get(`/api/funds/${fundId}/policies/${kind}`, { headers: MP })).json()) as {
      current: { id: string };
    };
    return body.current.id;
  };
  const scenario = await request.post("/api/allocation/scenarios", {
    headers: MP,
    data: {
      fund_id: fundId,
      name: `${marker} follow-on construction`,
      mandate_version_id: await versionOf("mandate"),
      sleeve_version_id: await versionOf("sleeve"),
      reserve_version_id: await versionOf("reserve"),
      concentration_version_id: await versionOf("concentration"),
      fund_size: 30_000_000,
      investable: 24_000_000,
    },
  });
  expect(scenario.status(), await scenario.text()).toBe(201);
  return ((await scenario.json()) as { id: string }).id;
}
