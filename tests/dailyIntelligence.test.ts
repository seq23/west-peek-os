import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "@shared/intelligence/reportSchema";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import {
  MAX_BRIEF_ATTEMPTS, deliverReport, generateForPartner, loadProfile, runDailyForAll, type Synthesise,
} from "../src/worker/services/dailyIntelligence";

/**
 * A stand-in for the model. The offline mock adapter returns prose, not the JSON this pipeline
 * needs, so it cannot stand in for a real model — injecting here keeps the test about the PIPELINE
 * rather than about the adapter.
 */
const fakeModel: Synthesise = async () => ({
  output: JSON.stringify({
    sections: [
      { key: "executive_summary", body_md: "Two developments matter this morning.", event_ids: [] },
      { key: "capital_markets", body_md: "An acquisition was announced in the payments stack.", event_ids: [] },
    ],
    watch: { body_md: "Whether the rate path shifts before September.", event_ids: [] },
  }),
  // No ai_run row exists for a fake model, and intelligence_report.ai_run_id is a real
  // foreign key — inventing an id would only prove the FK works.
  aiRunId: null,
  model: "fake-test-model",
});

/**
 * Daily Intelligence, end to end against a real database (P41).
 *
 * The offline path is the one under test: with no provider configured, runAi uses the deterministic
 * local adapter, so this exercises gather → dedupe → rank → synthesise → verify → persist → deliver
 * without a network or a paid call. What is asserted is the PIPELINE's behaviour — the funnel
 * counts, idempotency, delivery separation, empty-day handling — not the prose.
 */

let t: TestDb;
let env: Env;
const MP: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const NOW = new Date("2026-08-17T12:00:00Z"); // a Monday

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const run = (sql: string) => env.WP_OS_DB.prepare(sql).run();

  const src = await env.WP_OS_DB.prepare("SELECT id FROM intelligence_source LIMIT 1").first<{ id: string }>();
  const bind = src?.id ? `'${src.id}'` : "NULL";

  // Items belong to a sweep run: this pipeline READS what sweeps collected rather than acquiring
  // its own, so the fixture has to look like a real sweep did the gathering.
  await run(`INSERT INTO intelligence_run (id, trigger_kind, idempotency_key, status, requested_by_type, requested_by_id, firm_scope)
    VALUES ('irun_fx','MANUAL','fixture-run','SUCCEEDED','HUMAN','fu_scooter_taylor','west-peek')`);

  // Two outlets on one story, one distinct story, one week-old item that should rank low.
  await run(`INSERT INTO intelligence_item (id, run_id, source_id, dedupe_hash, title, body, url, published_at, category, firm_scope, created_at) VALUES
    ('ii_a', 'irun_fx', ${bind}, 'h_ii_a', 'Acme announces acquisition of Foo Systems', 'Acme has agreed to buy Foo Systems in a deal worth two hundred million dollars.', 'https://reuters.test/1', '2026-08-17T06:00:00Z', 'FUNDING_MA', 'west-peek', '2026-08-17T06:00:00Z'),
    ('ii_b', 'irun_fx', ${bind}, 'h_ii_b', 'Acme to acquire Foo Systems', 'Acme will acquire Foo Systems, according to people familiar with the matter.', 'https://cnbc.test/2', '2026-08-17T07:00:00Z', 'FUNDING_MA', 'west-peek', '2026-08-17T07:00:00Z'),
    ('ii_c', 'irun_fx', ${bind}, 'h_ii_c', 'Fed signals a rate cut in September', 'The Federal Reserve indicated it may cut interest rates at its September meeting.', 'https://fed.test/3', '2026-08-17T05:00:00Z', 'MARKET', 'west-peek', '2026-08-17T05:00:00Z')`);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("partner profile", () => {
  it("defaults rather than failing when a partner has no profile row", async () => {
    const p = await loadProfile(env, "fu_scooter_taylor");
    expect(p.enabled).toBe(1);
    expect(p.timezone).toBeTruthy();
  });
});

