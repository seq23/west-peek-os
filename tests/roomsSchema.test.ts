import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, type TestDb } from "./helpers/db";

/**
 * The guarantees that live in SQLite rather than in TypeScript (migration 0044).
 *
 * A rule enforced only in a service holds until the next service writes to the same table. These
 * are the three that must survive that: a venue cannot exist without a source, a member's history
 * cannot be rewritten, and a Council decision cannot be unexplained.
 */

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.prepare("INSERT INTO person (id, full_name, email) VALUES ('per_ada','Ada Chen','ada@example.com')").run();
  await t.db.prepare(
    `INSERT INTO evt_room_packet (id, title, theme, proposed_for_month, created_by)
     VALUES ('rpk_1','The Zero-to-One Room','operator to founder','2027-03','Parker')`,
  ).run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

const insertVenue = (id: string, source: string) =>
  t.db.prepare("INSERT INTO evt_packet_venue (id, packet_id, name, source_url) VALUES (?1,'rpk_1','Somewhere',?2)")
    .bind(id, source).run();

describe("a venue cannot exist without a source", () => {
  it("accepts a real URL", async () => {
    await expect(insertVenue("rpv_ok", "https://www.gramercytavern.com/private-dining")).resolves.toBeDefined();
  });

  it("refuses an empty or stub source", async () => {
    // The service drops these too, but the table is what makes it true for every future writer.
    await expect(insertVenue("rpv_empty", "")).rejects.toThrow();
    await expect(insertVenue("rpv_stub", "n/a")).rejects.toThrow();
  });

  it("defaults to UNVERIFIED, so nothing is trusted until someone has called", async () => {
    const row = await t.db.prepare("SELECT verification FROM evt_packet_venue WHERE id = 'rpv_ok'")
      .first<{ verification: string }>();
    expect(row?.verification).toBe("UNVERIFIED");
  });
});

