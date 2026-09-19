import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import {
  BRIEF_EXPECTED_OUTPUT_TOKENS, MAX_BRIEF_ATTEMPTS, RETRY_AFTER_MINUTES, WRITE_LEASE_MINUTES, STAGE_LEASE_MINUTES,
  BRIEF_MODEL, briefStateFor, measuredExpectations, retryAfterIso, serveBrief, startReport, type BriefDeps,
} from "../src/worker/services/dailyIntelligence";
import { CHAIN_BUDGET_MS } from "../src/worker/ai/chainBudget";

/**
 * THE BUTTON IS A REQUEST, AND THE CLOCK SERVES IT — ON DEMAND ONLY (19 Sep 2026).
 *
 * Production that morning: a Saturday the old schedule skipped by a default nobody chose, a button
 * that ran the model call inside her HTTP request and died with it, and a second press told
 * "Another run holds it". The owner's decision: "On demand + Sonnet for briefs only. On demand any
 * day of the week!" Every part of that is proven end to end against a migrated database:
 *
 *   · the clock STARTS nothing — a Saturday tick with no request writes no row;
 *   · a request is walked from nothing to READY inside ONE tick, any day, whatever the profile
 *     says about weekends; a second request while it moves changes nothing and says so from the row;
 *   · a lane forced to fail leaves a FAILED row with the reason, a `retry_after` twenty minutes
 *     on, a notification addressed to her, and a state that says "retrying at HH:MM"; the third
 *     failure says "nothing more today" and names tomorrow's hour;
 *   · the write lease is derived from the chain budget, not typed.
 */

let t: TestDb;
let env: Env;
const SEQUOIA = "fu_sequoia_taylor";
// Saturday 19 Sep 2026, 09:41 New York.
const SATURDAY = new Date("2026-09-19T13:41:00.000Z");
const at = (minutes: number) => new Date(SATURDAY.getTime() + minutes * 60_000);

const V5 = [
  "executive_summary", "top_headlines", "markets_macro", "capital_markets", "venture_private",
  "government_legal", "ai_technology", "watchlist", "investor_insight", "key_events", "watch",
].map((k) => `===SECTION ${k}\n${k === "top_headlines"
  ? Array.from({ length: 5 }, (_, i) => `**${i + 1}. A headline as a full claim** [1] — the figure in **bold**.\n\n**Investor Importance: ${i + 2}/10**`).join("\n\n")
  : `A substantial paragraph about ${k}, the figure in **bold**, cited [1].`}\n===END`).join("\n");

const good: BriefDeps = {
  synthesise: async () => ({ output: V5, aiRunId: null, model: "fake-test-model" }),
  macro: async () => ({ readings: [], failures: [{ instrument: "US10Y", label: "10-year Treasury yield", detail: "HTTP 503" }] }),
  market: async () => ({ ok: true, levels: [], calendar: [], citations: [], aiRunId: null, detail: "ok" }),
};
const broken: BriefDeps = { ...good, synthesise: async () => ({ output: "", aiRunId: null, model: "fake-test-model", failure: "the lane answered HTTP 429: free quota exhausted" }) };

