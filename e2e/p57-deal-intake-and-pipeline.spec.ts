import { expect, test } from "@playwright/test";
import { stage } from "@shared/investment/pipeline";
import { gotoSurface } from "./support/nav";
import { deliverMail } from "./support/mail";
import { provisionLocalD1 } from "./support/provision";

/**
 * HOW A COMPANY GETS INTO THE FUNNEL, AND HOW IT GETS OUT AGAIN.
 *
 * Three journeys live here because they are one continuous thing — the mouth of the funnel, the
 * length of it, and the two ways out.
 *
 * 1 · FOUR DOORS, AND EVERY ARRIVAL SAYS WHICH ONE IT CAME THROUGH. A partner types it in, it
 *     arrives by email, Network OS pushes it, or the analyst finds it himself. All four converge on
 *     `openIntoFunnel` and all four write a `dealflow.arrival` event carrying the route, who sent
 *     it, and when it landed. Without that, the register says a partner sourced every deal in Fund
 *     I — which answers nothing at LP diligence, and is the exact question an LP asks first.
 *
 * 3 · THE LENGTH OF THE PIPELINE. First look → screening → diligence → committee → decided →
 *     invested, walked one press at a time by a person, because "starts at" is a backfill and a
 *     backfill proves nothing about whether a deal can actually be moved.
 *
 * 4 · A PASS IS RECORDED WITH ITS REASON AND STAYS VISIBLE. The operator's rule is that a passed
 *     company keeps its history and the pass pile is easy to get to. A pass with no reason is worth
 *     nothing when they come back, so the reason is a hard gate at both ends — the control refuses
 *     a short one and so does the server.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

/** The seat that owns the top of the funnel. Three of the four doors hand their arrival to him. */
const INTAKE_SEAT = "aie_wyatt";

/**
 * THIS SPEC ESTABLISHES ITS OWN STARTING STATE, and it has to.
 *
 * Three of the four doors open a work card for the same seat, and `createWorkCardInternal` trips a
 * breaker at twenty cards an hour for one owner — "past the 20 that means something is looping
 * rather than working". That is correct product behaviour and a whole-suite run legitimately walks
 * into it: `p54-inbound-deck.spec.ts` alone delivers six messages to this seat minutes earlier.
 *
 * So the hour is cleared before these journeys run. Nothing is deleted and no card changes hands —
 * only the CLOCK moves, which is the one thing the breaker reads. The breaker itself is not
 * weakened by this; it is deliberately tripped and asserted in the last test in this file.
 *
 * (Same reasoning and the same tool as `p28-activation-chain.spec.ts`, which puts one seat back to
 * INACTIVE because a migration employed the whole roster and the file had silently skipped itself
 * out of existence.)
 */
test.beforeAll(() => {
  provisionLocalD1(
    `UPDATE work_card SET created_at = '2026-01-01T00:00:00.000Z'
      WHERE owner_id = '${INTAKE_SEAT}'
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours');`,
  );
});

interface ArrivalPayload {
  route?: string;
  source?: string;
  received_at?: string;
  company?: string;
  owner?: string | null;
}