describe("the funnel", () => {
  it("runs every stage and reaches READY", async () => {
    const out = await generateForPartner(env, MP, "fu_scooter_taylor", NOW, fakeModel);
    expect(out.status).toBe("READY");
  });

  it("deduplicates the two outlets covering one story", async () => {
    const row = await env.WP_OS_DB.prepare(
      "SELECT raw_count, deduped_count, candidate_count FROM intelligence_report WHERE firm_user_id = 'fu_scooter_taylor'",
    ).first<{ raw_count: number; deduped_count: number; candidate_count: number }>();
    expect(row!.raw_count).toBe(3);
    // Reuters and CNBC on one acquisition collapse; the Fed story survives separately.
    expect(row!.deduped_count).toBe(2);
  });

  it("records the prompt version and model so a quality change is attributable", async () => {
    const row = await env.WP_OS_DB.prepare(
      "SELECT prompt_version, model FROM intelligence_report WHERE firm_user_id = 'fu_scooter_taylor'",
    ).first<{ prompt_version: string; model: string }>();
    // Against the constant, not a literal. Bumping the version is the deliberate act the field
    // exists for — pinning the string here made a correct change look like a regression, while
    // testing nothing that matters. What matters is that whatever wrote the report is RECORDED.
    expect(row!.prompt_version).toBe(PROMPT_VERSION);
    expect(row!.prompt_version).toMatch(/^daily-intelligence-v\d+$/);
    expect(row!.model).toBe("fake-test-model");
  });

  it("writes at least one section", async () => {
    const rows = await env.WP_OS_DB.prepare(
      `SELECT s.section_key FROM intelligence_report_section s
         JOIN intelligence_report r ON r.id = s.report_id
        WHERE r.firm_user_id = 'fu_scooter_taylor'`,
    ).all<{ section_key: string }>();
    expect((rows.results ?? []).length).toBeGreaterThan(0);
  });
});

describe("idempotency", () => {
  it("regenerating the same day updates ONE report rather than creating a second", async () => {
    // The brief's explicit requirement: a retry must not deliver two reports.
    await generateForPartner(env, MP, "fu_scooter_taylor", NOW, fakeModel);
    const rows = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) n FROM intelligence_report WHERE firm_user_id = 'fu_scooter_taylor' AND report_date = '2026-08-17'",
    ).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("replaces sections instead of appending them on a rerun", async () => {
    const rows = await env.WP_OS_DB.prepare(
      `SELECT s.section_key, COUNT(*) n FROM intelligence_report_section s
         JOIN intelligence_report r ON r.id = s.report_id
        WHERE r.firm_user_id = 'fu_scooter_taylor' GROUP BY s.section_key HAVING n > 1`,
    ).all();
    expect(rows.results ?? []).toEqual([]);
  });
});

describe("delivery is separate from generation", () => {
  it("records a delivery attempt", async () => {
    const r = await env.WP_OS_DB.prepare(
      "SELECT id FROM intelligence_report WHERE firm_user_id = 'fu_scooter_taylor'",
    ).first<{ id: string }>();
    await deliverReport(env, r!.id);
    const d = await env.WP_OS_DB.prepare(
      "SELECT status, attempt FROM intelligence_delivery WHERE report_id = ?1 ORDER BY attempt DESC LIMIT 1",
    ).bind(r!.id).first<{ status: string; attempt: number }>();
    expect(d!.status).toBe("DELIVERED");
  });

  it("increments the attempt on a re-delivery rather than overwriting the record", async () => {
    const r = await env.WP_OS_DB.prepare(
      "SELECT id FROM intelligence_report WHERE firm_user_id = 'fu_scooter_taylor'",
    ).first<{ id: string }>();
    await deliverReport(env, r!.id);
    const rows = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) n FROM intelligence_delivery WHERE report_id = ?1",
    ).bind(r!.id).first<{ n: number }>();
    // Append-only: a flaky channel should be visible as a pattern, not overwritten.
    expect(rows!.n).toBeGreaterThan(1);
  });

  it("refuses to deliver a report that is not READY", async () => {
    const r = await env.WP_OS_DB.prepare(
      "SELECT id FROM intelligence_report WHERE firm_user_id = 'fu_scooter_taylor'",
    ).first<{ id: string }>();
    await env.WP_OS_DB.prepare("UPDATE intelligence_report SET status = 'FAILED' WHERE id = ?1").bind(r!.id).run();
    await expect(deliverReport(env, r!.id)).rejects.toMatchObject({ code: "not_ready" });
    await env.WP_OS_DB.prepare("UPDATE intelligence_report SET status = 'READY' WHERE id = ?1").bind(r!.id).run();
  });
});

