import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import {
  deliverReport, generateForPartner, loadProfile, runDailyForAll, type Synthesise,
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
    expect(row!.prompt_version).toBe("daily-intelligence-v1");
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
