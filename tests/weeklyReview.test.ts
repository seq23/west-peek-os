import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { runDueJobs, runJob } from "../src/worker/services/jobs";
import { deriveItems, mergeItems } from "../src/worker/services/weeklyReview";
import { REVIEW_HEADINGS, guessHeading, isResolved, weekEnd, weekStart } from "../src/shared/review/weeklyAgenda";
import { buildNotesPrompt, parseProposals, resolveOwner } from "../src/shared/review/meetingNotes";

/**
 * The weekly MP operating review (P37, V1 #18, canon §8) — ARCHIVED 18 Sep 2026.
 *
 * Owner: "we don't need it anymore." The per-person Wednesday prep packet (services/meetingPrep.ts)
 * replaced the one shared sixteen-heading agenda. The first block below pins the archive: the job
 * `weekly_mp_review` is RETIRED and refuses every trigger including a partner asking by hand
 * (stricter than the PAUSED it used to sit at, which a hand-run passed), the status route cannot
 * re-enable it, the tick never picks it up, the machinery list leaves it out, the nav does not list
 * the page while the route still answers a bookmark, `weekly_review.manage` still gates the page's
 * own routes, and the archived kind is off the unfiltered shelf while every row stays readable.
 *
 * The blocks after it still run the derivation. The generator is still reachable by a human from
 * the page's own button, and every derivation query is raw SQL against tables this module does not
 * own — a column rename upstream would turn a heading silently empty, and a page that still answers
 * must still answer correctly.
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

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR = { type: "HUMAN" as const, firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
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

describe("the weekly review is archived (18 Sep 2026)", () => {
  it("is RETIRED after migration 0198 — the table's terminal status, not a pause", async () => {
    const job = await t.db
      .prepare("SELECT status, next_run_at, pause_reason FROM scheduled_job WHERE job_key = 'weekly_mp_review'")
      .first<{ status: string; next_run_at: string | null; pause_reason: string | null }>();
    expect(job, "the row is kept so its runs still resolve").toBeTruthy();
    expect(job!.status).toBe("RETIRED");
    expect(job!.next_run_at).toBeNull();
    expect(job!.pause_reason).toContain("Retired 18 Sep 2026");
    expect(job!.pause_reason).toContain("we don't need it anymore");
  });

  it("refuses a scheduled tick AND a partner asking by hand — stricter than the pause it replaced", async () => {
    // PAUSED let a human run it by hand (jobs.ts checkPreconditions). RETIRED does not, on purpose.
    const scheduled = await runJob(env, MP_ACTOR, "weekly_mp_review", { trigger: "SCHEDULED", now: new Date("2026-09-23T12:30:00.000Z") });
    expect(scheduled.run.status).toBe("REFUSED");
    expect(String(scheduled.run.error)).toContain("RETIRED");

    const byHand = await runJob(env, MP_ACTOR, "weekly_mp_review", { trigger: "MANUAL", now: new Date("2026-09-23T12:31:00.000Z") });
    expect(byHand.run.status).toBe("REFUSED");
    expect(String(byHand.run.error)).toContain("RETIRED");

    // And no review was written by either attempt.
    const reviews = await t.db.prepare("SELECT COUNT(*) AS n FROM weekly_review WHERE week_start = '2026-09-23'").first<{ n: number }>();
    expect(reviews!.n).toBe(0);
  });

  it("cannot be re-enabled from the status route", async () => {
    const res = await call<{ error: string }>("/api/jobs/weekly_mp_review/status", MP, "POST", { status: "ACTIVE", reason: "bring it back" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("retired");
    const job = await t.db.prepare("SELECT status FROM scheduled_job WHERE job_key = 'weekly_mp_review'").first<{ status: string }>();
    expect(job!.status).toBe("RETIRED");
  });

  it("is never due on a tick, and is left out of the machinery list", async () => {
    const ran = await runDueJobs(env, new Date("2026-09-23T12:30:00.000Z"));
    expect(ran.map((r) => r.job_key)).not.toContain("weekly_mp_review");
    const list = await call<{ jobs: Array<{ job_key: string }> }>("/api/jobs", MP);
    expect(list.status).toBe(200);
    expect(list.body.jobs.map((j) => j.job_key)).not.toContain("weekly_mp_review");
  });

  it("is off the nav while the route still answers a bookmark", async () => {
    const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
    // The nav literal shape every other coverage test reads; guard the guard by finding a neighbour.
    expect(app).toMatch(/\{ key: "notifications", label: "Notifications" \}/);
    expect(app).not.toMatch(/\{ key: "weekly-review", label: "/);
    expect(app).toMatch(/active === "weekly-review"/);

    const page = await call<{ review: unknown }>("/api/weekly-review?week=2026-09-16", MP);
    expect(page.status).toBe(200);
  });

  it("says on the page itself that it is archived", async () => {
    const { pagePurpose } = await import("../src/shared/help/pagePurpose");
    const p = pagePurpose("weekly-review");
    expect(p?.archived).toContain("Archived 18 Sep 2026");
    // The purpose block still exists — the page still answers — and its controls no longer promise
    // to generate anything new.
    expect(p?.youCan.join(" ")).not.toContain("Generate");
  });

  it("keeps `weekly_review.manage` as the gate on the page's own routes", async () => {
    const { generateReview } = await import("../src/worker/services/weeklyReview");
    // In scope: allowed, and a human on the page's button can still assemble one by hand.
    const out = await generateReview(env, MP_ACTOR, new Date("2026-09-16T12:00:00.000Z"));
    expect(out.review.id).toMatch(/^wrv_/);
    const mine = await call<{ item: { id: string } }>("/api/weekly-review/items", MP, "POST", { body: "Typed by a partner on the archived page" });
    expect(mine.status).toBe(201);

    // Out of scope: refused by the same key, at the same route. The gate is consulted, not
    // decorative — an identity whose only firm scope is another firm gets the authorizer's own
    // `cross_firm_scope`, which only exists if `authorize()` ran.
    await t.db.prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_other_firm', 'other@elsewhere.example', 'Other Firm', 'ACTIVE')").run();
    await t.db.prepare("INSERT INTO authority_scope (id, firm_user_id, scope_key, scope_value) VALUES ('as_other_firm', 'fu_other_firm', 'firm_scope', 'other-firm')").run();
    const theirs = await call<{ error: string; detail: string }>("/api/weekly-review/items", { "x-wpos-dev-user": "other@elsewhere.example" }, "POST", { body: "Typed from another firm" });
    expect(theirs.status).toBe(403);
    expect(theirs.body.detail).toBe("cross_firm_scope");

    const key = await t.db.prepare("SELECT key FROM action_type WHERE key = 'weekly_review.manage'").first<{ key: string }>();
    expect(key?.key).toBe("weekly_review.manage");
  });

  it("keeps every review row and deliverable, off the unfiltered shelf but there by name", async () => {
    // A review delivered before the archive: still in the database, still returned when asked for.
    await t.db
      .prepare(
        `INSERT INTO deliverable (id, kind, title, body, prepared_by, prepared_for, privacy_label, firm_scope)
         VALUES ('dlv_wr_archived', 'weekly_review', 'Weekly operating review — 9 Sep', 'kept', 'aie_porter', 'fu_scooter_taylor', 'INTERNAL', 'west-peek')`,
      )
      .run();
    const shelf = await call<{ deliverables: Array<{ id: string; kind: string }> }>("/api/deliverables?limit=100", MP);
    expect(shelf.status).toBe(200);
    expect(shelf.body.deliverables.map((d) => d.kind)).not.toContain("weekly_review");

    const byName = await call<{ deliverables: Array<{ id: string }> }>("/api/deliverables?kind=weekly_review&limit=100", MP);
    expect(byName.body.deliverables.map((d) => d.id)).toContain("dlv_wr_archived");

    const rows = await t.db.prepare("SELECT COUNT(*) AS n FROM deliverable WHERE id = 'dlv_wr_archived'").first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });
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

/**
 * Reading meeting notes into agenda items.
 *
 * A model reading a partner meeting and filling the agenda would put words in two people's mouths
 * on the page they make decisions from. So the tests are mostly about what the parser REFUSES.
 */