test("a company enters the funnel by each of the four routes, and each arrival says which one", async ({
  page,
  request,
}) => {
  const marker = `E2E-P57-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // ── Door 1 · MANUAL. A partner types it in, on the board, and it opens a pipeline record. ────
  const manualName = `${marker} Manual Co`;
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-add-toggle").click();
  await page.getByTestId("dealflow-new-name").fill(manualName);
  await page.getByTestId("dealflow-sleeve").selectOption("EARLY_STAGE_PRIMARY");
  await page.getByTestId("dealflow-origin").selectOption("INBOUND");
  await page.getByTestId("dealflow-add-submit").click();
  await expect(page.getByTestId("dealflow-message")).toContainText(manualName);

  // ── Door 2 · EMAIL. The one surface the firm does not control the input of. ──────────────────
  const emailName = `${marker} Mailed Co`;
  await deliverMail(request, {
    from: `Dana Fields <dana@mailed.example>`,
    subject: `#wpdealflow ${emailName}`,
    body: `Company: ${emailName}\n\nThought you should see this one.`,
  });

  // ── Door 3 · NETWORK OS pushes it across. ───────────────────────────────────────────────────
  const pushedName = `${marker} Pushed Co`;
  const pushed = await request.post("/api/network/dealflow", {
    headers: MP,
    data: { company: pushedName, pushed_by: "network-os", external_id: `${marker}-contact`, one_liner: "pushed across" },
  });
  expect(pushed.status(), await pushed.text()).toBe(201);
  const pushedEntry = (await pushed.json()) as { route: string; owner: string | null; work_card_id: string | null };
  expect(pushedEntry.route).toBe("NETWORK_OS");

  // ── Door 4 · THE SCOUT'S OWN FIND. Nobody sent this one; the analyst went looking. ───────────
  const scoutedName = `${marker} Scouted Co`;
  const scouted = await request.post("/api/dealflow/scouted", {
    headers: MP,
    data: { company: scoutedName, where: "Two founders in the portfolio named them", scout: "Wyatt" },
  });
  expect(scouted.status(), await scouted.text()).toBe(201);
  const scoutedEntry = (await scouted.json()) as { route: string; owner: string | null; work_card_id: string | null };
  expect(scoutedEntry.route).toBe("SCOUT");

  /*
   * EVERY ARRIVAL IS ON THE SPINE WITH ITS ROUTE, ITS SENDER AND ITS TIME.
   *
   * Asserted from `dealflow.arrival` rather than from four different surfaces: the arrival event
   * is the one record every door writes in the same shape, and it is what the provenance question
   * is actually answered from. (Since 18 Sep 2026 the four doors also land in the same place — an
   * opportunity at the top of the funnel — which the board check further down pins.)
   */
  const arrivals = await arrivalsFor(request, marker);
  for (const [route, company] of [
    ["MANUAL", manualName],
    ["EMAIL", emailName],
    ["NETWORK_OS", pushedName],
    ["SCOUT", scoutedName],
  ] as const) {
    const arrival = arrivals.find((a) => (a.company ?? "").includes(company));
    expect(arrival, `${company} must have recorded an arrival through the ${route} door`).toBeTruthy();
    expect(arrival!.route, `${company} arrived by the wrong route`).toBe(route);
    // WHO sent it. Never blank — "an unattributed deal is a deal the register cannot answer for".
    expect(arrival!.source, `${company} must record who sent it`).toBeTruthy();
    // WHEN it landed, as a real timestamp rather than "recently".
    expect(arrival!.received_at, `${company} must record when it landed`).toBeTruthy();
    expect(new Date(arrival!.received_at!).getTime()).not.toBeNaN();
  }

  // The three unattended doors hand the arrival to a person by name, rather than filing it nowhere.
  expect(arrivals.find((a) => (a.company ?? "").includes(pushedName))!.owner).toBeTruthy();
  expect(arrivals.find((a) => (a.company ?? "").includes(scoutedName))!.owner).toBeTruthy();

  /*
   * AND THE MANUAL ONE SAYS WHO TYPED IT. `source_channel` is written server-side as
   * `manual:<the partner's own name>` — a deal cannot be entered anonymously from the board.
   */
  const board = await boardDeals(request);
  const manualDeal = board.find((d) => d.company_name === manualName)!;
  expect(manualDeal, "the manual route opens a pipeline record under the partner's name").toBeTruthy();
  expect(manualDeal.source_channel).toContain("manual:");
  expect(manualDeal.source_channel).toContain("Scooter Taylor");

  /*
   * EVERY COMPANY IS IN THE PIPELINE, WHICHEVER DOOR (owner, 18 Sep 2026: "they are top of funnel
   * if they are in the system"). All four are on the board at NEW, each wearing its route, and the
   * emailed one carries the `email:` prefix the "by email · not yet looked at" badge keys on. This
   * is the journey Northwind Robotics and Vynlo never completed.
   */
  for (const [name, channel] of [
    [emailName, "email:"],
    [pushedName, "network_os:"],
    [scoutedName, "scout:"],
  ] as const) {
    const deal = board.find((d) => d.company_name === name);
    expect(deal, `${name} must be on the board — every company is in the pipeline`).toBeTruthy();
    expect(deal!.status, `${name} arrives at the top of the funnel`).toBe("NEW");
    expect(String(deal!.source_channel).startsWith(channel), `${name} must wear its route (${channel})`).toBe(true);
  }
  expect(pushedEntry.work_card_id, "the push still hands the decision to a person").toBeTruthy();
  expect(scoutedEntry.work_card_id, "the scout's find still hands the decision to a person").toBeTruthy();

  /*
   * WHERE DEALS COME FROM, ON THE PAGE. The provenance panel is what turns four recorded arrivals
   * into an answer a partner can act on, and the origin chosen at the moment of entry is on it.
   */
  /*
   * READ ON A FRESH LOAD. `DealProvenance` fetches once per mount and the board's own reload does
   * not carry it — so on the page the deal was just added from, the panel underneath is still
   * showing what it read before the deal existed. That staleness is reported rather than asserted
   * here; what this journey is about is that the origin a partner chose at the moment of entry is
   * recorded and counted, not that the panel re-renders.
   */
  await page.reload();
  await gotoSurface(page, "Dealflow");
  await expect(page.getByTestId("deal-provenance")).toBeVisible();
  await expect(page.getByTestId("origin-INBOUND")).toBeVisible();
});