describe("a member's history cannot be rewritten", () => {
  beforeAll(async () => {
    await t.db.prepare(
      `INSERT INTO com_act (id, person_id, kind, source, occurred_at, recorded_by)
       VALUES ('cma_1','per_ada','HOSTED','PARTNER_ENTRY','2027-03-11','seq')`,
    ).run();
  });

  it("refuses to change what happened", async () => {
    await expect(
      t.db.prepare("UPDATE com_act SET kind = 'MISSED_COMMITMENT' WHERE id = 'cma_1'").run(),
    ).rejects.toThrow(/append-only/);

    await expect(
      t.db.prepare("UPDATE com_act SET person_id = 'per_other' WHERE id = 'cma_1'").run(),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses DELETE", async () => {
    await expect(t.db.prepare("DELETE FROM com_act WHERE id = 'cma_1'").run()).rejects.toThrow(/append-only/);
  });

  it("allows a retraction, because a mis-keyed act is a real thing that happens", async () => {
    await t.db.prepare(
      "UPDATE com_act SET retracted_at = '2027-03-12', retracted_by = 'seq', retraction_reason = 'wrong person' WHERE id = 'cma_1'",
    ).run();
    const row = await t.db.prepare("SELECT retracted_by FROM com_act WHERE id = 'cma_1'").first<{ retracted_by: string }>();
    expect(row?.retracted_by).toBe("seq");
  });

  it("allows a note to be added without touching the substance", async () => {
    await expect(t.db.prepare("UPDATE com_act SET note = 'ran the founder table' WHERE id = 'cma_1'").run())
      .resolves.toBeDefined();
  });
});

describe("a Council decision must be explainable a year later", () => {
  it("refuses a decision with no real reason", async () => {
    await expect(
      t.db.prepare(
        "INSERT INTO com_council_decision (id, person_id, in_council, reason, decided_by) VALUES ('ccd_x','per_ada',1,'yes','seq')",
      ).run(),
    ).rejects.toThrow();
  });

  it("accepts one with a reason, and keeps it as history rather than a flag", async () => {
    await t.db.prepare(
      `INSERT INTO com_council_decision (id, person_id, in_council, reason, decided_by)
       VALUES ('ccd_1','per_ada',1,'Hosted the March Room and consistently helps first-time founders.','seq')`,
    ).run();

    await expect(
      t.db.prepare("UPDATE com_council_decision SET in_council = 0 WHERE id = 'ccd_1'").run(),
    ).rejects.toThrow(/append-only/);
  });
});

describe("early inclusion is capturable on a deal", () => {
  it("defaults to UNRECORDED rather than guessing", async () => {
    // A default of INBOUND or OTHER would quietly assert something nobody checked. UNRECORDED is
    // the honest state and makes "we never captured this" countable.
    await t.db.prepare(
      `INSERT INTO canonical_company (id, canonical_name, firm_scope, created_by)
       VALUES ('cc_1','Northwind','west-peek','seq')`,
    ).run();
    await t.db.prepare(
      `INSERT INTO investment_opportunity (id, company_id, opportunity_type, title, status, firm_scope, created_by)
       VALUES ('opp_1','cc_1','EARLY_STAGE_PRIMARY','Northwind seed','NEW','west-peek','seq')`,
    ).run();

    const row = await t.db.prepare("SELECT relationship_origin FROM investment_opportunity WHERE id = 'opp_1'")
      .first<{ relationship_origin: string }>();
    expect(row?.relationship_origin).toBe("UNRECORDED");
  });

  it("records where the relationship started and when — the gap is the whole point", async () => {
    await t.db.prepare(
      `UPDATE investment_opportunity SET relationship_origin = 'ROOM', relationship_started_at = '2026-03-11'
       WHERE id = 'opp_1'`,
    ).run();
    const row = await t.db.prepare(
      "SELECT relationship_origin, relationship_started_at FROM investment_opportunity WHERE id = 'opp_1'",
    ).first<{ relationship_origin: string; relationship_started_at: string }>();
    expect(row).toEqual({ relationship_origin: "ROOM", relationship_started_at: "2026-03-11" });
  });

  it("refuses an origin outside the vocabulary", async () => {
    await expect(
      t.db.prepare("UPDATE investment_opportunity SET relationship_origin = 'VIBES' WHERE id = 'opp_1'").run(),
    ).rejects.toThrow();
  });
});

describe("one live introduction suggestion per pair", () => {
  it("refuses the same pair twice, so the same match is not proposed every month", async () => {
    await t.db.prepare("INSERT INTO person (id, full_name) VALUES ('per_dev','Dev Patel')").run();
    await t.db.prepare(
      `INSERT INTO rel_match_suggestion (id, person_a_id, person_b_id, rationale)
       VALUES ('rms_1','per_ada','per_dev','Ada is making a first engineering hire; Dev made three last year.')`,
    ).run();

    await expect(
      t.db.prepare(
        `INSERT INTO rel_match_suggestion (id, person_a_id, person_b_id, rationale)
         VALUES ('rms_2','per_ada','per_dev','Same pair again.')`,
      ).run(),
    ).rejects.toThrow();
  });

  it("needs both consents before it is anything but a suggestion", async () => {
    const row = await t.db.prepare("SELECT status, consent_a, consent_b FROM rel_match_suggestion WHERE id = 'rms_1'")
      .first<{ status: string; consent_a: number; consent_b: number }>();
    expect(row).toEqual({ status: "PROPOSED", consent_a: 0, consent_b: 0 });
  });
});

describe("Rooms sit on the existing event record", () => {
  it("classes an event without rebuilding the event_type vocabulary", async () => {
    await t.db.prepare(
      `INSERT INTO evt_event (id, title, event_type, event_class, cadence, theme, created_by)
       VALUES ('evt_r1','The Zero-to-One Room','DINNER','ROOM','MONTHLY','operator to founder','seq')`,
    ).run();
    const row = await t.db.prepare("SELECT event_type, event_class, cadence FROM evt_event WHERE id = 'evt_r1'")
      .first<{ event_type: string; event_class: string; cadence: string }>();
    // A Room that is a dinner: class is the product line, type is the form it takes.
    expect(row).toEqual({ event_type: "DINNER", event_class: "ROOM", cadence: "MONTHLY" });
  });

  it("carries Tap In Tuesday as a weekly Office on westpeek.live", async () => {
    await t.db.prepare(
      `INSERT INTO evt_event (id, title, event_class, cadence, live_url, created_by)
       VALUES ('evt_o1','Tap In Tuesday','OFFICE','WEEKLY','https://westpeek.live/office','seq')`,
    ).run();
    const row = await t.db.prepare("SELECT event_class, cadence, live_url FROM evt_event WHERE id = 'evt_o1'")
      .first<{ event_class: string; cadence: string; live_url: string }>();
    expect(row).toEqual({ event_class: "OFFICE", cadence: "WEEKLY", live_url: "https://westpeek.live/office" });
  });
});
