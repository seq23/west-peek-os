import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * ITEM 7 — every route into the funnel converges on one governed entry point.
 *
 * The issues list: "Four uncontrolled routes already exist while the page claims 'the only way in'.
 * Consolidate before adding." The page has stopped lying; these tests are the other half. There is
 * one function — `openIntoFunnel` — and four routes that differ only in what they hand it and who
 * picks up the card.
 *
 * THE SHAPE OF THIS FILE IS THE CLAIM. One describe per route, each proving the same three things
 * (it matched first, it produced the right kind of outcome, it recorded provenance), then one block
 * that asserts the convergence directly. If a fifth route is ever added, it belongs here or it is
 * not consolidated.
 *
 * Operator, after two wrong versions: "its not about going str8 to the funnel is about opening a
 * work card for Wyatt to route it appropriately", and "its about creating work cards for these
 * employees to do the things." So three of the four assert on the CARD, not on the pipeline.
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

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
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

describe("route 2 · email — a hashtag routes and never authorises", () => {
  it("opens a work card for the analyst, not a row in the funnel", async () => {
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
    // Wyatt OWNS the top of the funnel, so he adds it himself. Inventing a hand-off would put a
    // second desk between an email and a decision that is already this seat's job.
    expect(card.next_action).toContain("top of the funnel");
    expect(card.next_action).not.toContain("hand to");

    // Nothing has entered the pipeline. An email is a claim to check, not a decision made.
    expect(await opportunityCount()).toBe(before);
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
    // And if Porter cannot either, it has to reach a partner rather than sit.
    expect(card.next_action).toContain("BLOCKED");
    expect(card.prompt).toContain("confident wrong route");
  });
});

// ── Route 3 of 4 ──

describe("route 3 · Network OS — the partner system proposes, it does not write", () => {
  it("opens a card for the analyst rather than a row in the funnel", async () => {
    const before = await opportunityCount();
    const res = await intakeCompanyFromNetworkOs(env, {
      company: "Crossing Point Labs",
      sector: "HEALTH_TECH",
      external_id: "contact_8812",
      pushed_by: "porter@network.joinwestpeek.com",
      note: "Met at the November room; raising a seed.",
    });
    expect(await opportunityCount()).toBe(before);

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
    expect(res.body.opportunity_id).toBeNull();
    expect(res.body.work_card_id).toBeTruthy();
  });
});

// ── Route 4 of 4 ──

describe("route 4 · the analyst's own scouting", () => {
  it("lands on the same seat, through the same door", async () => {
    const before = await opportunityCount();
    const res = await intakeScoutedCompany(env, {
      company: "Quiet Ledger",
      one_liner: "Reconciliation for small funds",
      where: "Two portfolio founders named them in the same week",
    });
    expect(await opportunityCount()).toBe(before);

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
    expect(arrival.actor_id).toBe("Wyatt");
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
  it("has exactly four routes, and exactly one of them writes the pipeline", () => {
    expect([...INTAKE_ROUTES].sort()).toEqual(["EMAIL", "MANUAL", "NETWORK_OS", "SCOUT"]);
    const writers = INTAKE_ROUTES.filter((r) => ROUTE_POLICY[r].opensRecord);
    expect(writers).toEqual(["MANUAL"]);
    // The other three raise work for a named seat. None of them may land on nobody.
    for (const route of INTAKE_ROUTES.filter((r) => !ROUTE_POLICY[r].opensRecord)) {
      expect(ROUTE_POLICY[route].owner, `${route} must land on somebody`).toBeTruthy();
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

  it("refuses to open the record for a route that has nobody to attribute the decision to", async () => {
    // The governance in one line: the manual route writes because a partner is behind it. Take the
    // actor away and the door must refuse rather than write something nobody decided.
    await expect(
      openIntoFunnel(env, { route: "MANUAL", company: "Unattributed Co", source: "nobody" }),
    ).rejects.toThrow(/needs the actor/);
    expect(
      (await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company WHERE canonical_name = 'Unattributed Co'").first<{ n: number }>())!.n,
    ).toBe(0);
  });
});