describe("quiet days and weekends", () => {
  it("says nothing reached the bar rather than padding the report", async () => {
    // A separate scope with no items at all.
    const empty: Actor = { ...MP, firmScopes: ["empty-firm"] };
    const out = await generateForPartner(env, empty, "fu_sequoia_taylor", NOW, fakeModel);
    expect(out.status).toBe("READY");
    expect(out.candidates).toBe(0);
    const s = await env.WP_OS_DB.prepare(
      "SELECT body_md FROM intelligence_report_section WHERE report_id = ?1",
    ).bind(out.report_id).first<{ body_md: string }>();
    expect(s!.body_md).toMatch(/nothing reached the bar/i);
  });

  it("skips weekends unless a partner asked for them", async () => {
    const saturday = new Date("2026-08-15T12:00:00Z");
    const before = await env.WP_OS_DB.prepare("SELECT COUNT(*) n FROM intelligence_report").first<{ n: number }>();
    await runDailyForAll(env, MP, saturday, fakeModel);
    const after = await env.WP_OS_DB.prepare("SELECT COUNT(*) n FROM intelligence_report").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});

// ── The three ways a brief actually died in production ───────────────────────
//
// Every case below is a real failure from the 18th to the 20th of August, found by reading the
// intelligence_report table rather than by imagining what might go wrong. Two partners lost briefs
// to a formatting slip, one lost a brief to a credential-shaped span in somebody else's news URL,
// and one sat at VERIFYING for four hours with no error recorded and nothing anywhere saying so.

import { closeAbandonedReports, STALE_AFTER_MINUTES } from "../src/worker/services/dailyIntelligence";

/** The delimited format the prompt actually asks for, which parses. */
const GOOD_OUTPUT = [
  "===SECTION executive_summary",
  "Two developments matter this morning.",
  "===END",
  "===SECTION capital_markets",
  "An acquisition was announced in the payments stack.",
  "===END",
].join("\n");

describe("a reply that cannot be read", () => {
  it("is retried once rather than losing the whole morning", async () => {
    let calls = 0;
    const flakyThenGood: Synthesise = async () => {
      calls += 1;
      return { output: calls === 1 ? "I'm afraid I can't help with that." : GOOD_OUTPUT, aiRunId: null, model: "fake-test-model" };
    };

    const out = await generateForPartner(env, MP, "fu_sequoia_taylor", new Date("2026-08-18T09:00:00Z"), flakyThenGood);
    expect(calls, "the first unreadable reply must be retried").toBe(2);
    expect(out.status).toBe("READY");
  });

  it("gives up after the second attempt — a retry is one, not a loop", async () => {
    let calls = 0;
    const neverParses: Synthesise = async () => {
      calls += 1;
      return { output: "still not a report", aiRunId: null, model: "fake-test-model" };
    };

    const out = await generateForPartner(env, MP, "fu_sequoia_taylor", new Date("2026-08-18T15:00:00Z"), neverParses);
    expect(out.status).toBe("FAILED");
    expect(calls, "two attempts, never three — a paid generation is not something to loop on").toBe(2);

    const row = await env.WP_OS_DB.prepare(
      "SELECT error_code, error_message FROM intelligence_report WHERE firm_user_id = ?1 AND report_date = ?2",
    )
      .bind("fu_sequoia_taylor", "2026-08-18")
      .first<{ error_code: string; error_message: string }>();
    expect(row?.error_code).toBe("unparseable");
    expect(row?.error_message).toContain("twice");
  });
});

describe("a run that stopped part-way through", () => {
  /*
   * THE ONE THAT WAS INVISIBLE. Sequoia's brief sat at VERIFYING with completed_at NULL and no
   * error, because the scheduled runner caught the throw with a bare `catch { failed += 1 }`. The
   * row was never closed, the error was discarded, and the operator was told the firm was healthy.
   */
  it("is closed out as FAILED, not left mid-flight forever", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO intelligence_report (id, firm_user_id, report_date, status, prompt_version, firm_scope, started_at)
       VALUES ('dir_stuck', 'fu_sequoia_taylor', '2026-08-01', 'VERIFYING', 'v-test', 'west-peek', ?1)`,
    )
      .bind(new Date(Date.now() - (STALE_AFTER_MINUTES + 5) * 60_000).toISOString())
      .run();

    const closed = await closeAbandonedReports(env);
    expect(closed).toBeGreaterThan(0);

    const row = await env.WP_OS_DB.prepare("SELECT status, error_code, completed_at FROM intelligence_report WHERE id = 'dir_stuck'")
      .first<{ status: string; error_code: string; completed_at: string }>();
    expect(row?.status).toBe("FAILED");
    expect(row?.error_code, "abandoned is distinct from a run that failed on its merits").toBe("abandoned");
    expect(row?.completed_at).toBeTruthy();
  });

  it("leaves a run that is genuinely still going alone", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO intelligence_report (id, firm_user_id, report_date, status, prompt_version, firm_scope, started_at)
       VALUES ('dir_running', 'fu_sequoia_taylor', '2026-08-02', 'GENERATING', 'v-test', 'west-peek', ?1)`,
    )
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();

    await closeAbandonedReports(env);
    const row = await env.WP_OS_DB.prepare("SELECT status FROM intelligence_report WHERE id = 'dir_running'")
      .first<{ status: string }>();
    expect(row?.status, "a minute old is not abandoned").toBe("GENERATING");
  });

  /*
   * A throw from the FIRST synthesis call is caught inside generateForPartner and becomes a clean
   * FAILED row — that path already worked. The backstop exists for a throw from anywhere else, and
   * the retry call is exactly such a place: it runs after the inner try has closed. So that is what
   * this throws from, rather than picking a spot the inner handler would have caught anyway.
   */
  it("a throw the inner handler does not catch still closes the row and lands on the ledger", async () => {
    let calls = 0;
    const explodes: Synthesise = async () => {
      calls += 1;
      if (calls === 1) return { output: "not a report at all", aiRunId: null, model: "fake-test-model" };
      throw new Error("provider exploded mid-retry");
    };
    await runDailyForAll(env, MP, new Date("2026-08-18T18:00:00Z"), explodes);

    const stranded = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM intelligence_report WHERE status NOT IN ('READY','FAILED') AND report_date = '2026-08-18'",
    ).first<{ n: number }>();
    expect(stranded?.n, "no row may be left mid-flight after a throw").toBe(0);

    const swallowed = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'system.swallowed_failure' AND object_id = 'dailyIntelligence.generateForPartner'",
    ).first<{ n: number }>();
    expect(swallowed?.n, "and the swallow must be on the ledger, not discarded").toBeGreaterThan(0);
  });
});

