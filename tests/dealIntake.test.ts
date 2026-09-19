import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import {
  INTAKE_ROUTES,
  ROUTE_POLICY,
  dealFromMessage,
  intakeDealFromEmail,
  intakeScoutedCompany,
  matchFunnelCompany,
  openIntoFunnel,
  openRoutingCard,
  type FunnelEntry,
  type IntakeRoute,
} from "../src/worker/services/dealIntake";
import { intakeCompanyFromNetworkOs } from "../src/worker/services/networkAdapter";
import { companyFromSubject } from "../src/worker/effects/inboundEmail";

/**
 * ITEM 7 — every route into the funnel converges on one governed entry point.
 *
 * The issues list: "Four uncontrolled routes already exist while the page claims 'the only way in'.
 * Consolidate before adding." The page has stopped lying; these tests are the other half. There is
 * one function — `openIntoFunnel` — and four routes that differ only in what they hand it and who
 * picks up the card.
 *
 * THE SHAPE OF THIS FILE IS THE CLAIM. One describe per route, each proving the same three things
 * (it matched first, it opened the company at the top of the funnel, it recorded provenance), then
 * one block that asserts the convergence directly. If a fifth route is ever added, it belongs here
 * or it is not consolidated.
 *
 * WHAT CHANGED ON 18 SEP 2026, AND WHY THESE PINS GOT STRICTER. Until then three of the four
 * routes asserted "nothing has entered the pipeline" — a card for Wyatt, and no opportunity. The
 * owner's rule replaced that: "all companies should be in the pipeline, no matter how they come in.
 * They are top of funnel if they are in the system. From email we have to DECIDE on them." Two
 * companies in production (Northwind Robotics, Vynlo) had been sitting in the register with no
 * opportunity, one of them with a DONE card that had told the analyst to open one. So every route
 * now asserts BOTH: exactly one live opportunity on the board, AND — on the three unattended routes
 * — a card that asks for the decision rather than the admission.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

/** The provenance record for one arrival, read back off the event spine. */
async function arrivalOf(eventId: string): Promise<{ actor_type: string; actor_id: string; payload: Record<string, any> }> {
  const row = await t.db
    .prepare("SELECT actor_type, actor_id, payload_json FROM event_record WHERE id = ?1 AND event_type = 'dealflow.arrival'")
    .bind(eventId)
    .first<{ actor_type: string; actor_id: string; payload_json: string }>();
  expect(row, "every arrival writes exactly one dealflow.arrival event").toBeTruthy();
  return { actor_type: row!.actor_type, actor_id: row!.actor_id, payload: JSON.parse(row!.payload_json) };
}

async function cardOf(id: string | null) {
  expect(id).toBeTruthy();
  return (await t.db
    .prepare("SELECT owner_type, owner_id, state, title, description, next_action, prompt, machine_id FROM work_card WHERE id = ?1")
    .bind(id)
    .first<{
      owner_type: string;
      owner_id: string;
      state: string;
      title: string;
      description: string;
      next_action: string;
      prompt: string;
      machine_id: number;
    }>())!;
}

async function opportunityCount(): Promise<number> {
  return (await t.db.prepare("SELECT COUNT(*) AS n FROM investment_opportunity").first<{ n: number }>())!.n;
}

