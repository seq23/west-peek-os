import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { deriveItems, mergeItems } from "../src/worker/services/weeklyReview";
import { REVIEW_HEADINGS, guessHeading, isResolved, weekEnd, weekStart } from "../src/shared/review/weeklyAgenda";

/**
 * The weekly MP operating review (P37, V1 #18, canon §8).
 *
 * Every derivation query is raw SQL against a table this module does not own, so the tests exist
 * mainly to run them. A column rename anywhere upstream turns a heading silently empty, and an
 * empty heading looks exactly like "nothing happened this week".
 */

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const run = (sql: string) => env.WP_OS_DB.prepare(sql).run();

  await run(`INSERT INTO approval_card (id, action_key, object_type, object_id, title, requested_by_type, requested_by_id, required_approver_roles_json, state, firm_scope)
    VALUES ('ac_wr','effect.email.send','external_effect_request','x','Send LP update','HUMAN','fu_scooter_taylor','["MANAGING_PARTNER"]','pending_review','west-peek')`);
  await run(`INSERT INTO canonical_company (id, canonical_name, created_by, firm_scope) VALUES ('cc_wr','Probe Co','fu_scooter_taylor','west-peek')`);
  await run(`INSERT INTO investment_opportunity (id, company_id, opportunity_type, title, status, created_by, firm_scope)
    VALUES ('opp_wr_p','cc_wr','EARLY_STAGE_PRIMARY','Probe seed','NEW','fu_scooter_taylor','west-peek'),
           ('opp_wr_s','cc_wr','SECONDARY_PURCHASE','Probe secondary','NEW','fu_scooter_taylor','west-peek'),
           ('opp_wr_x','cc_wr','EARLY_STAGE_PRIMARY','Passed deal','PASS','fu_scooter_taylor','west-peek')`);
  await run(`INSERT INTO contradiction_record (id, contradiction_type, topic, materiality, status, proposed_by_type, proposed_by_id, firm_scope)
    VALUES ('cr_wr','VALUE','ARR disagreement','HIGH','OPEN','HUMAN','fu_scooter_taylor','west-peek')`);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("canon §8 structure", () => {
  it("has all sixteen headings", () => {
    expect(REVIEW_HEADINGS).toHaveLength(16);
  });

  it("starts the week on Wednesday, the day the firm meets", () => {
    // Was Monday, which put the meeting in the middle of the week it was reviewing. A Sunday still
    // belongs to the week that began earlier rather than starting a new one.
    expect(weekStart(new Date("2026-08-19T12:00:00Z"))).toBe("2026-08-19"); // Wed → itself
    expect(weekStart(new Date("2026-08-17T00:00:00Z"))).toBe("2026-08-12"); // Mon → prior Wed
    expect(weekStart(new Date("2026-08-23T23:59:00Z"))).toBe("2026-08-19"); // Sun → same week
  });
});

describe("derivation runs against live state", () => {
  it("executes every query without a column error", async () => {
    // The point of this test: SQL is invisible to TypeScript, and these queries touch ten tables
    // this module does not own.
    const items = await deriveItems(env, "west-peek");
    expect(Array.isArray(items)).toBe(true);
  });

  it("surfaces a pending approval under decisions required", async () => {
    const items = await deriveItems(env, "west-peek");
    const d = items.filter((i) => i.heading === "decisions_required");
    expect(d.some((i) => i.body.includes("Send LP update"))).toBe(true);
  });

  it("keeps primaries and secondaries in separate headings", async () => {
    // Canon §10.1: the two sleeves stay distinct. Collapsing them here would undo that.
    const items = await deriveItems(env, "west-peek");
    expect(items.some((i) => i.heading === "early_stage" && i.body.includes("Probe seed"))).toBe(true);
    expect(items.some((i) => i.heading === "secondary" && i.body.includes("Probe secondary"))).toBe(true);
  });

  it("excludes a passed opportunity", async () => {
    const items = await deriveItems(env, "west-peek");
    expect(items.some((i) => i.body.includes("Passed deal"))).toBe(false);
  });

  it("treats an unresolved contradiction as a risk", async () => {
    const items = await deriveItems(env, "west-peek");
    expect(items.some((i) => i.heading === "risks_unresolved" && i.body.includes("ARR disagreement"))).toBe(true);
  });

  it("carries a source back to the record for every item", async () => {
    // An agenda line a partner cannot click through to is an assertion.
    for (const i of await deriveItems(env, "west-peek")) {
      expect(i.source_type).toBeTruthy();
      expect(i.source_id).toBeTruthy();
    }
  });
});