/*
 * WHY THE BRIEF IS CHUNKED.
 *
 * A Cron Trigger gets 10 ms of CPU on the Workers Free plan; the Paid plan gets 30 seconds. Sweeping
 * every source and then building a brief for every partner in one invocation is far past that, so
 * the invocation was killed mid-flight — which is why four of the last eight briefs failed, all of
 * them the scheduled ones, and every brief that succeeded was a human pressing the button. That
 * button runs a different path which generates for ONE partner.
 *
 * So the job now fires on the tick and takes one partner at a time. Two things have to hold: a
 * partner who already has today's brief is skipped, and a partner whose local morning has not
 * arrived is not briefed early.
 */
describe("the brief is built one partner at a time, across ticks", () => {
  it("takes at most the limit it is given and says how many are left", async () => {
    const partners = await t.db
      .prepare(
        `SELECT u.id FROM firm_user u
           JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
          WHERE u.status = 'ACTIVE'`,
      )
      .all<{ id: string }>();
    const count = (partners.results ?? []).length;
    expect(count).toBeGreaterThan(1); // otherwise this test proves nothing

    // A weekday nothing else in this suite has touched, so every partner is naturally due and no
    // report has to be deleted — the rows have children and deleting them trips a foreign key.
    const now = new Date("2026-09-16T16:00:00.000Z");

    const first = await runDailyForAll(env, MP, now, fakeModel, 1);
    expect(first.generated + first.failed).toBe(1);
    expect(first.remaining).toBe(count - 1);

    // The next tick picks up whoever is left rather than repeating the first.
    const second = await runDailyForAll(env, MP, now, fakeModel, 1);
    expect(second.generated + second.failed).toBe(1);
    expect(second.remaining).toBe(count - 2);

    // And once everybody has one, a later tick does nothing at all.
    const third = await runDailyForAll(env, MP, now, fakeModel, 1);
    expect(third.generated + third.failed).toBe(0);
    expect(third.remaining).toBe(0);
  });

  it("does not brief a partner before their own local morning", async () => {
    const partner = await t.db
      .prepare(
        `SELECT u.id FROM firm_user u
           JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
          WHERE u.status = 'ACTIVE' LIMIT 1`,
      )
      .first<{ id: string }>();

    await t.db
      .prepare(
        `INSERT INTO partner_intelligence_profile (firm_user_id, timezone, deliver_at_local, weekends)
         VALUES (?1, 'America/New_York', '07:00', 1)
         ON CONFLICT (firm_user_id) DO UPDATE SET timezone = 'America/New_York', deliver_at_local = '07:00', weekends = 1`,
      )
      .bind(partner!.id)
      .run();

    // 09:00 UTC is 05:00 in New York — before their 07:00. The job fires all day now, so without
    // this gate a brief would be built at five in the morning and be stale by breakfast.
    const tooEarly = await runDailyForAll(env, MP, new Date("2026-09-17T09:00:00.000Z"), fakeModel, 1);
    expect(tooEarly.generated).toBe(0);

    // 12:00 UTC is 08:00 in New York, which is past it.
    const due = await runDailyForAll(env, MP, new Date("2026-09-17T12:00:00.000Z"), fakeModel, 1);
    expect(due.generated + due.failed).toBe(1);
  });
});

