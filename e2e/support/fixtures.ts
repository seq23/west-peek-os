import { expect, type APIRequestContext } from "@playwright/test";

/**
 * THE FIXTURE CONTRACT FOR THE DEALS SPECS — leave the firm as you found it.
 *
 * The suite runs on ONE worker against ONE local D1 (playwright.config.ts), so a row a spec seeds
 * is a row every later spec inherits. A live deal is not inert: every intelligence run acquires
 * the open NEW / SCREENING / IC_READY opportunities as items (`services/intelligence.ts`,
 * `acquireInternal`, scored 0.30 for naming a company), the Intelligence page shows the first 25
 * items by score, and Home's intelligence module shows the top EIGHT.
 *
 * CONFIRMED on the merged Deals head, 19 Sep 2026, by running the suite in file order through
 * p25 and reading the database at the failure: 26 live fixture deals from the five Deals
 * measurement specs had become 26 items at 0.30; journey 1's operator-supplied item scored 0.00
 * and sat 27th — off the Intelligence page's first 25 and out of Home's top eight — so
 * `intel-detail-*` for its headline did not exist to click. Nothing in journey 1 was wrong; the
 * specs before it had filled the window it reads through.
 *
 * THE RULE. A Deals spec that creates deals through the real routes RETIRES them when its test is
 * done, through the product's own "Remove this record" (`POST /api/opportunities/:id/archive`,
 * with a reason). An archived deal is excluded from acquisition, the board, the register and every
 * other list. A booked deal cannot be archived (a holding is not a mistaken row — void the
 * transaction instead), and does not need to be: an Invested (CLOSED) deal is never acquired.
 *
 * Call `retireFixtureDeals` in `finally` / `afterEach` so a failed measurement still tidies up.
 * It asserts every retirement, so a fixture that cannot be retired fails the spec that made it
 * rather than a journey three files later.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

/** Deals in these states are what `acquireInternal` turns into intelligence items. */
const ACQUIRED_STATES = new Set(["NEW", "SCREENING", "IC_READY"]);

export async function retireFixtureDeals(request: APIRequestContext, dealIds: ReadonlyArray<string | null | undefined>, why: string): Promise<number> {
  let retired = 0;
  for (const id of dealIds) {
    if (!id) continue;
    const res = await request.post(`/api/opportunities/${id}/archive`, {
      headers: MP,
      data: { reason: `e2e fixture — ${why}; removed so it cannot fill another spec's window` },
    });
    if (res.status() === 200) {
      retired += 1;
      continue;
    }
    // Refused: the only legitimate refusal is a booked holding, and a booked deal is not acquired.
    // Anything else — a deal that is still NEW and would not archive — is this spec's defect.
    const opp = (await (await request.get(`/api/opportunities/${id}`, { headers: MP })).json()) as {
      status?: string;
      opportunity?: { status: string };
    };
    const status = opp.status ?? opp.opportunity?.status ?? "unknown";
    expect(
      ACQUIRED_STATES.has(status),
      `fixture deal ${id} could not be retired (HTTP ${res.status()}: ${await res.text()}) and is still at ${status}, where every intelligence run will acquire it`,
    ).toBe(false);
  }
  return retired;
}

/**
 * Every live deal whose company name carries this marker — for a spec that seeds through several
 * doors and wants to retire everything it made without keeping every id.
 */
export async function fixtureDealsByMarker(request: APIRequestContext, marker: string): Promise<string[]> {
  const board = (await (await request.get("/api/dealflow/board", { headers: MP })).json()) as {
    deals: Array<{ id: string; company_name: string; title: string }>;
  };
  return board.deals.filter((d) => d.company_name.includes(marker) || d.title.includes(marker)).map((d) => d.id);
}