test("a deal is walked the whole length of the pipeline to an investment decision", async ({ page, request }) => {
  const marker = `E2E-P57-WALK-${Date.now()}`;
  const companyName = `${marker} Co`;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  /*
   * IT STARTS AT "NEW", ON PURPOSE. "Starts at" exists so a deal already in flight can be recorded
   * honestly, and it walks the stages server-side — which would make this journey prove that the
   * BACKFILL works rather than that a partner can move a deal. Every press below is a press.
   */
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-add-toggle").click();
  await page.getByTestId("dealflow-new-name").fill(companyName);
  await page.getByTestId("dealflow-stage").selectOption("NEW");
  await page.getByTestId("dealflow-add-submit").click();
  await expect(page.getByTestId("dealflow-message")).toContainText(companyName);

  const dealId = (await boardDeals(request)).find((d) => d.company_name === companyName)!.id;
  expect(await statusOf(request, dealId)).toBe("NEW");

  /*
   * First look → screening → diligence → committee → decided → invested. One press per stage, and
   * the stage is read back from the record between each, so a stalled walk fails HERE rather than
   * twenty lines later as "the control is missing".
   *
   * EVERY PRESS IS CHECKED AGAINST WHAT THE BUTTON SAYS, and that is the part this journey used to
   * leave out. It pressed `deal-advance-…` five times and asserted the RECORD afterwards, never the
   * control — so a button still rendering the previous stage's move looked identical to the right
   * one, and the press went to the stage the deal had already left. That is how this spec failed
   * intermittently with `Expected "CLOSED" / Received "IC_DECIDED"` (18 Sep 2026): the walk lost a
   * press to a control that had not caught up, and the loop had no way to know.
   *
   * Asserting the LABEL first is strictly more than the old loop asked. It pins that the row offers
   * the correct next move at the moment it is pressed — a claim about the interface a partner uses,
   * not only about the row the server ends up with — and it removes the race as a side effect,
   * because Playwright will not press a control whose text does not yet name the move being made.
   */
  for (const expected of ["SCREENING", "DILIGENCE", "IC_READY", "IC_DECIDED", "CLOSED"]) {
    const advance = page.getByTestId(`deal-advance-${dealId}`);
    await expect(advance, `the row must offer the move to ${expected} before it is pressed`).toHaveText(
      `Move to ${stage(expected)!.label.toLowerCase()}`,
    );
    await advance.click();
    await expect
      .poll(async () => await statusOf(request, dealId), { message: `the deal must reach ${expected}` })
      .toBe(expected);
  }

  /*
   * REACHING THE COMMITTEE OPENED A PACKET BY ITSELF (ADR-019) — the stage move is what does it,
   * and a walk that reached IC_READY without one would leave the committee with nothing to decide
   * against.
   */
  const packets = (await (await request.get(`/api/ic/packets?opportunity_id=${dealId}`, { headers: MP })).json()) as {
    ic_packets: unknown[];
  };
  expect(packets.ic_packets, "passing through the committee stage must assemble a packet").toHaveLength(1);

  // INVESTED IS ITS OWN PILE, not a stage you have to know to look for.
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-filter-INVESTED").click();
  await expect(page.getByTestId(`deal-${dealId}`)).toBeVisible();

  // A closed deal offers no "pass" — a control that exists only to be refused teaches people to
  // distrust the ones that work.
  await expect(page.getByTestId(`deal-pass-${dealId}`)).toHaveCount(0);
});