describe("merging both partners' briefs", () => {
  const base = { heading: "decisions_required" as const, body: "x", source_type: "approval_card", source_id: "a1" };

  it("collapses the same record raised twice", () => {
    expect(mergeItems([{ ...base, raised_by: "SCOOTER" }, { ...base, raised_by: "SCOOTER" }])).toHaveLength(1);
  });

  it("marks BOTH when each partner raised it", () => {
    const out = mergeItems([{ ...base, raised_by: "SCOOTER" }, { ...base, raised_by: "SEQUOIA" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.raised_by).toBe("BOTH");
  });

  it("PRESERVES a single partner's attribution", () => {
    // Canon §8 asks the merge to preserve both partners' positions. "Only Sequoia raised this" is
    // often the most useful line in the review, and a naive dedupe destroys it.
    const out = mergeItems([{ ...base, raised_by: "SEQUOIA" }]);
    expect(out[0]!.raised_by).toBe("SEQUOIA");
  });

  it("keeps distinct records apart", () => {
    const out = mergeItems([{ ...base, raised_by: "BOTH" }, { ...base, source_id: "a2", raised_by: "BOTH" }]);
    expect(out).toHaveLength(2);
  });
});

describe("resolution", () => {
  it("is not resolved while anything is UNRESOLVED", () => {
    expect(isResolved([{ exit_type: "DECISION" }, { exit_type: "UNRESOLVED" }])).toBe(false);
  });

  it("is resolved when every item has an exit", () => {
    expect(isResolved([{ exit_type: "DECISION" }, { exit_type: "DEFERRED_ITEM" }])).toBe(true);
  });

  it("an empty agenda is not 'resolved'", () => {
    // Otherwise a review that failed to generate would report itself complete.
    expect(isResolved([])).toBe(false);
  });
});

/**
 * The Wednesday cadence, the capture box, and exits that exit somewhere.
 *
 * The week used to start on Monday while the firm met on Wednesday, which put the meeting in the
 * middle of the period it was reviewing — everything decided in the room landed in the NEXT week's
 * agenda instead of closing out the one on the table.
 */
describe("the week runs Wednesday to Tuesday", () => {
  it("puts Wednesday at the start of its own week", () => {
    // The meeting day opens the week it is about, which is what lets the agenda close anything.
    expect(weekStart(new Date("2026-08-19T09:00:00Z"))).toBe("2026-08-19"); // a Wednesday
    expect(weekEnd("2026-08-19")).toBe("2026-08-25"); // the Tuesday after
  });

  it("puts Tuesday at the END of the week that began the previous Wednesday", () => {
    expect(weekStart(new Date("2026-08-25T23:00:00Z"))).toBe("2026-08-19");
  });

  it("rolls to a new week on Wednesday, not on Monday", () => {
    expect(weekStart(new Date("2026-08-24T12:00:00Z"))).toBe("2026-08-19"); // Monday — same week
    expect(weekStart(new Date("2026-08-26T00:30:00Z"))).toBe("2026-08-26"); // Wednesday — new week
  });
});

describe("guessing where a typed thought belongs", () => {
  it("files by the vocabulary a partner would actually use", () => {
    expect(guessHeading("LP intro from Marcus — worth chasing?")).toBe("fundraising_lp");
    expect(guessHeading("Psyflo term sheet timing")).toBe("early_stage");
    expect(guessHeading("worried about Sensori runway")).toBe("portfolio_health");
    expect(guessHeading("book the venue for the October dinner")).toBe("events");
    expect(guessHeading("who knows someone at Stripe")).toBe("relationship_intel");
  });

  it("falls back to seven-day priorities rather than guessing wildly", () => {
    // Somebody typed it into THIS week's review, so at minimum it matters this week. A confident
    // wrong heading is worse than an honest default, because nobody checks a confident one.
    expect(guessHeading("aoifjaoisfj")).toBe("seven_day");
  });

  it("is case-insensitive, because nobody capitalises in a meeting", () => {
    expect(guessHeading("CALL COUNSEL ABOUT THE NDA")).toBe("legal_compliance");
    // "audit" deliberately files under finance rather than legal: for a fund the annual audit is a
    // fund-admin job, and that is where somebody would look for it.
    expect(guessHeading("chase the audit")).toBe("finance_cash");
  });
});