describe("meeting notes become proposals, not minutes", () => {
  it("keeps only items with a heading the canon defines", () => {
    const out = parseProposals(JSON.stringify([
      { heading: "early_stage", body: "Pass on Halcyon", owner_hint: null, deadline: null, quote: "we should pass on Halcyon" },
      { heading: "invented_heading", body: "Something", owner_hint: null, deadline: null, quote: "x" },
    ]));
    expect(out).toHaveLength(1);
    expect(out![0]!.heading).toBe("early_stage");
  });

  it("drops a vague phrase where a date should be", () => {
    // "Soon" is not a date. Storing it as one would put a deadline on the agenda that nobody set.
    const out = parseProposals(JSON.stringify([
      { heading: "early_stage", body: "Send the deck", owner_hint: "Scooter", deadline: "soon", quote: "Scooter to send the deck soon" },
      { heading: "early_stage", body: "Reply to Acme", owner_hint: null, deadline: "2026-08-24", quote: "reply by the 24th" },
    ]));
    expect(out![0]!.deadline).toBeNull();
    expect(out![1]!.deadline).toBe("2026-08-24");
  });

  it("returns null rather than salvaging unparseable output", () => {
    // A half-read proposal is worse than none: a partner would accept it without knowing it was
    // reconstructed rather than read.
    expect(parseProposals("the meeting went well, I think")).toBeNull();
  });

  it("treats an empty list as a real answer", () => {
    expect(parseProposals("[]")).toEqual([]);
  });

  it("only resolves an owner when the notes name a partner unambiguously", () => {
    expect(resolveOwner("Scooter")).toBe("fu_scooter_taylor");
    expect(resolveOwner("sequoia to follow up")).toBe("fu_sequoia_taylor");
    // Somebody outside the firm. Assigning work to them would invent a person.
    expect(resolveOwner("Marcus")).toBeNull();
    // Both named — the notes did not say which, so neither does this.
    expect(resolveOwner("Sequoia and Scooter")).toBeNull();
    expect(resolveOwner(null)).toBeNull();
  });

  it("tells the model not to firm up a vague statement", () => {
    const p = buildNotesPrompt("some notes", "2026-08-19");
    expect(p).toMatch(/do not tidy a vague statement into a firm one/i);
    expect(p).toMatch(/Never invent an owner/i);
    // The notes are somebody else's words and may contain anything.
    expect(p).toMatch(/untrusted/i);
  });
});

