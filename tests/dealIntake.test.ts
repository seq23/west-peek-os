import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { dealFromMessage, intakeDealFromEmail, openRoutingCard } from "../src/worker/services/dealIntake";

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
  /**
   * Operator, after two wrong versions: "its about opening a work card for Wyatt to route it
   * appropriately to the next ai employee who then adds it to the deal flow funnel... its about
   * creating work cards for these employees to do the things."
   *
   * So these assert on the CARD — its owner, and whether it tells whoever picks it up what to do
   * next — rather than on anything appearing in the funnel. Nothing enters the pipeline until an
   * employee puts it there.
   */
  it("opens a work card for the analyst, not a row in the funnel", async () => {
    const res = await intakeDealFromEmail(env, {
      company: "Northwind Robotics",
      sector: "AI",
      one_liner: "Warehouse automation",
      website: null,
      from: "scout@example.com",
      isDeck: false,
      raw: "Company: Northwind Robotics",
    });
    expect(res.work_card_id).toBeTruthy();

    const card = await t.db
      .prepare("SELECT owner_type, owner_id, state, next_action, title FROM work_card WHERE id = ?1")
      .bind(res.work_card_id)
      .first<{ owner_type: string; owner_id: string; state: string; next_action: string; title: string }>();
    expect(card!.owner_type).toBe("AI");
    expect(card!.owner_id).toBe("Wyatt");
    expect(card!.state).toBe("OPEN");
    // Wyatt OWNS the top of the funnel, so he adds it himself. Inventing a hand-off would put a
    // second desk between an email and a decision that is already this seat's job.
    expect(card!.next_action).toContain("top of the funnel");
    expect(card!.next_action).not.toContain("hand to");

    // Nothing has entered the pipeline. An email is a claim to check, not a decision made.
    const opps = await t.db.prepare("SELECT COUNT(*) AS n FROM investment_opportunity").first<{ n: number }>();
    expect(opps!.n).toBe(0);
  });

  it("does the lookup itself and puts the answer on the card", async () => {
    // Matching a name is arithmetic, not judgement. Making an employee redo it spends a model call
    // on something a query answers exactly.
    await t.db
      .prepare("INSERT INTO canonical_company (id, canonical_name, privacy_label, created_by) VALUES ('cc_nw','Northwind Robotics','INTERNAL','test')")
      .run();

    const res = await intakeDealFromEmail(env, {
      company: "northwind robotics, inc.",
      sector: null, one_liner: null, website: null,
      from: "someone@example.com", isDeck: true, raw: "",
    });
    // Matched despite the case, the comma and the "Inc." — those are one company.
    expect(res.company_id).toBe("cc_nw");
    expect(res.detail).toContain("already");

    const card = await t.db.prepare("SELECT description, prompt FROM work_card WHERE id = ?1").bind(res.work_card_id).first<{ description: string; prompt: string }>();
    expect(card!.description).toContain("already a company on record");
    // A deck says where the substance is, which changes what the employee does first.
    expect(card!.prompt).toContain("attachment");
  });

  it("gives an unreadable one to Porter rather than guessing a company", async () => {
    // The rung below Wyatt. Guessing a name out of prose would put a confidently wrong company at
    // the top of the funnel, and somebody has to notice it is wrong before they can delete it.
    const cardId = await openRoutingCard(env, {
      subject: "#wpdealflow",
      from: "someone@example.com",
      raw: "have a look at this one",
      triggers: ["#wpdealflow"],
      why: "Tagged for deal flow, but no company name could be read out of it.",
    });
    const card = await t.db
      .prepare("SELECT owner_id, next_action, prompt FROM work_card WHERE id = ?1")
      .bind(cardId)
      .first<{ owner_id: string; next_action: string; prompt: string }>();
    expect(card!.owner_id).toBe("Porter");
    // And if Porter cannot either, it has to reach a partner rather than sit.
    expect(card!.next_action).toContain("BLOCKED");
    expect(card!.prompt).toContain("confident wrong route");
  });

  it("carries the sender, because an unauthenticated arrival is only reviewable with provenance", async () => {
    const res = await intakeDealFromEmail(env, {
      company: "Helios Grid", sector: null, one_liner: null, website: null,
      from: "founder@helios.example", isDeck: false, raw: "hello",
    });
    const card = await t.db.prepare("SELECT description FROM work_card WHERE id = ?1").bind(res.work_card_id).first<{ description: string }>();
    expect(card!.description).toContain("founder@helios.example");
  });
});