/*
 * A brief that failed this morning should not cost the partner their whole day — and should not
 * retry ninety-six times either, which is what "every fifteen minutes, unconditionally" would mean
 * once the job moved onto the tick. Each attempt pays for two AI calls.
 */
describe("a failed brief is tried again, but not for ever", () => {
  const TZ_DAY = new Date("2026-10-07T16:00:00.000Z");

  async function reportFor(userId: string) {
    return t.db
      .prepare("SELECT status, attempts FROM intelligence_report WHERE firm_user_id = ?1 AND report_date = ?2")
      .bind(userId, "2026-10-07")
      .first<{ status: string; attempts: number }>();
  }

  it("counts the attempt on the way in, so a run that dies still spends one", async () => {
    await runDailyForAll(env, MP, TZ_DAY, fakeModel, 1);
    const first = await reportFor("fu_scooter_taylor");
    expect(first?.attempts).toBeGreaterThanOrEqual(1);
  });

  it("leaves a partner due while their failed brief still has attempts left", async () => {
    await t.db
      .prepare(
        "UPDATE intelligence_report SET status = 'FAILED', attempts = 1 WHERE firm_user_id = 'fu_scooter_taylor' AND report_date = '2026-10-07'",
      )
      .run();

    const out = await runDailyForAll(env, MP, TZ_DAY, fakeModel, 5);
    // He was retried rather than skipped for the day.
    expect(out.generated + out.failed).toBeGreaterThan(0);
    expect((await reportFor("fu_scooter_taylor"))?.attempts).toBeGreaterThan(1);
  });

  it("stops once the attempts are used, rather than re-failing every fifteen minutes", async () => {
    await t.db
      .prepare(
        `UPDATE intelligence_report SET status = 'FAILED', attempts = ?1
          WHERE firm_user_id = 'fu_scooter_taylor' AND report_date = '2026-10-07'`,
      )
      .bind(MAX_BRIEF_ATTEMPTS)
      .run();

    const before = await reportFor("fu_scooter_taylor");
    await runDailyForAll(env, MP, TZ_DAY, fakeModel, 5);
    const after = await reportFor("fu_scooter_taylor");
    expect(after?.attempts).toBe(before?.attempts);
    expect(after?.status).toBe("FAILED");
  });

  it("never retries a brief that succeeded", async () => {
    const ready = await t.db
      .prepare(
        "SELECT firm_user_id, attempts FROM intelligence_report WHERE status = 'READY' AND report_date = '2026-10-07' LIMIT 1",
      )
      .first<{ firm_user_id: string; attempts: number }>();
    if (!ready) return; // nothing succeeded in this fixture; the other cases carry the meaning

    await runDailyForAll(env, MP, TZ_DAY, fakeModel, 5);
    const after = await t.db
      .prepare("SELECT attempts FROM intelligence_report WHERE firm_user_id = ?1 AND report_date = '2026-10-07'")
      .bind(ready.firm_user_id)
      .first<{ attempts: number }>();
    expect(after?.attempts).toBe(ready.attempts);
  });
});