test("a pass is recorded with its reason, keeps its history, and the pass pile is one press away", async ({
  page,
  request,
}) => {
  const marker = `E2E-P57-PASS-${Date.now()}`;
  const companyName = `${marker} Co`;
  const reason = "The second founder had already left and nobody would say why";

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();

  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-add-toggle").click();
  await page.getByTestId("dealflow-new-name").fill(companyName);
  await page.getByTestId("dealflow-stage").selectOption("DILIGENCE");
  await page.getByTestId("dealflow-add-submit").click();
  await expect(page.getByTestId("dealflow-message")).toContainText(companyName);
  const dealId = (await boardDeals(request)).find((d) => d.company_name === companyName)!.id;

  /*
   * A REASON TOO THIN TO BE ONE IS REFUSED, and the deal does not move.
   *
   * Tried through the control a person actually uses, with the prompt answered the way a person in
   * a hurry answers it. The refusal is asserted by the deal STILL BEING IN DILIGENCE, because that
   * is the property — the sentence explaining why can be reworded, and a deal that quietly left the
   * funnel on a one-word reason cannot be talked back into it.
   */
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.accept(dialogs === 1 ? "no" : reason);
  });

  await page.getByTestId(`deal-pass-${dealId}`).click();
  await expect(page.getByTestId(`deal-${dealId}`)).toContainText("Say why in a sentence");
  expect(await statusOf(request, dealId), "a pass with no reason must not move the deal").toBe("DILIGENCE");

  // Said properly, it passes.
  await page.getByTestId(`deal-pass-${dealId}`).click();
  await expect.poll(async () => await statusOf(request, dealId)).toBe("PASS");

  // It is off the live board — a passed deal is not somebody's problem any more.
  await expect(page.getByTestId(`deal-${dealId}`)).toHaveCount(0);

  /*
   * AND THE PASS PILE IS ONE PRESS AWAY, WITH THE REASON ON THE ROW.
   *
   * "Easy to get to" is the operator's own requirement, and the reason has to be ON the row rather
   * than one click further in: the question a partner asks when a passed founder emails again is
   * "why did we say no", and an answer that takes three clicks is an answer nobody looks up.
   */
  await page.getByTestId("dealflow-filter-PASSED").click();
  const passedRow = page.getByTestId(`deal-${dealId}`);
  await expect(passedRow).toBeVisible();
  await expect(passedRow.getByTestId(`deal-exit-reason-${dealId}`)).toContainText(reason);

  /*
   * ITS HISTORY SURVIVED, AND THE REASON IS IN IT. A passed company keeps everything that was
   * learned about it — that is the operator's rule, and a trail that records the pass without the
   * why keeps the fact and loses the thinking.
   *
   * READ ON A FRESH LOAD, DELIBERATELY. `DealRow`'s `onChanged` is `board.reload`
   * (`DealflowPage.tsx:2279`) and the open record's history is `useApi(…, [companyId])`
   * (`DealflowPage.tsx:817`), so passing a deal while its own record is open below refreshes the
   * board and NOT the history under it. That staleness is a real defect and it is reported rather
   * than asserted here: what this journey is about is that the reason is kept and findable, and
   * pinning it to a live re-render would make the assertion about React and not about the record.
   */
  const historyEntries = (await (await request.get(`/api/companies/${await companyOf(request, dealId)}/history`, { headers: MP })).json()) as {
    entries: Array<{ what: string; said: string | null }>;
  };
  const passEntry = historyEntries.entries.find((e) => (e.said ?? "").includes(reason));
  expect(passEntry, "the pass and its reason must be on the company's permanent history").toBeTruthy();
  expect(passEntry!.what).toBe("investment.opportunity_transitioned");

  await page.reload();
  await page.getByTestId("dealflow-filter-PASSED").click();
  await page.getByTestId(`deal-company-${dealId}`).click();
  const history = page.getByTestId("deal-history");
  await expect(history).toBeVisible();
  await expect(history, "a partner must be able to read why the firm said no").toContainText(reason);

  // A pass is reversible, and it comes back at screening rather than where it left — the reason it
  // was passed on has to be looked at again.
  await page.getByTestId(`deal-reopen-${dealId}`).click();
  await expect.poll(async () => await statusOf(request, dealId)).toBe("SCREENING");
});

