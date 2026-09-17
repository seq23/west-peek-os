import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { MAX_BRIEF_ATTEMPTS, runBriefTick, type BriefDeps } from "../src/worker/services/dailyIntelligence";
import { fredUrl, parseCoinbaseSpot, parseFredCsv } from "../src/worker/effects/macroClient";

/**
 * The brief is built one STAGE per tick (15 Sep 2026).
 *
 * Production that morning: seven consecutive ticks died building Sequoia's brief before the model
 * was called. This proves the shape that replaced the one-shot build: gathered → market read →
 * written, one per tick; the numbers come from a fetch with an as-of date and a page; a brief
 * missing a section is FAILED with the reason, never delivered thin; and a busy stage is not
 * started twice.
 */

let t: TestDb;
let env: Env;
const MP: Actor = { type: "HUMAN", firmUserId: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
// A Tuesday, 09:00 New York — both partners' earliest start (06:15) has passed.
const T0 = new Date("2026-09-15T13:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const V5 = (over: Record<string, string> = {}) => [
  "executive_summary", "top_headlines", "markets_macro", "capital_markets", "venture_private",
  "government_legal", "ai_technology", "watchlist", "investor_insight", "key_events", "watch",
].map((k) => `===SECTION ${k}\n${over[k] ?? (k === "top_headlines" ? HEADLINES : `A substantial paragraph about ${k}, the figure in **bold**, cited [1].`)}\n===END`).join("\n");

// Five headlines, each scored, because a brief without the scores is refused
// (docs/EXECUTIVE_BRIEF_SPECIFICATION.md §2). The fixture stands for a good brief, so it is one.
const HEADLINES = Array.from(
  { length: 5 },
  (_, i) => `**${i + 1}. A headline as a full claim** [1] — the figure in **bold**.\n\n**Investor Importance: ${i + 2}/10**`,
).join("\n\n");

const deps = (output: string | (() => string)): BriefDeps => ({
  synthesise: async () => ({ output: typeof output === "function" ? output() : output, aiRunId: null, model: "fake-test-model" }),
  macro: async () => ({
    readings: [{ instrument: "US10Y", label: "10-year Treasury yield", value: "4.96%", numericValue: 4.96, asOf: "2026-09-11", sourceUrl: "https://fred.stlouisfed.org/series/DGS10", sourceName: "FRED DGS10" }],
    failures: [{ instrument: "BRENT", label: "Brent crude", detail: "HTTP 503" }],
  }),
  market: async () => ({ ok: true, levels: [{ instrument: "S&P 500 futures", level: "6,120", move: null }], calendar: [], citations: ["https://cnbc.test/premarket"], aiRunId: null, detail: "ok" }),
});

async function report(user: string, date = "2026-09-15") {
  return (await env.WP_OS_DB.prepare("SELECT id, status, error_code, error_message, attempts, candidate_count FROM intelligence_report WHERE firm_user_id = ?1 AND report_date = ?2").bind(user, date).first<{ id: string; status: string; error_code: string | null; error_message: string | null; attempts: number; candidate_count: number }>())!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const src = await env.WP_OS_DB.prepare("SELECT id FROM intelligence_source LIMIT 1").first<{ id: string }>();
  await env.WP_OS_DB.prepare(`INSERT INTO intelligence_run (id, trigger_kind, idempotency_key, status, requested_by_type, requested_by_id, firm_scope)
    VALUES ('irun_fx','MANUAL','fixture-run','SUCCEEDED','HUMAN','fu_sequoia_taylor','west-peek')`).run();
  await env.WP_OS_DB.prepare(`INSERT INTO intelligence_item (id, run_id, source_id, dedupe_hash, title, body, url, published_at, category, firm_scope, created_at) VALUES
    ('ii_1', 'irun_fx', ?1, 'h1', 'Fed holds rates, signals October cut', 'The Federal Reserve held rates and signalled a cut in October.', 'https://reuters.test/fed', '2026-09-15T11:00:00Z', 'MARKET', 'west-peek', '2026-09-15T11:00:00Z'),
    ('ii_2', 'irun_fx', ?1, 'h2', 'Acme raises a $40M Series B', 'Acme raised forty million dollars led by a growth fund.', 'https://tc.test/acme', '2026-09-15T10:00:00Z', 'FUNDING_MA', 'west-peek', '2026-09-15T10:00:00Z')`).bind(src!.id).run();
  await env.WP_OS_DB.prepare("UPDATE partner_intelligence_profile SET timezone = 'America/New_York', earliest_start_local = '06:15', enabled = 1").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the fetched figures", () => {
  it("reads the last dated observation out of a FRED CSV and skips a missing day", () => {
    expect(parseFredCsv("observation_date,DGS10\n2026-09-10,4.95\n2026-09-11,4.96\n2026-09-14,.\n")).toEqual({ date: "2026-09-11", value: "4.96" });
    expect(parseFredCsv("observation_date,DGS10\n")).toBeNull();
  });

  it("asks FRED for a fortnight, not the whole series — parsing the whole series is CPU", () => {
    expect(fredUrl("DGS10", new Date("2026-09-15T12:00:00Z"))).toBe("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-09-01");
  });

  it("reads the Coinbase spot amount and refuses anything else", () => {
    expect(parseCoinbaseSpot('{"data":{"amount":"76702.91","base":"BTC","currency":"USD"}}')).toBe("76702.91");
    expect(parseCoinbaseSpot('{"data":{}}')).toBeNull();
    expect(parseCoinbaseSpot("<html>")).toBeNull();
  });
});