async function row(user: string, date: string) {
  return env.WP_OS_DB.prepare("SELECT * FROM intelligence_report WHERE firm_user_id = ?1 AND report_date = ?2").bind(user, date)
    .first<{ id: string; status: string; attempts: number; retry_after: string | null; requested_at: string | null; requested_by: string | null; error_message: string | null; stage_lease_until: string | null }>();
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const src = await env.WP_OS_DB.prepare("SELECT id FROM intelligence_source LIMIT 1").first<{ id: string }>();
  await env.WP_OS_DB.prepare(`INSERT INTO intelligence_run (id, trigger_kind, idempotency_key, status, requested_by_type, requested_by_id, firm_scope)
    VALUES ('irun_sv','MANUAL','served-run','SUCCEEDED','HUMAN','fu_sequoia_taylor','west-peek')`).run();
  await env.WP_OS_DB.prepare(`INSERT INTO intelligence_item (id, run_id, source_id, dedupe_hash, title, body, url, published_at, category, firm_scope, created_at) VALUES
    ('ii_s1', 'irun_sv', ?1, 'hs1', 'Fed holds rates, signals October cut', 'The Federal Reserve held rates.', 'https://reuters.test/fed', '2026-09-19T11:00:00Z', 'MARKET', 'west-peek', '2026-09-19T11:00:00Z'),
    ('ii_s2', 'irun_sv', ?1, 'hs2', 'Treasury yields climb after the jobs print', 'Yields rose after payrolls.', 'https://reuters.test/yields', '2026-09-22T09:00:00Z', 'MARKET', 'west-peek', '2026-09-22T09:00:00Z'),
    ('ii_s3', 'irun_sv', ?1, 'hs3', 'Acme raises a $40M Series B', 'Acme raised forty million dollars.', 'https://tc.test/acme', '2026-09-26T09:00:00Z', 'FUNDING_MA', 'west-peek', '2026-09-26T09:00:00Z')`).bind(src!.id).run();
  // Every managing partner gets an explicit profile row so the tests below can flip weekends and
  // enabled per partner; the seed does not guarantee one exists.
  const partners = (await env.WP_OS_DB.prepare(
    "SELECT u.id FROM firm_user u JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner' WHERE u.status = 'ACTIVE'",
  ).all<{ id: string }>()).results!;
  expect(partners.map((p) => p.id)).toContain(SEQUOIA);
  for (const p of partners) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO partner_intelligence_profile (firm_user_id, timezone, earliest_start_local, enabled, weekends)
       VALUES (?1, 'America/New_York', '06:15', 1, 1)
       ON CONFLICT (firm_user_id) DO UPDATE SET timezone = 'America/New_York', earliest_start_local = '06:15', enabled = 1, weekends = 1`,
    ).bind(p.id).run();
  }
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the clock starts nothing", () => {
  it("a Saturday tick with no request writes no row and says nothing was requested", async () => {
    const out = await serveBrief(env, SATURDAY, good);
    expect(out.served).toBe(false);
    expect(out.summary).toBe("no brief has been requested");
    const n = await env.WP_OS_DB.prepare("SELECT COUNT(*) n FROM intelligence_report WHERE report_date = '2026-09-19'").first<{ n: number }>();
    expect(n!.n).toBe(0);
    const state = await briefStateFor(env, "west-peek", SEQUOIA, SATURDAY);
    expect(state.state.kind).toBe("idle");
    expect(state.state.line).toMatch(/^No brief today yet\. None has been built yet\./);
  });

  it("the retirement is on the record: a RETIRED job row the seeds cannot re-open, and the brief's model is Sonnet", async () => {
    const job = await env.WP_OS_DB.prepare("SELECT status, schedule_kind, pause_reason FROM scheduled_job WHERE job_key = 'morning_brief_schedule'").first<{ status: string; schedule_kind: string; pause_reason: string }>();
    expect(job?.status).toBe("RETIRED");
    expect(job?.pause_reason).toMatch(/On demand \+ Sonnet for briefs only/);
    expect(BRIEF_MODEL).toBe("anthropic/claude-sonnet-5");
  });
});

describe("the button is a request the clock serves", () => {
  it("a request re-opens the row with the presser's name, is REQUESTED until the tick, then walks to READY", async () => {
    await startReport(env, "west-peek", SEQUOIA, at(5), "requested", SEQUOIA);
    const r = await row(SEQUOIA, "2026-09-19");
    expect(r!.status).toBe("GATHERING");
    expect(r!.attempts, "a request starts the day's budget over").toBe(1);
    expect(r!.requested_by).toBe(SEQUOIA);
    expect(r!.requested_at).toBeTruthy();
    const before = await briefStateFor(env, "west-peek", SEQUOIA, at(5));
    expect(before.state.kind).toBe("requested");
    expect(before.state.button.enabled, "a second press while requested does nothing").toBe(false);

    const served = await serveBrief(env, at(6), good);
    expect(served.partner, "a requested brief is served before anything else").toBe(SEQUOIA);
    expect(served.status).toBe("READY");
    const after = await briefStateFor(env, "west-peek", SEQUOIA, at(6));
    expect(after.state.kind).toBe("arrived");
  });

  it("a request on a Saturday, with weekends off on the profile, is served like any other", async () => {
    await env.WP_OS_DB.prepare("UPDATE partner_intelligence_profile SET weekends = 0 WHERE firm_user_id = ?1").bind(SEQUOIA).run();
    const skipped = await briefStateFor(env, "west-peek", SEQUOIA, new Date("2026-09-26T13:00:00.000Z")); // next Saturday, no row
    expect(skipped.state.kind, "a Saturday with weekends off on the profile is simply idle — the column no longer bears on a brief").toBe("idle");
    await startReport(env, "west-peek", SEQUOIA, new Date("2026-09-26T13:00:00.000Z"), "requested", SEQUOIA);
    const served = await serveBrief(env, new Date("2026-09-26T13:01:00.000Z"), good);
    expect(served.partner).toBe(SEQUOIA);
    expect(served.status).toBe("READY");
    await env.WP_OS_DB.prepare("UPDATE partner_intelligence_profile SET weekends = 1 WHERE firm_user_id = ?1").bind(SEQUOIA).run();
  });

  it("a row moving under a live lease reads RUNNING with the elapsed time, and the button says already building", async () => {
    const day = "2026-09-21";
    const monday = new Date("2026-09-21T12:00:00.000Z");
    await startReport(env, "west-peek", SEQUOIA, monday, "requested", SEQUOIA);
    await env.WP_OS_DB.prepare("UPDATE intelligence_report SET status = 'GENERATING', stage_lease_until = ?2, started_at = ?3, stage_at = ?3 WHERE firm_user_id = ?1 AND report_date = ?4")
      .bind(SEQUOIA, new Date(monday.getTime() + 10 * 60_000).toISOString(), monday.toISOString(), day).run();
    const s = await briefStateFor(env, "west-peek", SEQUOIA, new Date(monday.getTime() + 80_000));
    expect(s.state.kind).toBe("running");
    expect(s.state.button.enabled).toBe(false);
    expect(s.state.button.label).toBe("Already building — started 1m 20s ago");
    // The tick leaves a leased row alone.
    const held = await serveBrief(env, new Date(monday.getTime() + 80_000), good);
    expect(held.partner === SEQUOIA && held.steps[0] !== "busy", "a leased stage was advanced by a second invocation").toBe(false);
    // Closed rather than deleted (the row has children); Monday plays no further part below.
    await env.WP_OS_DB.prepare("UPDATE intelligence_report SET status = 'READY', stage_lease_until = NULL, completed_at = ?3 WHERE firm_user_id = ?1 AND report_date = ?2").bind(SEQUOIA, day, monday.toISOString()).run();
  });
});

describe("a lane forced to fail — the negative proof", () => {
  const day = "2026-09-22";
  const tuesday = new Date("2026-09-22T11:00:00.000Z"); // 07:00 New York

  it("the first failure leaves a FAILED row with the reason, a retry time twenty minutes on, and a notice addressed to her", async () => {
    await startReport(env, "west-peek", SEQUOIA, tuesday, "requested", SEQUOIA);
    const out = await serveBrief(env, tuesday, broken);
    expect(out.partner).toBe(SEQUOIA);
    expect(out.status).toBe("FAILED");
    const r = await row(SEQUOIA, day);
    expect(r!.status).toBe("FAILED");
    expect(r!.attempts).toBe(1);
    expect(r!.error_message).toMatch(/HTTP 429: free quota exhausted/);
    expect(r!.retry_after).toBe(retryAfterIso(tuesday));
    expect(RETRY_AFTER_MINUTES).toBe(20);

    const state = await briefStateFor(env, "west-peek", SEQUOIA, tuesday);
    expect(state.state.kind).toBe("retrying");
    expect(state.state.line).toMatch(/attempt 1 of 3 failed: the lane answered HTTP 429/);
    expect(state.state.next).toMatch(/tries again at 7:20 AM/);

    const notice = await env.WP_OS_DB.prepare(
      "SELECT title, body, severity FROM notification WHERE firm_user_id = ?1 AND kind = 'INTELLIGENCE_BRIEF' AND object_id = ?2 ORDER BY created_at DESC LIMIT 1",
    ).bind(SEQUOIA, r!.id).first<{ title: string; body: string; severity: string }>();
    expect(notice, "a failed brief tells her where she reads").toBeTruthy();
    expect(notice!.title).toMatch(/being retried/);
    expect(notice!.body).toMatch(/HTTP 429/);
    expect(notice!.body).toMatch(/tries again at 7:20 AM/);
  });

  it("nothing is retried before retry_after; the third failure says nothing more is tried, and warns her once", async () => {
    const tooSoon = await serveBrief(env, new Date(tuesday.getTime() + 10 * 60_000), broken);
    expect(tooSoon.served, "a failed brief was retried inside its retry window").toBe(false);

    const second = await serveBrief(env, new Date(tuesday.getTime() + 21 * 60_000), broken);
    expect(second.status).toBe("FAILED");
    expect((await row(SEQUOIA, day))!.attempts).toBe(2);
    const third = await serveBrief(env, new Date(tuesday.getTime() + 43 * 60_000), broken);
    expect(third.status).toBe("FAILED");
    const r = await row(SEQUOIA, day);
    expect(r!.attempts).toBe(MAX_BRIEF_ATTEMPTS);
    expect(r!.retry_after, "a spent budget claims no retry time").toBeNull();

    const spent = await serveBrief(env, new Date(tuesday.getTime() + 70 * 60_000), broken);
    expect(spent.served, "a failed-out brief was tried a fourth time").toBe(false);

    const state = await briefStateFor(env, "west-peek", SEQUOIA, new Date(tuesday.getTime() + 70 * 60_000));
    expect(state.state.kind).toBe("failed_out");
    expect(state.state.line).toMatch(/No brief today\. It was tried 3 times/);
    expect(state.state.next).toMatch(/Nothing more is tried automatically\. Press the button to try again now\./);
    expect(state.state.button.label).toBe("Try again now");
    expect(state.state.button.enabled).toBe(true);

    const notices = (await env.WP_OS_DB.prepare(
      "SELECT title, severity FROM notification WHERE firm_user_id = ?1 AND kind = 'INTELLIGENCE_BRIEF' AND object_id = ?2 ORDER BY created_at",
    ).bind(SEQUOIA, r!.id).all<{ title: string; severity: string }>()).results!;
    const final = notices.filter((n) => /^No brief today/.test(n.title));
    expect(final.length, "the final failure warns her exactly once").toBe(1);
    expect(final[0]!.severity).toBe("WARNING");
    expect(notices.filter((n) => /being retried/.test(n.title)).length, "the retry notice is not repeated per attempt").toBe(1);

    // And a request after the budget is spent starts over — her press is the door.
    await startReport(env, "west-peek", SEQUOIA, new Date(tuesday.getTime() + 71 * 60_000), "requested", SEQUOIA);
    const again = await serveBrief(env, new Date(tuesday.getTime() + 72 * 60_000), good);
    expect(again.status).toBe("READY");
  });
});

describe("the numbers are derived, not typed", () => {
  it("the write lease covers two chain walks and is longer than a cheap stage's", () => {
    expect(WRITE_LEASE_MINUTES).toBe(Math.ceil((2 * CHAIN_BUDGET_MS) / 60_000) + 4);
    expect(WRITE_LEASE_MINUTES).toBeGreaterThan(STAGE_LEASE_MINUTES);
    expect(WRITE_LEASE_MINUTES).toBeLessThan(30);
  });

  it("the declared output sits at the measured p90 (22,969) with a margin, under the 32,768 wire ceiling", () => {
    expect(BRIEF_EXPECTED_OUTPUT_TOKENS).toBeGreaterThanOrEqual(22_969);
    expect(BRIEF_EXPECTED_OUTPUT_TOKENS).toBeLessThan(32_768);
  });

  it("with no completed model runs the expectation is the production fallback, labelled unmeasured", async () => {
    const e = await measuredExpectations(env);
    expect(e.measuredFrom).toBe(0);
    expect(e.usualSeconds).toBe(189 + 75);
  });

});