test("the server refuses a pass with no reason, whatever the caller is", async ({ request }) => {
  /*
   * THE GATE IS ON THE SERVER, NOT ONLY ON THE BUTTON. The control's own check is a courtesy; this
   * is the rule. Anything with an API client could otherwise empty the funnel silently.
   */
  const marker = `E2E-P57-API-${Date.now()}`;
  const company = (await (
    await request.post("/api/companies", { headers: MP, data: { canonical_name: `${marker} Co` } })
  ).json()) as { id: string };
  const opp = (await (
    await request.post("/api/opportunities", {
      headers: MP,
      data: { company_id: company.id, opportunity_type: "EARLY_STAGE_PRIMARY", title: `${marker} deal` },
    })
  ).json()) as { id: string };

  for (const body of [{ to: "PASS" }, { to: "PASS", reason: "no" }, { to: "PASS", reason: "   " }]) {
    const refused = await request.post(`/api/opportunities/${opp.id}/transition`, { headers: MP, data: body });
    expect(refused.status(), `${JSON.stringify(body)} must be refused: ${await refused.text()}`).toBe(400);
    expect(await refused.text()).toContain("reason_required");
  }
  expect(await statusOf(request, opp.id), "none of those refusals may have moved the deal").toBe("NEW");

  // And an illegal jump is refused even with a perfectly good reason — the ladder is the ladder.
  const jump = await request.post(`/api/opportunities/${opp.id}/transition`, {
    headers: MP,
    data: { to: "CLOSED", reason: "we would like to skip the committee please" },
  });
  expect(jump.status(), await jump.text()).toBe(409);
  expect(await jump.text()).toContain("illegal_transition");

  // A recorded pass keeps its reason on the row itself, where every reader of the board sees it.
  const passed = await request.post(`/api/opportunities/${opp.id}/transition`, {
    headers: MP,
    data: { to: "PASS", reason: "Two of the three named customers turned out to be pilots" },
  });
  expect(passed.status(), await passed.text()).toBe(200);
  expect(((await passed.json()) as { exit_reason: string }).exit_reason).toContain("pilots");
});

