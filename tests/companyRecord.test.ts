import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * Item 9 — the company record: edit it, read back what was done to it, find it from its deal, and
 * record a no.
 *
 * WHAT THESE PROVE, and why each one is here rather than assumed.
 *
 * `PATCH /api/companies/:id` shipped with no caller, no authorize() call and no event. In production
 * all three companies had been modified with nothing anywhere saying by whom. So the route is
 * asserted to pass the choke point AND to write the change — field by field, with its previous value
 * — onto the event spine, because the spine IS the history the operator's History control reads.
 *
 * THE PASS IS THE HALF THAT DID NOT EXIST. The operator's requirement, in her words: a passed
 * company drops out of the active pipeline and KEEPS its history; the pile is visible, greyed, below,
 * never deleted. The server half of that is the register still returning the company, carrying the
 * reason and the date it left — a register that quietly dropped the row would satisfy "out of the
 * pipeline" by destroying the thing worth keeping.
 *
 * ARCHIVED IS NOT PASSED, and the two were being conflated by omission: `archived_at` was written by
 * "Remove this record" and read by neither the board nor the register, so a removed duplicate stayed
 * on screen and could still win the "latest deal" race and describe the company.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "analyst@westpeek.ventures" };

async function call<T = any>(
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as T };
}

interface RegisterCompany {
  id: string;
  canonical_name: string;
  sector: string | null;
  one_liner: string | null;
  deal_id: string | null;
  deal_status: string | null;
  exit_reason: string | null;
  left_pipeline_at: string | null;
  amount_usd: number | null;
  amount_is_provisional: boolean;
}

async function register(): Promise<RegisterCompany[]> {
  const res = await call<{ companies: RegisterCompany[] }>("/api/companies/register", MP);
  expect(res.status).toBe(200);
  return res.body.companies;
}

