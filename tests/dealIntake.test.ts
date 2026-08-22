import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { dealFromMessage, intakeDealFromEmail } from "../src/worker/services/dealIntake";

/**
 * A company arriving by email enters the FUNNEL.
 *
 * Operator correction, 21 Aug 2026: "#wpdeck should skip capture and an ai employee who deals
 * w/the deal flow should enter it into the funnel... capture page is for things we manually want
 * to capture. the top of the funnel is the deal flow tab."
 */

let t: TestDb;
let env: Env;

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

describe("what happens to it", () => {
  it("opens the company and an opportunity at the first stage of the spine", async () => {
    const res = await intakeDealFromEmail(env, {
      company: "Northwind Robotics",
      sector: "AI",
      one_liner: null,
      website: null,
      from: "scout@example.com",
      isDeck: false,
      raw: "Company: Northwind Robotics",
    });
    expect(res.outcome).toBe("OPENED");
    expect(res.opportunity_id).toBeTruthy();

    const opp = await t.db
      .prepare("SELECT status, source_channel FROM investment_opportunity WHERE id = ?1")
      .bind(res.opportunity_id)
      .first<{ status: string; source_channel: string }>();
    // Arriving by email advances nothing. A hashtag routes; it never authorises.
    expect(opp!.status).toBe("NEW");
    expect(opp!.source_channel).toBe("email:#wpdealflow");
  });

  it("never builds a second row for a company already on the board", async () => {
    const again = await intakeDealFromEmail(env, {
      company: "northwind robotics, inc.",
      sector: null,
      one_liner: null,
      website: null,
      from: "someone@example.com",
      isDeck: true,
      raw: "",
    });
    // Matched despite the case, the comma and the "Inc." — those are one company.
    expect(again.outcome).toBe("ALREADY_OPEN");

    const n = await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("fills in a blank from a later deck but never overwrites what a person typed", async () => {
    await t.db.prepare("UPDATE canonical_company SET one_liner = NULL, sector = 'Robotics'").run();

    await intakeDealFromEmail(env, {
      company: "Northwind Robotics",
      sector: "AI",                       // already set to Robotics by a human — must not change
      one_liner: "Warehouse automation",  // empty — this is the gap the deck fills
      website: null,
      from: "founder@northwind.io",
      isDeck: true,
      raw: "",
    });

    const c = await t.db.prepare("SELECT sector, one_liner FROM canonical_company").first<{ sector: string; one_liner: string }>();
    expect(c!.one_liner).toBe("Warehouse automation");
    // The deck is newer, not more authoritative.
    expect(c!.sector).toBe("Robotics");
  });
});