/** The live opportunities a company has on the board — the number every unattended route must leave at exactly one. */
async function liveOpportunities(companyId: string | null): Promise<Array<{ id: string; status: string; source_channel: string; created_by: string; relationship_origin: string }>> {
  expect(companyId).toBeTruthy();
  return (
    await t.db
      .prepare(
        "SELECT id, status, source_channel, created_by, relationship_origin FROM investment_opportunity WHERE company_id = ?1 AND status NOT IN ('CLOSED','PASS','WITHDRAWN') AND archived_at IS NULL",
      )
      .bind(companyId)
      .all<{ id: string; status: string; source_channel: string; created_by: string; relationship_origin: string }>()
  ).results ?? [];
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

/*
 * THE RUNAWAY-EMPLOYEE BREAKER IS REAL AND STAYS ON. `createWorkCardInternal` refuses Wyatt's 21st
 * card in an hour, which this file — one card per arrival, dozens of arrivals — would trip a third
 * of the way down. The breaker is tested on its own in `workCardOwnerShape.test.ts`; here the cards
 * from earlier tests are aged past the window before each one, so the count measures this test's
 * arrivals rather than the file's. Ageing rather than deleting, so every card is still readable.
 */
beforeEach(async () => {
  await t.db
    .prepare("UPDATE work_card SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE owner_id = 'aie_wyatt'")
    .run();
});

describe("reading a company out of a message", () => {
  it("prefers an explicit Company line", () => {
    const d = dealFromMessage("#wpdealflow anything", "Company: Northwind Robotics\nSector: AI", "a@b.co", false)!;
    expect(d.company).toBe("Northwind Robotics");
    expect(d.sector).toBe("AI");
  });

  it("falls back to the subject with the trigger and Re/Fwd stripped", () => {
    const d = dealFromMessage("Fwd: #wpdeck Helios Grid", "see attached", "a@b.co", true)!;
    expect(d.company).toBe("Helios Grid");
    expect(d.isDeck).toBe(true);
  });

  it("returns nothing rather than guessing a name out of prose", () => {
    // A wrong company at the top of the funnel is worse than no company: somebody has to notice it
    // is wrong before they can delete it.
    expect(dealFromMessage("#wpdealflow", "have a look at this one", "a@b.co", false)).toBeNull();
  });
});

// ── Route 1 of 4 ──

describe("route 1 · manual — a partner drives it herself", () => {
  it("goes straight in, with no card, because the person who decided is the person who pressed it", async () => {
    const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: "Manual Route Co" });
    expect(company.status).toBe(201);

    const before = await opportunityCount();
    const created = await call<{ id: string; company_id: string; status: string; source_channel: string }>(
      "/api/opportunities",
      MP,
      "POST",
      { company_id: company.body.id, opportunity_type: "EARLY_STAGE_PRIMARY", title: "Manual Route Co — seed" },
    );
    expect(created.status).toBe(201);
    // The record is open. This is the ONLY route that writes one.
    expect(created.body.status).toBe("NEW");
    expect(await opportunityCount()).toBe(before + 1);

    // And nobody was asked to confirm a decision a Managing Partner just made.
    const cards = await t.db
      .prepare("SELECT COUNT(*) AS n FROM work_card WHERE title LIKE '%Manual Route Co%'")
      .first<{ n: number }>();
    expect(cards!.n).toBe(0);
  });

  it("records the route on the row itself, so the board can tell a typed deal from an emailed one", async () => {
    const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: "Channel Co" });
    const created = await call<{ id: string; source_channel: string }>("/api/opportunities", MP, "POST", {
      company_id: company.body.id,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: "Channel Co — seed",
    });
    expect(created.body.source_channel.startsWith("manual:")).toBe(true);
    // `email:` is the prefix the dealflow board badges on. A partner's own entry must never wear it.
    expect(created.body.source_channel.startsWith("email:")).toBe(false);
  });

  it("still refuses a company that is not in the register, rather than inventing one", async () => {
    const res = await call<{ error: string }>("/api/opportunities", MP, "POST", {
      company_id: "cc_does_not_exist",
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: "Ghost",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_company");
    expect(
      (await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company WHERE canonical_name = 'Ghost'").first<{ n: number }>())!.n,
    ).toBe(0);
  });
});

// ── Route 2 of 4 ──

describe("route 2 · email — a hashtag routes and never authorises, and the company is in the pipeline anyway", () => {
  it("opens the company at the top of the funnel AND a card for the analyst to decide on it", async () => {
    const before = await opportunityCount();
    const res = await intakeDealFromEmail(env, {
      company: "Northwind Robotics",
      sector: "AI",
      one_liner: "Warehouse automation",
      website: null,
      from: "scout@example.com",
      isDeck: false,
      raw: "Company: Northwind Robotics",
    });
    const card = await cardOf(res.work_card_id);
    expect(card.owner_type).toBe("AI");
    // The employee's ID, not their display name. Asserting "Wyatt" pinned a live bug: `runEmployeeWork`
    // looks an owner up by `ai_employee.id`, so a card owned by a NAME answered "That employee does
    // not exist" and could never be worked — the whole route from an email to Wyatt acting on it died
    // at the last step, silently, with the test agreeing.
    expect(card.owner_id).toBe("aie_wyatt");
    expect(card.state).toBe("OPEN");
    // The card asks for the DECISION. It no longer asks anybody to put the company in the pipeline,
    // because it is there — the old wording ("then open it at the top of the funnel") is exactly
    // the instruction Vynlo's card carried to DONE without ever doing.
    expect(card.next_action).toMatch(/^It is at the top of the funnel now\. Decide on it/);
    expect(card.next_action).not.toContain("then open it");
    expect(card.next_action).not.toContain("hand to");
    expect(card.description).toContain(`Opportunity ${res.opportunity_id} is on the board`);

    // THE COMPANY IS IN THE PIPELINE. One opportunity, at NEW, opened by the seat that owns the top
    // of the funnel, wearing the `email:` prefix the board's badge keys on.
    expect(res.outcome).toBe("IN_FUNNEL");
    expect(await opportunityCount()).toBe(before + 1);
    const live = await liveOpportunities(res.company_id);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(res.opportunity_id);
    expect(live[0]!.status).toBe("NEW");
    expect(live[0]!.source_channel).toBe("email:scout@example.com");
    expect(live[0]!.created_by).toBe("aie_wyatt");
    expect(live[0]!.relationship_origin).toBe("INBOUND");
    // And the card is not the only record: the opportunity's own creation is on the spine.
    const created = await t.db
      .prepare("SELECT actor_type, actor_id FROM event_record WHERE event_type = 'investment.opportunity_created' AND object_id = ?1")
      .bind(res.opportunity_id)
      .first<{ actor_type: string; actor_id: string }>();
    expect(created).toEqual({ actor_type: "ai_employee", actor_id: "aie_wyatt" });
  });

  it("does not open a second opportunity for a company that already has a live one, and says so on the card", async () => {
    // A partner opened this one herself; then somebody emails about it.
    const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: "Twice Mailed Co" });
    const hers = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company.body.id, opportunity_type: "EARLY_STAGE_PRIMARY", title: "Twice Mailed Co — seed",
    });
    expect(hers.status).toBe(201);

    const again = await intakeDealFromEmail(env, {
      company: "Twice Mailed Co", sector: null, one_liner: null, website: null,
      from: "c@d.co", isDeck: false, raw: "second",
    });
    expect(again.outcome).toBe("ALREADY_OPEN");
    expect(again.company_id).toBe(company.body.id);
    expect(again.opportunity_id).toBe(hers.body.id);
    expect(await liveOpportunities(company.body.id)).toHaveLength(1);
    // The card for a company already on the board asks a different question.
    expect((await cardOf(again.work_card_id)).next_action).toContain("never open a second one");

    // And the same email twice is a retry: it joins the card rather than multiplying it.
    const retry = await intakeDealFromEmail(env, {
      company: "Twice Mailed Co", sector: null, one_liner: null, website: null,
      from: "c@d.co", isDeck: false, raw: "second, resent",
    });
    expect(retry.work_card_id).toBe(again.work_card_id);
    expect(await liveOpportunities(company.body.id)).toHaveLength(1);
  });

  it("opens a fresh opportunity when the only one the company had has left the board", async () => {
    const first = await intakeDealFromEmail(env, {
      company: "Came Back Co", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    await t.db.prepare("UPDATE investment_opportunity SET status = 'PASS' WHERE id = ?1").bind(first.opportunity_id).run();
    const back = await intakeDealFromEmail(env, {
      company: "Came Back Co", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "raising again",
    });
    expect(back.outcome).toBe("IN_FUNNEL");
    expect(back.opportunity_id).not.toBe(first.opportunity_id);
    expect(await liveOpportunities(first.company_id)).toHaveLength(1);
  });

  it("treats an ARCHIVED opportunity as not on the board, so the company is not stranded", async () => {
    const first = await intakeDealFromEmail(env, {
      company: "Archived Typo Co", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    await t.db
      .prepare("UPDATE investment_opportunity SET archived_at = ?2, archived_by = 'test', archive_reason = 'typo' WHERE id = ?1")
      .bind(first.opportunity_id, new Date().toISOString())
      .run();
    const back = await intakeDealFromEmail(env, {
      company: "Archived Typo Co", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    expect(back.outcome).toBe("IN_FUNNEL");
    expect(back.opportunity_id).not.toBe(first.opportunity_id);
    expect(await liveOpportunities(first.company_id)).toHaveLength(1);
  });

  it("does the lookup itself and puts the answer on the card", async () => {
    // Matching a name is arithmetic, not judgement. Making an employee redo it spends a model call
    // on something a query answers exactly.
    await t.db
      .prepare("INSERT INTO canonical_company (id, canonical_name, privacy_label, created_by) VALUES ('cc_nw','Nordwind Robotics','INTERNAL','test')")
      .run();

    const res = await intakeDealFromEmail(env, {
      company: "nordwind robotics, inc.",
      sector: null, one_liner: null, website: null,
      from: "someone@example.com", isDeck: true, raw: "",
    });
    // Matched despite the case, the comma and the "Inc." — those are one company.
    expect(res.company_id).toBe("cc_nw");
    expect(res.detail).toContain("already");
    // On record with no deal is the Northwind/Vynlo state, and it ends here: one opportunity opened.
    expect(res.outcome).toBe("IN_FUNNEL");
    expect(await liveOpportunities("cc_nw")).toHaveLength(1);

    const card = await cardOf(res.work_card_id);
    expect(card.description).toContain("already a company on record");
    // A deck says where the substance is, which changes what the employee does first.
    expect(card.prompt).toContain("attachment");
  });

  it("carries the sender, because an unauthenticated arrival is only reviewable with provenance", async () => {
    const res = await intakeDealFromEmail(env, {
      company: "Helios Grid", sector: null, one_liner: null, website: null,
      from: "founder@helios.example", isDeck: false, raw: "hello",
    });
    const card = await cardOf(res.work_card_id);
    expect(card.description).toContain("founder@helios.example");

    const arrival = await arrivalOf(res.arrival_event_id);
    expect(arrival.payload.route).toBe("EMAIL");
    expect(arrival.payload.source).toBe("founder@helios.example");
    expect(arrival.actor_type).toBe("system");
  });

  it("gives an unreadable one to Porter rather than guessing a company", async () => {
    // The rung below Wyatt, and deliberately NOT a funnel entry: there is no company to open.
    const cardId = await openRoutingCard(env, {
      subject: "#wpdealflow",
      from: "someone@example.com",
      raw: "have a look at this one",
      triggers: ["#wpdealflow"],
      why: "Tagged for deal flow, but no company name could be read out of it.",
    });
    const card = await cardOf(cardId);
    expect(card.owner_id).toBe("aie_porter");
    expect(card.title).toBe("Unclear email: #wpdealflow");
    // And if Porter cannot either, it has to reach a partner rather than sit.
    expect(card.next_action).toContain("BLOCKED");
    expect(card.prompt).toContain("confident wrong route");
  });

  it("says WHY it could not be handled, and does not call a clear email unclear", async () => {
    /*
     * A 14MB deck from a named founder is not unclear. It is clear and too large, and those two
     * have different fixes — one needs a human to read it, one needs the file fetched out of R2.
     * The oversize path used to pass a subject already reading "Too big to read: …" into a function
     * that hardcoded "Unclear email: ", so the card read BOTH. Home counts oversize cards with
     * `title LIKE 'Too big to read:%'`, which the doubled prefix made unmatchable.
     */
    const cardId = await openRoutingCard(env, {
      headline: "Too big to read",
      subject: "Sensori — updated deck",
      from: "scooter@example.com",
      raw: "",
      triggers: ["#wpdeck"],
      why: "It is 14.2MB — too large to open inside one request.",
    });
    const card = await cardOf(cardId);
    expect(card.title).toBe("Too big to read: Sensori — updated deck");
    expect(card.title).not.toContain("Unclear email");
    expect(card.owner_id).toBe("aie_porter");
  });
});

// ── Route 3 of 4 ──

describe("route 3 · Network OS — the partner system proposes, and the company is in the pipeline here", () => {
  it("opens the company at the top of the funnel and a card for the analyst to decide on it", async () => {
    const before = await opportunityCount();
    const res = await intakeCompanyFromNetworkOs(env, {
      company: "Crossing Point Labs",
      sector: "HEALTH_TECH",
      external_id: "contact_8812",
      pushed_by: "porter@network.joinwestpeek.com",
      note: "Met at the November room; raising a seed.",
    });
    expect(await opportunityCount()).toBe(before + 1);
    const live = await liveOpportunities(res.company_id);
    expect(live).toHaveLength(1);
    expect(live[0]!.source_channel).toBe("network_os:porter@network.joinwestpeek.com");
    expect(live[0]!.relationship_origin).toBe("NETWORK");

    const card = await cardOf(res.work_card_id);
    // The employee's ID, not their display name. Asserting "Wyatt" pinned a live bug: `runEmployeeWork`
    // looks an owner up by `ai_employee.id`, so a card owned by a NAME answered "That employee does
    // not exist" and could never be worked — the whole route from an email to Wyatt acting on it died
    // at the last step, silently, with the test agreeing.
    expect(card.owner_id).toBe("aie_wyatt");
    expect(card.description).toContain("Pushed across from Network OS");
    // Their key travels with it, so the same push twice is recognisable as one arrival.
    expect(card.description).toContain("contact_8812");
  });

  it("keeps who pushed it, from where, and when", async () => {
    const res = await intakeCompanyFromNetworkOs(env, {
      company: "Second Crossing Co",
      external_id: "contact_9001",
      pushed_by: "sequoia@network.joinwestpeek.com",
      received_at: "2026-08-19T09:00:00.000Z",
    });
    const arrival = await arrivalOf(res.arrival_event_id);
    expect(arrival.payload.route).toBe("NETWORK_OS");
    expect(arrival.payload.source).toBe("sequoia@network.joinwestpeek.com");
    expect(arrival.payload.external_ref).toBe("contact_9001");
    expect(arrival.payload.received_at).toBe("2026-08-19T09:00:00.000Z");
  });

  it("is reachable as a push, and answers with what the analyst now holds", async () => {
    const res = await call<FunnelEntry>("/api/network/dealflow", MP, "POST", {
      company: "Pushed By Api Co",
      pushed_by: "network-os",
    });
    expect(res.status).toBe(201);
    expect(res.body.route).toBe("NETWORK_OS");
    expect(res.body.owner).toBe("Wyatt");
    // The push answers with the opportunity it opened as well as the card — both, always.
    expect(res.body.opportunity_id).toMatch(/^opp_/);
    expect(res.body.opportunity.status).toBe("NEW");
    expect(res.body.work_card_id).toBeTruthy();
  });
});

// ── Route 4 of 4 ──

describe("route 4 · the analyst's own scouting", () => {
  it("lands on the same seat, through the same door, and in the pipeline", async () => {
    const before = await opportunityCount();
    const res = await intakeScoutedCompany(env, {
      company: "Quiet Ledger",
      one_liner: "Reconciliation for small funds",
      where: "Two portfolio founders named them in the same week",
    });
    expect(await opportunityCount()).toBe(before + 1);
    const live = await liveOpportunities(res.company_id);
    expect(live).toHaveLength(1);
    expect(live[0]!.source_channel).toBe("scout:Wyatt");
    // The firm went looking, so the origin says so.
    expect(live[0]!.relationship_origin).toBe("OUTBOUND");

    const card = await cardOf(res.work_card_id);
    // The employee's ID, not their display name. Asserting "Wyatt" pinned a live bug: `runEmployeeWork`
    // looks an owner up by `ai_employee.id`, so a card owned by a NAME answered "That employee does
    // not exist" and could never be worked — the whole route from an email to Wyatt acting on it died
    // at the last step, silently, with the test agreeing.
    expect(card.owner_id).toBe("aie_wyatt");
    expect(card.title).toContain("Scouted");
    expect(card.description).toContain("while scouting");
    expect(card.description).toContain("Two portfolio founders");
  });

  it("is reachable, and names the scout even when the request does not", async () => {
    const res = await call<FunnelEntry>("/api/dealflow/scouted", MP, "POST", { company: "Scouted By Api Co" });
    expect(res.status).toBe(201);
    expect(res.body.route).toBe("SCOUT");
    const arrival = await arrivalOf(res.body.arrival_event_id);
    expect(arrival.actor_type).toBe("ai_employee");
    // The seat's ID under `actorType: "ai_employee"`, never the display name. Asserting the name
    // pinned the divergence that made the company trail read "Wyatt (AI)" in some rows and
    // "aie_wyatt (AI)" in others — the same colleague, twice, for the same reason intake cards could
    // never be worked.
    expect(arrival.actor_id).toBe("aie_wyatt");
  });

  it("refuses a find with no company, rather than opening a card about nothing", async () => {
    const res = await call<{ error: string }>("/api/dealflow/scouted", MP, "POST", { note: "someone interesting" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });
});

// ── What may be thrown away, and by whom ──

describe("what an employee may throw away", () => {
  /**
   * Operator rule, 21 Aug 2026: "every arrival survives until i've seen it but it comes with a
   * recommendation to scrap it. however his proactive scout work he is allowed to scrap things on
   * his own. but never scrap our inbound stuff without our input."
   *
   * The test is not how obvious the no is — it is whether a person is on the other end of it.
   */
  it("tells the analyst plainly that an emailed arrival is not his to close", async () => {
    const res = await intakeDealFromEmail(env, {
      company: "Obvious Pass Co", sector: null, one_liner: null, website: null,
      from: "someone@example.com", isDeck: false, raw: "",
    });
    const card = await cardOf(res.work_card_id);
    expect(card.prompt).toContain("never close it yourself");
    expect(card.prompt).toContain("recommend");
    // And the distinction is on the card, not only in a method he may not re-read.
    expect(card.prompt).toContain("scouting");
  });

  it("says the same about a company Network OS pushed — inbound is inbound whoever sent it", async () => {
    const res = await intakeCompanyFromNetworkOs(env, { company: "Pushed Pass Co", pushed_by: "network-os" });
    const card = await cardOf(res.work_card_id);
    expect(card.prompt).toContain("never close it yourself");
  });

  it("lets him cut his own scouted list, and keeps what he cut on the pass pile", async () => {
    const res = await intakeScoutedCompany(env, { company: "His Own Near Miss" });
    const card = await cardOf(res.work_card_id);
    expect(card.prompt).toContain("yours to drop");
    expect(card.prompt).toContain("pass pile");
    // The exception is the rule's other half, and it is on the card too.
    expect(card.prompt).toMatch(/scrap[\s\S]{0,60}without a partner/i);
  });

  it("declares that difference once, in the route table, rather than in four prompts", () => {
    expect(ROUTE_POLICY.SCOUT.finderMayScrap).toBe(true);
    expect(ROUTE_POLICY.EMAIL.finderMayScrap).toBe(false);
    expect(ROUTE_POLICY.NETWORK_OS.finderMayScrap).toBe(false);
  });
});

// ── The consolidation itself ──

describe("all four routes converge on one entry point", () => {
  it("has exactly four routes, every one of them writes the pipeline, and the policy cannot say otherwise", () => {
    expect([...INTAKE_ROUTES].sort()).toEqual(["EMAIL", "MANUAL", "NETWORK_OS", "SCOUT"]);
    // `opensRecord` was the switch that let three routes skip the pipeline. It is gone as a
    // concept, and this pins that nobody re-introduces a switch under another name.
    for (const route of INTAKE_ROUTES) {
      expect(Object.keys(ROUTE_POLICY[route]).filter((k) => /open|write|record|pipeline|skip/i.test(k))).toEqual([]);
    }
    // The three unattended routes raise work for a named seat. None of them may land on nobody.
    for (const route of INTAKE_ROUTES.filter((r) => r !== "MANUAL")) {
      expect(ROUTE_POLICY[route].owner, `${route} must land on somebody`).toBeTruthy();
    }
  });

  it("leaves EXACTLY ONE live opportunity on the board whichever door a new company arrives by", async () => {
    /*
     * The whole rule in one loop. Each route, a company nobody has heard of, and afterwards: one
     * company in the register, one opportunity on the board at NEW, source_channel naming the
     * route. This is the test the two stranded production companies did not have.
     */
    const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: "Exactly One Manual Co" });
    const results: Array<{ route: IntakeRoute; entry: FunnelEntry }> = [
      {
        route: "MANUAL",
        entry: await openIntoFunnel(env, {
          route: "MANUAL",
          company: "Exactly One Manual Co",
          company_id: company.body.id,
          source: "Scooter Taylor",
          actor: { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] },
        }),
      },
      {
        route: "EMAIL",
        entry: await intakeDealFromEmail(env, {
          company: "Exactly One Email Co", sector: null, one_liner: null, website: null,
          from: "one@example.com", isDeck: false, raw: "",
        }),
      },
      { route: "NETWORK_OS", entry: await intakeCompanyFromNetworkOs(env, { company: "Exactly One Network Co", pushed_by: "network-os" }) },
      { route: "SCOUT", entry: await intakeScoutedCompany(env, { company: "Exactly One Scout Co" }) },
    ];
    for (const { route, entry } of results) {
      expect(entry.outcome, route).toBe("IN_FUNNEL");
      expect(entry.opportunity_id, `${route} must open an opportunity`).toMatch(/^opp_/);
      const live = await liveOpportunities(entry.company_id);
      expect(live, `${route} must leave exactly one live opportunity`).toHaveLength(1);
      expect(live[0]!.id).toBe(entry.opportunity_id);
      expect(live[0]!.status).toBe("NEW");
      expect(live[0]!.source_channel.startsWith(`${ROUTE_POLICY[route].channel}:`), `${route} must stamp its channel`).toBe(true);
      // The arrival on the spine points at the opportunity, on every route.
      const arrival = await t.db
        .prepare("SELECT object_type, object_id FROM event_record WHERE id = ?1")
        .bind(entry.arrival_event_id)
        .first<{ object_type: string; object_id: string }>();
      expect(arrival).toEqual({ object_type: "investment_opportunity", object_id: entry.opportunity_id });
    }
  });

  it("records who, by which route, and when — on every route without exception", async () => {
    const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: "Convergence Manual Co" });
    const manual = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company.body.id,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: "Convergence Manual Co — seed",
    });
    expect(manual.status).toBe(201);

    const entries: Array<{ route: IntakeRoute; event: string | null }> = [
      { route: "MANUAL", event: null },
      {
        route: "EMAIL",
        event: (
          await intakeDealFromEmail(env, {
            company: "Convergence Email Co",
            sector: null, one_liner: null, website: null,
            from: "founder@convergence.example", isDeck: false, raw: "",
          })
        ).arrival_event_id,
      },
      {
        route: "NETWORK_OS",
        event: (await intakeCompanyFromNetworkOs(env, { company: "Convergence Network Co", pushed_by: "network-os" })).arrival_event_id,
      },
      { route: "SCOUT", event: (await intakeScoutedCompany(env, { company: "Convergence Scout Co" })).arrival_event_id },
    ];

    // The manual one is found by its object rather than a returned id, because that route answers
    // with the opportunity row — which is exactly the point: the caller sees no difference.
    const manualArrivalRow = await t.db
      .prepare("SELECT id FROM event_record WHERE event_type = 'dealflow.arrival' AND object_id = ?1")
      .bind(manual.body.id)
      .first<{ id: string }>();
    expect(manualArrivalRow, "the manual door writes an arrival like every other route").toBeTruthy();
    entries[0]!.event = manualArrivalRow!.id;

    for (const { route, event } of entries) {
      const arrival = await arrivalOf(event!);
      expect(arrival.payload.route, `${route} must name its own route`).toBe(route);
      expect(arrival.payload.source, `${route} must say who`).toBeTruthy();
      expect(typeof arrival.payload.received_at, `${route} must say when`).toBe("string");
      expect(Number.isNaN(Date.parse(arrival.payload.received_at))).toBe(false);
    }
  });

  it("matches an existing company first, whichever route it arrives on", async () => {
    await t.db
      .prepare("INSERT INTO canonical_company (id, canonical_name, privacy_label, created_by) VALUES ('cc_shared','Shared Match Co','INTERNAL','test')")
      .run();
    await t.db
      .prepare("INSERT INTO company_alias (id, company_id, alias) VALUES ('ca_shared','cc_shared','Sharedmatch')")
      .run();

    const email = await intakeDealFromEmail(env, {
      company: "shared match co.", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    const network = await intakeCompanyFromNetworkOs(env, { company: "SHARED MATCH CO", pushed_by: "network-os" });
    const scouted = await intakeScoutedCompany(env, { company: "Sharedmatch" });

    // One company, three routes, no second row for it anywhere.
    expect(email.company_id).toBe("cc_shared");
    expect(network.company_id).toBe("cc_shared");
    expect(scouted.company_id).toBe("cc_shared");
    // And the alias resolved as an alias, which is the register's own answer rather than a guess.
    expect((await matchFunnelCompany(env, "Sharedmatch"))!.matched_via).toBe("alias");
    expect(
      (await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company WHERE canonical_name LIKE 'Shared Match%'").first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it("matches when the suffix sits in the MIDDLE of the name, not only at the end", async () => {
    /*
     * "Shared Match Co" put the suffix last, which the normaliser handled, and every test used that
     * shape. Stripping a suffix from the middle left a double space behind it — "acme  labs" against
     * "acme labs" — so "Acme Inc Labs" and "Acme Labs" read as two different companies and the
     * funnel grew a duplicate. A suffix is least recognisable as a suffix exactly where it is not
     * last, which is why this case is the one that shipped broken.
     */
    await t.db
      .prepare("INSERT INTO canonical_company (id, canonical_name, privacy_label, created_by) VALUES ('cc_middle','Acme Labs','INTERNAL','test')")
      .run();

    const match = await matchFunnelCompany(env, "Acme Inc Labs");
    expect(match?.id).toBe("cc_middle");

    const arrival = await intakeDealFromEmail(env, {
      company: "Acme, Inc. Labs", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    expect(arrival.company_id).toBe("cc_middle");
    expect(
      (await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company WHERE canonical_name LIKE 'Acme%'").first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it("matches a subject line EXACTLY, and leaves the guessing to the deck", async () => {
    /*
     * WHAT THIS TEST USED TO ASSERT, AND WHY IT NO LONGER DOES.
     *
     * Production, 23 Aug 2026: Scooter emailed a deck with the subject "Sensori Deck". Sensori had
     * been on the board since 18 Aug. The reader matched on the whole subject — `sensori deck` is
     * not `sensori` — and created a SECOND company called "Sensori Deck".
     *
     * My first fix stripped words like "deck", "pitch" and "v2" out of the subject before matching.
     * It passed, and it was the wrong mechanism: a subject is whatever somebody typed while
     * forwarding, and the operator had already said "the subjects will all be different". A word
     * list settles the shapes I thought of and misses the next one.
     *
     * Her question settled it — "shouldnt the deck itself be the deciding factor on what the name
     * is?" `deckQueue` now READS the deck before deciding whose it is and matches on the company's
     * own name for itself. So this function's job shrank back to the honest one: if a subject
     * happens to name a company the register already holds, say so.
     */
    await t.db
      .prepare("INSERT INTO canonical_company (id, canonical_name, privacy_label, created_by) VALUES ('cc_subj','Sensori','INTERNAL','test')")
      .run();

    expect((await companyFromSubject(env, "#wpdeck Sensori"))?.id, "the tag is stripped, the name is not").toBe("cc_subj");
    expect((await companyFromSubject(env, "Fwd: Re: Sensori"))?.id, "forwarding prefixes are not part of the name").toBe("cc_subj");

    // NOT MATCHED HERE, and deliberately. "Sensori Deck" is resolved by the deck's own name in
    // `deckQueue`, which is evidence rather than a guess about what a human meant by a subject.
    expect(await companyFromSubject(env, "Sensori Deck"), "a subject is not a name; the deck decides").toBeNull();
    expect(await companyFromSubject(env, "Vynlo Deck"), "it may only find what the register holds").toBeNull();
  });

  it("gives two different companies two different cards, and one company twice a single card", async () => {
    // The dedupe rule is (machine, object, owner). Every arrival for the funnel shares a machine and
    // an owner, so without the object the second company emailed in joins the first one's card and
    // is never seen again. That is not a hypothetical: it shipped.
    const first = await intakeDealFromEmail(env, {
      company: "Dedupe One", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    const second = await intakeDealFromEmail(env, {
      company: "Dedupe Two", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    expect(second.work_card_id).not.toBe(first.work_card_id);

    // The same company arriving twice is a retry, and a retry joins rather than multiplying.
    const again = await intakeDealFromEmail(env, {
      company: "Dedupe One", sector: null, one_liner: null, website: null,
      from: "a@b.co", isDeck: false, raw: "",
    });
    expect(again.work_card_id).toBe(first.work_card_id);
  });

  it("refuses a MANUAL arrival with nobody to put the partner's name to", async () => {
    /*
     * The manual route writes the opportunity under the partner who pressed the button. Take the
     * actor away and it must refuse rather than write a partner's decision with no partner behind
     * it. (The unattended routes do not need one: their opportunity is opened by the seat that owns
     * the top of the funnel, and the decision is what the card asks a person for.)
     */
    await expect(
      openIntoFunnel(env, { route: "MANUAL", company: "Unattributed Co", source: "nobody" }),
    ).rejects.toThrow(/needs the actor/);
    expect(
      (await t.db
        .prepare("SELECT COUNT(*) AS n FROM investment_opportunity o JOIN canonical_company c ON c.id = o.company_id WHERE c.canonical_name = 'Unattributed Co'")
        .first<{ n: number }>())!.n,
      "no opportunity may be opened without somebody to attribute it to",
    ).toBe(0);
  });
});