/** A company with a live deal on the board, which is the shape every case below starts from. */
async function companyWithDeal(name: string): Promise<{ companyId: string; dealId: string }> {
  const co = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: name });
  expect(co.status).toBe(201);
  const opp = await call<{ id: string }>("/api/opportunities", MP, "POST", {
    company_id: co.body.id,
    opportunity_type: "EARLY_STAGE_PRIMARY",
    title: `${name} — pre-seed`,
    relationship_origin: "INBOUND",
  });
  expect(opp.status).toBe(201);
  return { companyId: co.body.id, dealId: opp.body.id };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // A firm user who is not a Managing Partner, to prove the edit is a governed action rather than
  // one that happens to work for whoever is signed in.
  await t.db
    .prepare(
      "INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_item9_analyst', 'analyst@westpeek.ventures', 'Item Nine Analyst', 'ACTIVE')",
    )
    .run();
  await t.db
    .prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_item9_analyst', 'role_investment_team')")
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("editing a company leaves a trail", () => {
  it("routes the edit through the choke point on a registered action key", async () => {
    const row = await t.db
      .prepare("SELECT key, is_reserved FROM action_type WHERE key = 'company.update'")
      .first<{ key: string; is_reserved: number }>();
    // Unregistered keys are the failure this asserts against: authorize() cannot decide on a key the
    // register does not hold, and the edit route would be ungoverned in exactly the way it was.
    expect(row?.key).toBe("company.update");
  });

  it("records every changed field with its previous value, and nothing that did not move", async () => {
    const { companyId } = await companyWithDeal("Trail Co");

    const first = await call(`/api/companies/${companyId}`, MP, "PATCH", {
      sector: "HEALTH_TECH",
      one_liner: "Remote cardiac monitoring for rural clinics",
    });
    expect(first.status).toBe(200);

    // Same one-liner, different sector. Only the sector should appear in the second event.
    const second = await call(`/api/companies/${companyId}`, MP, "PATCH", {
      sector: "AI",
      one_liner: "Remote cardiac monitoring for rural clinics",
    });
    expect(second.status).toBe(200);

    const events = await t.db
      .prepare(
        `SELECT payload_json FROM event_record
          WHERE event_type = 'company.updated' AND object_id = ?1
          ORDER BY created_at, id`,
      )
      .bind(companyId)
      .all<{ payload_json: string }>();
    expect(events.results).toHaveLength(2);

    const latest = JSON.parse(events.results![1]!.payload_json) as {
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(Object.keys(latest.changes)).toEqual(["sector"]);
    expect(latest.changes.sector).toEqual({ from: "HEALTH_TECH", to: "AI" });
  });

  it("refuses an edit that would change identity, and says which fields are editable", async () => {
    const { companyId } = await companyWithDeal("Identity Co");
    const res = await call<{ detail: string }>(`/api/companies/${companyId}`, MP, "PATCH", {
      canonical_name: "Something Else Entirely",
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("one_liner");
  });

  it("refuses an edit from an identity the system does not know", async () => {
    const { companyId } = await companyWithDeal("Authority Co");
    const res = await call(`/api/companies/${companyId}`, { "x-wpos-dev-user": "nobody@example.com" }, "PATCH", {
      one_liner: "typed by a stranger",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await t.db
      .prepare("SELECT one_liner FROM canonical_company WHERE id = ?1")
      .bind(companyId)
      .first<{ one_liner: string | null }>();
    // The refusal has to be a refusal. A 4xx over a row that changed anyway is the worst of both.
    expect(after!.one_liner).toBeNull();
  });

  it("refuses an edit to a company belonging to another firm", async () => {
    const { companyId } = await companyWithDeal("Other Firm Co");
    await t.db.prepare("UPDATE canonical_company SET firm_scope = 'someone-else' WHERE id = ?1").bind(companyId).run();

    const res = await call<{ detail: string }>(`/api/companies/${companyId}`, MP, "PATCH", {
      one_liner: "reaching across the wall",
    });
    // §11.7 isolation is the choke point's job, and it can only do it if the row's scope is handed
    // to it. Without that argument authorize() compared the home scope against itself and allowed
    // every company in the table — a call that looked present and decided nothing.
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain("cross_firm_scope");
  });
});

describe("the history control has something to show", () => {
  it("reads back the edit as a sentence, with who made it and what it was before", async () => {
    const { companyId } = await companyWithDeal("History Co");
    await call(`/api/companies/${companyId}`, MEMBER, "PATCH", { one_liner: "Freight brokerage, autonomous" });

    const res = await call<{ entries: Array<{ what: string; by: string; said: string | null }> }>(
      `/api/companies/${companyId}/history`,
      MP,
    );
    expect(res.status).toBe(200);
    const edit = res.body.entries.find((e) => e.what === "company.updated");
    expect(edit).toBeTruthy();
    expect(edit!.said).toContain("one liner");
    expect(edit!.said).toContain("Freight brokerage, autonomous");
    expect(edit!.by).toBe("Item Nine Analyst");
  });

  it("carries what happened to the company's DEAL, not only edits to the company row", async () => {
    const { companyId, dealId } = await companyWithDeal("Whole Story Co");
    const moved = await call(`/api/opportunities/${dealId}/transition`, MP, "POST", { to: "SCREENING" });
    expect(moved.status).toBe(200);

    const res = await call<{ entries: Array<{ what: string }> }>(`/api/companies/${companyId}/history`, MP);
    // "What has happened with this company" means the deal moving as much as the record being
    // corrected. Splitting those across two surfaces is how a timeline gets rebuilt from memory.
    expect(res.body.entries.map((e) => e.what)).toContain("investment.opportunity_transitioned");
  });
});

describe("recording a no", () => {
  it("keeps the company in the register with its reason and the date it left", async () => {
    const { companyId, dealId } = await companyWithDeal("Passed Co");
    const passed = await call(`/api/opportunities/${dealId}/transition`, MP, "POST", {
      to: "PASS",
      reason: "Second founder had already left and nobody would say why.",
    });
    expect(passed.status).toBe(200);

    const found = (await register()).find((c) => c.id === companyId);
    // Not deleted, not hidden — the operator's requirement is that it drops out of the working
    // pipeline and keeps everything. The register is where "keeps everything" is proven.
    expect(found).toBeTruthy();
    expect(found!.deal_status).toBe("PASS");
    expect(found!.exit_reason).toContain("Second founder");
    expect(found!.left_pipeline_at).toBeTruthy();
  });

  it("refuses a pass with no reason worth reading", async () => {
    const { dealId } = await companyWithDeal("Reasonless Co");
    const res = await call<{ detail: string }>(`/api/opportunities/${dealId}/transition`, MP, "POST", {
      to: "PASS",
      reason: "no",
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("Say why");
  });

  it("hands the pass and its reason to the board, so the pile can say more than the name", async () => {
    const { dealId } = await companyWithDeal("Board Reason Co");
    await call(`/api/opportunities/${dealId}/transition`, MP, "POST", {
      to: "PASS",
      reason: "Burn is nine months and the round is not led.",
    });

    const board = await call<{ deals: Array<{ id: string; status: string; exit_reason: string | null }> }>(
      "/api/dealflow/board",
      MP,
    );
    const deal = board.body.deals.find((d) => d.id === dealId)!;
    expect(deal.status).toBe("PASS");
    expect(deal.exit_reason).toContain("Burn is nine months");
  });

  it("leaves a passed company off nothing — it still resolves by name", async () => {
    const res = await call<{ match: { canonical_name: string } | null }>(
      "/api/companies/resolve?name=Passed%20Co",
      MP,
    );
    expect(res.body.match?.canonical_name).toBe("Passed Co");
  });
});

describe("a removed record is off the board and out of the register", () => {
  it("takes an archived deal off the pipeline board", async () => {
    const { dealId } = await companyWithDeal("Typo Co");
    const archived = await call(`/api/opportunities/${dealId}/archive`, MP, "POST", {
      reason: "Entered twice under two spellings.",
    });
    expect(archived.status).toBe(200);

    const board = await call<{ deals: Array<{ id: string }> }>("/api/dealflow/board", MP);
    // Before this, `archived_at` was written and read by nothing here: the row came straight back on
    // the next reload and "Remove this record" looked like a button that did nothing.
    expect(board.body.deals.map((d) => d.id)).not.toContain(dealId);
  });

  it("never lets an archived deal be the deal the register describes", async () => {
    const { companyId, dealId } = await companyWithDeal("Two Deals Co");
    await call(`/api/opportunities/${dealId}/transition`, MP, "POST", { to: "SCREENING" });

    const duplicate = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: companyId,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: "Two Deals Co — entered again by mistake",
      relationship_origin: "INBOUND",
    });
    await call(`/api/opportunities/${duplicate.body.id}/archive`, MP, "POST", {
      reason: "Duplicate of the row already on the board.",
    });

    const found = (await register()).find((c) => c.id === companyId)!;
    // The archived duplicate is the newest row, so it won the old "latest opportunity" subquery and
    // reset the company's stage to NEW on the register.
    expect(found.deal_id).toBe(dealId);
    expect(found.deal_status).toBe("SCREENING");
  });
});