describe("one stage per tick", () => {
  it("tick 1 gathers and ranks; tick 2 reads the numbers; tick 3 writes, verifies and delivers", async () => {
    const d = deps(V5());
    const one = await runBriefTick(env, MP, at(0), d);
    expect(one.stage).toBe("gathered");
    expect((await report(one.partner!)).status).toBe("RANKING");

    const two = await runBriefTick(env, MP, at(15), d);
    expect(two.partner).toBe(one.partner);
    expect(two.stage).toBe("market_read");
    const mid = await report(one.partner!);
    expect(mid.status).toBe("GENERATING");
    expect(mid.candidate_count).toBe(2);
    // The fetched figure is kept on its own table, dated, with the page it came from.
    const reading = await env.WP_OS_DB.prepare("SELECT value, as_of, source_url FROM macro_reading WHERE instrument = 'US10Y'").first<{ value: string; as_of: string; source_url: string }>();
    expect(reading).toEqual({ value: "4.96%", as_of: "2026-09-11", source_url: "https://fred.stlouisfed.org/series/DGS10" });

    const three = await runBriefTick(env, MP, at(30), d);
    expect(three.stage).toBe("written");
    const done = await report(one.partner!);
    expect(done.status).toBe("READY");
    const sections = (await env.WP_OS_DB.prepare("SELECT section_key, body_md FROM intelligence_report_section WHERE report_id = ?1 ORDER BY position").bind(done.id).all<{ section_key: string; body_md: string }>()).results!;
    expect(sections.map((s) => s.section_key)).toEqual([
      "executive_summary", "top_headlines", "markets_macro", "capital_markets", "venture_private",
      "government_legal", "ai_technology", "watchlist", "investor_insight", "key_events", "watch", "citations",
    ]);
    // The footer resolves every [n]: the two swept sources, the fetched figure's page, the market read.
    const footer = sections.find((s) => s.section_key === "citations")!.body_md;
    expect(footer).toMatch(/\[[12]\] https:\/\/reuters\.test\/fed/);
    expect(footer).toMatch(/\[[12]\] https:\/\/tc\.test\/acme/);
    expect(footer).toContain("[3] https://fred.stlouisfed.org/series/DGS10 — FRED DGS10 — 10-year Treasury yield, as of 2026-09-11");
    expect(footer).toContain("[4] https://cnbc.test/premarket");
    const delivered = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM intelligence_delivery WHERE report_id = ?1 AND status = 'DELIVERED'").bind(done.id).first<{ n: number }>();
    expect(delivered!.n).toBe(1);

    // The next tick moves to the OTHER partner rather than touching a READY brief.
    const four = await runBriefTick(env, MP, at(45), d);
    expect(four.partner).not.toBe(one.partner);
    expect(four.stage).toBe("gathered");
  });

  it("does not start a stage another tick still holds", async () => {
    // The second partner's row is RANKING with a fresh lease from tick 4; a tick a minute later
    // must leave it alone rather than read the market twice.
    const partner = (await env.WP_OS_DB.prepare("SELECT firm_user_id FROM intelligence_report WHERE status = 'RANKING'").first<{ firm_user_id: string }>())!.firm_user_id;
    await env.WP_OS_DB.prepare("UPDATE intelligence_report SET stage_lease_until = ?2 WHERE firm_user_id = ?1 AND status = 'RANKING'").bind(partner, at(60).toISOString()).run();
    const busy = await runBriefTick(env, MP, at(46), deps(V5()));
    expect(busy.partner).toBeNull();
    expect(busy.detail).toMatch(/no brief is owed right now/);
    await env.WP_OS_DB.prepare("UPDATE intelligence_report SET stage_lease_until = NULL WHERE firm_user_id = ?1").bind(partner).run();
  });

  it("a brief missing a section is FAILED with the reason, never delivered thin — and the retry says what was wrong", async () => {
    const partner = (await env.WP_OS_DB.prepare("SELECT firm_user_id FROM intelligence_report WHERE status = 'RANKING'").first<{ firm_user_id: string }>())!.firm_user_id;
    let calls = 0;
    const thin = deps(() => { calls += 1; return V5().replace(/===SECTION watch\n[\s\S]*?===END/, ""); });
    await runBriefTick(env, MP, at(60), thin); // market
    const out = await runBriefTick(env, MP, at(75), thin); // write
    expect(out.stage).toBe("failed");
    expect(calls, "one retry, told what was wrong").toBe(2);
    const row = await report(partner);
    expect(row.status).toBe("FAILED");
    expect(row.error_code).toBe("incomplete");
    expect(row.error_message).toContain("the watch section is missing");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM intelligence_report_section WHERE report_id = ?1").bind(row.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("a failed brief is started again from the top on the next tick, spending an attempt", async () => {
    const partner = (await env.WP_OS_DB.prepare("SELECT firm_user_id FROM intelligence_report WHERE status = 'FAILED'").first<{ firm_user_id: string }>())!.firm_user_id;
    const before = (await report(partner)).attempts;
    const again = await runBriefTick(env, MP, at(90), deps(V5()));
    expect(again.partner).toBe(partner);
    expect(again.stage).toBe("gathered");
    expect((await report(partner)).attempts).toBe(before + 1);
    expect(before + 1).toBeLessThanOrEqual(MAX_BRIEF_ATTEMPTS);
  });
});