test("an arrival the firm refuses to file says why, rather than failing opaquely", async ({ request }) => {
  /*
   * NOTHING FAILS SILENTLY — INCLUDING A REFUSAL THE FIRM MEANT.
   *
   * `createWorkCardInternal` stops one seat at twenty cards an hour, on purpose: it is the breaker
   * that separates an employee working from an employee looping. Every unattended door into the
   * funnel opens such a card, so every unattended door can be refused by it.
   *
   * That refusal used to arrive as `500 {"error":"internal_error"}`. Network OS pushed a company
   * across, or the analyst found one, and the firm dropped it with no status anybody could act on
   * and no sentence saying which rule stopped it — which is exactly the shape of failure the whole
   * inbound doctrine exists to prevent. Both handlers now translate `WorkCardError` (see
   * `dealIntake.ts` `funnelErrorResponse` and `networkAdapter.ts` `errorResponse`).
   *
   * THE BREAKER IS TRIPPED FOR REAL, not mocked: twenty-one cards are put on the seat with this
   * hour's clock, and removed again afterwards so the suite stays re-runnable.
   */
  const filler = Array.from(
    { length: 21 },
    (_, i) =>
      `('wc_e2e_p57_trip_${i}', 'E2E-P57 breaker filler ${i}', 'AI', '${INTAKE_SEAT}', 'OPEN', 'west-peek', 'fu_scooter_taylor')`,
  ).join(",");
  provisionLocalD1(
    `INSERT OR IGNORE INTO work_card (id, title, owner_type, owner_id, state, firm_scope, created_by) VALUES ${filler};`,
  );

  try {
    for (const [label, path, data] of [
      ["the analyst's own find", "/api/dealflow/scouted", { company: `E2E-P57-TRIP scout ${Date.now()}` }],
      ["a Network OS push", "/api/network/dealflow", { company: `E2E-P57-TRIP push ${Date.now()}`, pushed_by: "network-os" }],
    ] as const) {
      const res = await request.post(path, { headers: MP, data });
      const text = await res.text();
      expect(res.status(), `${label} must be refused with a status, not a 500: ${text}`).toBe(429);
      // The reason names the seat, the count and the limit — enough for a partner to act on.
      expect(text, `${label} must say which rule stopped it`).toContain("opening_too_fast");
      expect(text).toContain("Wyatt");
      expect(text, "an opaque internal error is the failure mode this exists to prevent").not.toContain(
        "internal_error",
      );
    }
  } finally {
    provisionLocalD1(`DELETE FROM work_card WHERE id LIKE 'wc_e2e_p57_trip_%';`);
  }

  // The seat is workable again the moment the hour is not full, so the breaker is a pause and not a
  // door that stays shut.
  const after = await request.post("/api/dealflow/scouted", {
    headers: MP,
    data: { company: `E2E-P57-TRIP recovered ${Date.now()}` },
  });
  expect(after.status(), await after.text()).toBe(201);
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

interface BoardDeal {
  id: string;
  status: string;
  company_name: string;
  source_channel: string | null;
  exit_reason: string | null;
}

async function boardDeals(request: Ctx): Promise<BoardDeal[]> {
  const body = (await (await request.get("/api/dealflow/board", { headers: MP })).json()) as { deals: BoardDeal[] };
  return body.deals;
}

async function companyOf(request: Ctx, opportunityId: string): Promise<string> {
  const body = (await (await request.get(`/api/opportunities/${opportunityId}`, { headers: MP })).json()) as {
    company_id?: string;
    opportunity?: { company_id: string };
  };
  return body.company_id ?? body.opportunity!.company_id;
}

async function statusOf(request: Ctx, opportunityId: string): Promise<string> {
  const res = await request.get(`/api/opportunities/${opportunityId}`, { headers: MP });
  const body = (await res.json()) as { status?: string; opportunity?: { status: string } };
  return body.status ?? body.opportunity?.status ?? "";
}

/** Every `dealflow.arrival` on the spine whose payload mentions this run's marker. */
async function arrivalsFor(request: Ctx, marker: string): Promise<ArrivalPayload[]> {
  const body = (await (await request.get("/api/activity?limit=200", { headers: MP })).json()) as {
    events: Array<{ event_type: string; payload?: unknown; payload_json?: string }>;
  };
  return body.events
    .filter((e) => e.event_type === "dealflow.arrival")
    .map((e) => {
      const raw = e.payload ?? (e.payload_json ? (JSON.parse(e.payload_json) as unknown) : {});
      return (raw ?? {}) as ArrivalPayload;
    })
    .filter((p) => (p.company ?? "").includes(marker));
}