/**
 * A QUIET WEEK IS STILL DELIVERED, AND SAYS SO.
 *
 * The handover was guarded by `if (items.length > 0)`, so a week that derived no agenda items
 * produced NO deliverable at all. On a Home page that is indistinguishable from a generation that
 * crashed — and only one of those means the firm had a quiet week.
 *
 * Operator, 9 Sep 2026, settling it: "saying nothing was done is okay too." An empty agenda is a
 * legitimate output; a silently absent one never is.
 *
 * Its own database, deliberately: the suite above seeds an approval, three opportunities and a
 * contradiction precisely so the derivation has something to find, which is the opposite of what
 * this needs.
 */
describe("a week with nothing in it", () => {
  let quiet: TestDb;
  let quietEnv: Env;

  beforeAll(async () => {
    quiet = await createTestDb();
    quietEnv = makeTestEnv(quiet.db);
    /*
     * A FRESH DATABASE IS NO LONGER EMPTY OF EVENTS, so the premise has to be made true rather than
     * assumed. Migration 0176 seeds one real row: October 2026's Workshop, which a friend of
     * Scooter's is hosting — it is on the record so the adjacency rule can measure against what
     * actually RAN rather than against Parker's proposals. It is a genuine planned event, so the
     * weekly review is right to raise it, and this suite is about the week with NOTHING in it.
     */
    await quietEnv.WP_OS_DB.prepare("DELETE FROM evt_event").run();
  });

  afterAll(async () => {
    await disposeTestDb(quiet);
  });

  it("hands over an agenda that states it is empty, rather than handing over nothing", async () => {
    const { generateReview } = await import("../src/worker/services/weeklyReview");
    const out = await generateReview(
      quietEnv,
      { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] },
      new Date("2026-09-09T12:00:00.000Z"),
    );

    // The premise, asserted rather than assumed: this really is a week with nothing derivable, so
    // the test cannot pass for the wrong reason.
    expect(out.items.length, "the fixture produced agenda items, so this proves nothing").toBe(0);

    const delivered = (
      await quietEnv.WP_OS_DB.prepare(
        "SELECT title, body, prepared_for FROM deliverable WHERE kind = 'weekly_review'",
      ).all<{ title: string; body: string; prepared_for: string }>()
    ).results ?? [];

    expect(delivered.length, "an empty week produced no deliverable at all").toBeGreaterThan(0);
    expect(delivered[0]!.body).toContain("Nothing was raised for this week");
    // And it says what it looked at, so "nothing" can be believed rather than merely accepted.
    expect(delivered[0]!.body).toContain("derived from a record that already exists");
  });

  it("addresses the one joint copy by recorded seniority, not by alphabetical id", async () => {
    /*
     * The recipient was chosen with `ORDER BY u.id LIMIT 1` under a comment reading "the senior
     * partner on the roster". That is a string comparison over primary keys which happens to agree
     * with seniority today and would stop agreeing the moment an id changed. Seniority is recorded
     * in MANAGING_PARTNERS — ownership percentages and an explicit finalAuthority flag.
     */
    const { MANAGING_PARTNERS } = await import("../src/shared/registry/managingPartners");
    const expected = [...MANAGING_PARTNERS].sort(
      (a, b) => Number(b.finalAuthority) - Number(a.finalAuthority) || b.ownershipPct - a.ownershipPct,
    )[0]!;

    const row = await quietEnv.WP_OS_DB.prepare(
      `SELECT u.full_name FROM deliverable d JOIN firm_user u ON u.id = d.prepared_for
        WHERE d.kind = 'weekly_review' LIMIT 1`,
    ).first<{ full_name: string }>();

    expect(row, "no weekly review was delivered, so nothing was checked").toBeTruthy();
    expect(row!.full_name).toBe(expected.fullName);
  });
});
