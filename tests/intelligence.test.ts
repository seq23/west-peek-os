import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { dedupeKeyFor, runIntelligence, scoreRelevance } from "../src/worker/services/intelligence";
import { buildHome } from "../src/worker/services/mpHome";

/**
 * P14 — MP Command Center + Daily Intelligence Engine (GAP-04, GAP-05, GAP-23).
 *
 * Rules under test:
 * - The engine is idempotent by key: a replayed run acquires nothing twice.
 * - Dedupe is by normalized headline + link, firm-wide and across runs.
 * - Relevance is a DETERMINISTIC heuristic whose reason names the rules that fired.
 * - Every stored item carries at least one citation.
 * - An HTTP_FEED source with no egress client fails CLOSED: the run is PARTIAL, the
 *   source is EGRESS_GATED, and nothing is invented to fill the gap.
 * - INTERNAL acquisition reads governed West Peek state and nothing else.
 * - Synthesis goes through run_ai; a quarantined output is NOT copied into why_matters.
 * - An item is never evidence: nothing here writes diligence_claim / knowledge_record.
 * - The private personal-intelligence layer is owner-only — the OTHER Managing Partner
 *   cannot read it, and MP is deliberately not a master key there.
 * - MP home is a read-only aggregation that omits (not empties) modules the caller
 *   has no privacy scope for.
 */

let t: TestDb;
let env: Env;

const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

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

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${crypto.randomUUID().slice(0, 8)}`;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("relevance is a stated heuristic, not a judgement", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");

  it("names every rule that fired, and scores nothing when nothing matches", () => {
    const none = scoreRelevance(
      { title: "Unrelated headline", body: "", category: "OTHER", company_id: null, published_at: null },
      [],
      [],
      now,
    );
    expect(none.score).toBe(0);
    expect(none.reason).toContain("heuristic");
    expect(none.reason).toContain("no watchlist");
    expect(none.matchedWatchlistIds).toEqual([]);
  });

  it("credits a watchlist keyword match and says which entry matched", () => {
    const hit = scoreRelevance(
      { title: "Acme raises Series C", body: "secondary market interest", category: "FUNDING_MA", company_id: null, published_at: null },
      [{ id: "wl_1", label: "Acme", kind: "COMPANY", company_id: null, keywords_json: '["acme"]' }],
      [],
      now,
    );
    expect(hit.matchedWatchlistIds).toEqual(["wl_1"]);
    expect(hit.score).toBeCloseTo(0.5);
    expect(hit.reason).toContain("watchlist match");
  });

  it("stacks category preference, tracked company, and recency, and caps at 1", () => {
    const stacked = scoreRelevance(
      {
        title: "Acme secondary block trades at a discount",
        body: "",
        category: "SECONDARIES",
        company_id: "cc_acme",
        published_at: "2026-08-11T00:00:00.000Z",
      },
      [{ id: "wl_1", label: "Acme", kind: "COMPANY", company_id: "cc_acme", keywords_json: "[]" }],
      ["SECONDARIES"],
      now,
    );
    expect(stacked.score).toBe(1);
    expect(stacked.reason).toContain("category SECONDARIES is in briefing preferences");
    expect(stacked.reason).toContain("names a tracked canonical company");
    expect(stacked.reason).toContain("published within 3 days");
  });

  it("does not credit recency for a stale item", () => {
    const stale = scoreRelevance(
      { title: "Old news", body: "", category: "MARKET", company_id: null, published_at: "2026-01-01T00:00:00.000Z" },
      [],
      [],
      now,
    );
    expect(stale.reason).not.toContain("published within 3 days");
  });
});

describe("dedupe identity", () => {
  it("treats punctuation, case, protocol, trailing slash, and query strings as noise", () => {
    expect(dedupeKeyFor("Acme Raises $50M!", "https://news.example.com/acme/")).toBe(
      dedupeKeyFor("acme raises 50m", "http://news.example.com/acme?utm_source=x"),
    );
  });

  it("keeps genuinely different stories distinct", () => {
    expect(dedupeKeyFor("Acme raises", "https://a.example/1")).not.toBe(dedupeKeyFor("Beta raises", "https://a.example/2"));
  });
});

describe("the engine acquires, dedupes, cites, and refuses to invent", () => {
  it("runs manually, keeps items, and writes a citation for every one of them", async () => {
    const key = uniq("run");
    const res = await call<{ run: any; items: any[]; replayed: boolean }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: key,
      source_keys: ["operator_desk"],
      manual_items: [
        {
          title: "Late-stage secondaries pricing firmed this week",
          url: "https://example.test/secondaries-1",
          body: "Blocks in AI infrastructure names cleared closer to last primary.",
          category: "SECONDARIES",
          citation_locator: "Operator desk note, 2026-08-12",
          citation_quote: "Blocks cleared closer to last primary.",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.run.status).toBe("SUCCEEDED");
    expect(res.body.run.items_kept).toBe(1);
    expect(res.body.items).toHaveLength(1);

    const item = await call<{ citations: any[]; relevance_reason: string; why_matters_origin: string }>(
      `/api/intelligence/items/${res.body.items[0].id}`,
      SCOOTER,
    );
    expect(item.status).toBe(200);
    expect(item.body.citations).toHaveLength(1);
    expect(item.body.citations[0].locator).toBe("Operator desk note, 2026-08-12");
    expect(item.body.relevance_reason).toContain("heuristic");
    expect(item.body.why_matters_origin).toBe("DETERMINISTIC");
  });

  it("replays an idempotency key instead of acquiring twice", async () => {
    const key = uniq("idem");
    const body = {
      idempotency_key: key,
      source_keys: ["operator_desk"],
      manual_items: [
        { title: "Idempotency probe headline", url: "https://example.test/idem", citation_locator: "desk" },
      ],
    };
    const first = await call<{ run: any; replayed: boolean }>("/api/intelligence/runs", SCOOTER, "POST", body);
    expect(first.status).toBe(201);
    expect(first.body.run.items_kept).toBe(1);

    const replay = await call<{ run: any; replayed: boolean; items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.run.id).toBe(first.body.run.id);
    expect(replay.body.run.items_kept).toBe(1);
    expect(replay.body.items).toHaveLength(1);
  });

  it("counts the same story acquired under a NEW key as a duplicate, not a new item", async () => {
    const shared = {
      title: "Duplicate story about a funding round",
      url: "https://example.test/dupe",
      citation_locator: "desk",
    };
    const a = await call<{ run: any }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("dupe-a"),
      source_keys: ["operator_desk"],
      manual_items: [shared],
    });
    expect(a.body.run.items_kept).toBe(1);

    const b = await call<{ run: any }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("dupe-b"),
      source_keys: ["operator_desk"],
      manual_items: [{ ...shared, title: "DUPLICATE story about a funding round!" }],
    });
    expect(b.body.run.items_acquired).toBe(1);
    expect(b.body.run.items_duplicate).toBe(1);
    expect(b.body.run.items_kept).toBe(0);
  });

  it("fails CLOSED on an external feed: EGRESS_GATED source, PARTIAL run, nothing fabricated", async () => {
    const created = await call<{ id: string; status: string; status_detail: string }>("/api/intelligence/sources", SCOOTER, "POST", {
      source_key: uniq("feed"),
      name: "A real external feed",
      kind: "HTTP_FEED",
      url: "https://feeds.example.test/markets.xml",
      category: "MARKET",
      data_class: "PUBLIC",
    });
    expect(created.status).toBe(201);
    // Registering a URL is not the same as being able to read it.
    expect(created.body.status).toBe("EGRESS_GATED");
    expect(created.body.status_detail).toContain("UNPROVEN");

    const sourceKey = (await call<{ sources: any[] }>("/api/intelligence/sources", SCOOTER)).body.sources.find(
      (s: any) => s.id === created.body.id,
    ).source_key;

    const run = await call<{ run: any; items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("gated"),
      source_keys: [sourceKey],
    });
    expect(run.body.run.status).toBe("PARTIAL");
    expect(run.body.run.sources_failed).toBe(1);
    expect(run.body.items).toHaveLength(0);
    const report = JSON.parse(run.body.run.source_report_json) as Array<{ ok: boolean; detail: string }>;
    expect(report[0]!.ok).toBe(false);
    // P29 CHANGED WHY THIS FAILS, NOT THAT IT FAILS. Outbound retrieval is now authorised, so the
    // client genuinely attempts the fetch instead of refusing up front. In this hermetic runtime
    // there is no network, so it fails — and the guarantees that matter are unchanged and asserted
    // above: PARTIAL run, zero items, source marked failed, nothing invented to fill the gap.
    expect(report[0]!.detail).toMatch(/source failure|EGRESS_GATED|refused/);
    // Whatever the reason, it must be a REPORTED reason and not silent success.
    expect(report[0]!.detail.length).toBeGreaterThan(10);

    const after = (await call<{ sources: any[] }>("/api/intelligence/sources", SCOOTER)).body.sources.find(
      (s: any) => s.id === created.body.id,
    );
    expect(after.status).toBe("EGRESS_GATED");
    expect(after.last_checked_at).not.toBeNull();
  });

  it("acquires INTERNAL items from governed firm state only", async () => {
    const company = await call<{ id: string }>("/api/companies", SCOOTER, "POST", { canonical_name: uniq("Internal Co") });
    const opp = await call<{ id: string }>("/api/opportunities", SCOOTER, "POST", {
      company_id: company.body.id,
      opportunity_type: "SECONDARY_PURCHASE",
      title: "Block from a departing employee",
    });
    expect(opp.status).toBe(201);

    const run = await call<{ run: any; items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("internal"),
      source_keys: ["firm_state"],
    });
    expect(run.body.run.status).toBe("SUCCEEDED");
    const fromOpportunity = run.body.items.find((i: any) => i.company_id === company.body.id);
    expect(fromOpportunity).toBeDefined();
    expect(fromOpportunity.privacy_label).toBe("CONFIDENTIAL");

    const detail = await call<{ citations: any[] }>(`/api/intelligence/items/${fromOpportunity.id}`, SCOOTER);
    expect(detail.body.citations[0].locator).toContain("investment_opportunity/");
  });

  it("never writes into the evidence substrate", async () => {
    const claims = await t.db.prepare("SELECT COUNT(*) AS n FROM diligence_claim").first<{ n: number }>();
    const knowledge = await t.db.prepare("SELECT COUNT(*) AS n FROM knowledge_record").first<{ n: number }>();
    // The engine has run several times above; evidence remains untouched by it.
    expect(claims!.n).toBe(0);
    expect(knowledge!.n).toBe(0);
  });
});

describe("watchlists change the ranking and are owner-scoped", () => {
  it("scores a watchlisted story above an unwatched one in the same run", async () => {
    const add = await call<{ id: string }>("/api/intelligence/watchlist", SCOOTER, "POST", {
      kind: "TOPIC",
      label: "quantum networking",
      keywords: ["quantum networking"],
    });
    expect(add.status).toBe(201);

    const run = await call<{ items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("watch"),
      source_keys: ["operator_desk"],
      manual_items: [
        { title: "A quantum networking startup raised a seed round", citation_locator: "desk" },
        { title: "An unrelated logistics rollup closed", citation_locator: "desk" },
      ],
    });
    const watched = run.body.items.find((i: any) => i.title.includes("quantum"))!;
    const unwatched = run.body.items.find((i: any) => i.title.includes("logistics"))!;
    expect(watched.relevance_score).toBeGreaterThan(unwatched.relevance_score);
    expect(watched.relevance_reason).toContain("watchlist match");
    expect(watched.why_matters).toContain("watchlist");
  });

  it("refuses to let one user deactivate another user's entry", async () => {
    const mine = await call<{ id: string }>("/api/intelligence/watchlist", SEQUOIA, "POST", {
      kind: "SECTOR",
      label: "defense tech",
      keywords: [],
    });
    const attempt = await call(`/api/intelligence/watchlist/${mine.body.id}/active`, SCOOTER, "POST", { active: false });
    expect(attempt.status).toBe(403);
  });

  it("refuses a watchlist company that is not a canonical company (D3)", async () => {
    const res = await call("/api/intelligence/watchlist", SCOOTER, "POST", {
      kind: "COMPANY",
      label: "Ghost Co",
      company_id: "cc_does_not_exist",
    });
    expect(res.status).toBe(404);
  });
});

describe("synthesis respects the AI quarantine boundary", () => {
  it("writes why_matters from an unquarantined local run and records the run id", async () => {
    const run = await call<{ items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("synth"),
      source_keys: ["operator_desk"],
      manual_items: [{ title: "A headline worth explaining", body: "Some context.", citation_locator: "desk" }],
    });
    const itemId = run.body.items[0].id;

    const synth = await call<{ applied: boolean; run: any; item: any }>(`/api/intelligence/items/${itemId}/synthesize`, SCOOTER, "POST");
    expect(synth.status).toBe(200);
    // Default firm policy is LOCKDOWN → deterministic local adapter → unquarantined.
    expect(synth.body.run.status).toBe("COMPLETED");
    expect(synth.body.run.output_quarantine).toBe(0);
    expect(synth.body.applied).toBe(true);
    expect(synth.body.item.why_matters_origin).toBe("AI_ACCEPTED");
    expect(synth.body.item.synthesis_run_id).toBe(synth.body.run.id);
  });

  it("does NOT copy a quarantined external output into why_matters", async () => {
    // Move the firm to FRONTIER so the external path (which quarantines) is taken.
    await t.db
      .prepare(
        `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
         VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 25.0, 2.0, 'fu_scooter_taylor')`,
      )
      .bind(`bp_${crypto.randomUUID()}`)
      .run();

    const run = await call<{ items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("quarantine"),
      source_keys: ["operator_desk"],
      manual_items: [{ title: "A public headline for the external path", body: "Public context.", citation_locator: "desk" }],
    });
    const item = run.body.items[0];
    // The item is PUBLIC-labelled data so the egress policy can allow it; whether the
    // provider call succeeds or is blocked, the quarantined text must never be applied.
    const synth = await call<{ applied: boolean; item: any; reason: string | null }>(
      `/api/intelligence/items/${item.id}/synthesize`,
      SCOOTER,
      "POST",
    );
    expect(synth.body.applied).toBe(false);
    expect(synth.body.item.why_matters_origin).not.toBe("AI_ACCEPTED");
    expect(synth.body.item.why_matters).toBe(item.why_matters);

    // Restore LOCKDOWN so later tests see the fail-closed default.
    await t.db
      .prepare(
        `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
         VALUES (?1, 'west-peek', 'NORMAL', 'LOCKDOWN', 25.0, 2.0, 'fu_scooter_taylor')`,
      )
      .bind(`bp_${crypto.randomUUID()}`)
      .run();
  });
});

describe("archive and feedback", () => {
  it("archives an item out of the active set while preserving the record", async () => {
    const run = await call<{ items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("archive"),
      source_keys: ["operator_desk"],
      manual_items: [{ title: "An item destined for the archive", citation_locator: "desk" }],
    });
    const id = run.body.items[0].id;
    const archived = await call<{ archived: number; archived_by: string }>(`/api/intelligence/items/${id}/archive`, SCOOTER, "POST");
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(1);
    expect(archived.body.archived_by).toBe("fu_scooter_taylor");

    const active = await call<{ items: any[] }>("/api/intelligence/items", SCOOTER);
    expect(active.body.items.find((i: any) => i.id === id)).toBeUndefined();
    const all = await call<{ items: any[] }>("/api/intelligence/items?archived=1", SCOOTER);
    expect(all.body.items.find((i: any) => i.id === id)).toBeDefined();

    const again = await call(`/api/intelligence/items/${id}/archive`, SCOOTER, "POST");
    expect(again.status).toBe(409);
  });

  it("records feedback append-only and refuses UPDATE at the database layer", async () => {
    const run = await call<{ items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("feedback"),
      source_keys: ["operator_desk"],
      manual_items: [{ title: "An item worth a signal", citation_locator: "desk" }],
    });
    const id = run.body.items[0].id;
    const fb = await call<{ id: string }>(`/api/intelligence/items/${id}/feedback`, SCOOTER, "POST", {
      signal: "NOT_RELEVANT",
      note: "wrong sector for us",
    });
    expect(fb.status).toBe(201);
    await expect(
      t.db.prepare("UPDATE intelligence_feedback SET signal = 'USEFUL' WHERE id = ?1").bind(fb.body.id).run(),
    ).rejects.toThrow(/append-only/);
  });
});

describe("briefing is one archived artifact per day per user", () => {
  it("assembles once and returns the same briefing on a second read", async () => {
    const first = await call<{ briefing: any; items: any[] }>("/api/briefings/current?date=2026-08-12", SCOOTER);
    expect(first.status).toBe(200);
    expect(first.body.briefing.briefing_date).toBe("2026-08-12");
    expect(first.body.briefing.selection_rule).toContain("relevance");

    const second = await call<{ briefing: any }>("/api/briefings/current?date=2026-08-12", SCOOTER);
    expect(second.body.briefing.id).toBe(first.body.briefing.id);
  });

  it("gives each user their own briefing for the same date", async () => {
    const mine = await call<{ briefing: any }>("/api/briefings/current?date=2026-08-13", SCOOTER);
    const theirs = await call<{ briefing: any }>("/api/briefings/current?date=2026-08-13", SEQUOIA);
    expect(mine.body.briefing.id).not.toBe(theirs.body.briefing.id);
  });

  it("surfaces the categories a GP actually chose, ahead of higher-scoring items", async () => {
    // REGRESSION: `preferredCategoriesFor` and `briefing_json.categories` both existed, but the
    // briefing query ignored them — every GP got the same firm-wide top-N and the preference was
    // inert. This asserts the preference now changes what appears.
    const runRow = await t.db.prepare("SELECT id FROM intelligence_run ORDER BY started_at DESC LIMIT 1").first<{ id: string }>();
    const srcRow = await t.db.prepare("SELECT id FROM intelligence_source LIMIT 1").first<{ id: string }>();
    if (!runRow || !srcRow) return;

    // A LOW-scoring AI_TECH item, and a HIGH-scoring item in another category.
    await t.db
      .prepare(
        `INSERT OR IGNORE INTO intelligence_item
           (id, run_id, source_id, title, body, dedupe_hash, category, relevance_score, privacy_label)
         VALUES ('ii_pref_ai', ?1, ?2, 'AI tech item', '', 'dh_pref_ai', 'AI_TECH', 0.10, 'INTERNAL')`,
      )
      .bind(runRow.id, srcRow.id)
      .run();
    await t.db
      .prepare(
        `INSERT OR IGNORE INTO intelligence_item
           (id, run_id, source_id, title, body, dedupe_hash, category, relevance_score, privacy_label)
         VALUES ('ii_pref_other', ?1, ?2, 'Regulatory item', '', 'dh_pref_other', 'REGULATORY', 0.99, 'INTERNAL')`,
      )
      .bind(runRow.id, srcRow.id)
      .run();

    // A DEDICATED reader. Setting a preference on Scooter would leak into the versioning and
    // privacy tests, which assert against his preference history — shared fixtures make a passing
    // suite depend on execution order.
    await t.db
      .prepare(
        "INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_pref_reader', 'pref-reader@westpeek.ventures', 'Pref Reader', 'ACTIVE')",
      )
      .run();
    await t.db
      .prepare("INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_pref_reader', 'role_investment_team')")
      .run();
    const READER = { "x-wpos-dev-user": "pref-reader@westpeek.ventures" };

    await call("/api/mp-home/preferences", READER, "POST", {
      modules: [],
      briefing: { max_items: 1, categories: ["AI_TECH"] },
    });

    const res = await call<{ items: Array<{ id: string; category: string }> }>(
      "/api/briefings/current?date=2026-08-19",
      READER,
    );
    expect(res.body.items).toHaveLength(1);
    // The preferred category wins despite the other item scoring 0.99 against 0.10.
    expect(res.body.items[0]!.category).toBe("AI_TECH");
  });
});

describe("the briefing respects privacy labels (final-review finding)", () => {
  it("keeps a RESTRICTED item out of the briefing of a user without the scope", async () => {
    await t.db
      .prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_brief_scopeless', 'brief@westpeek.ventures', 'Brief Reader', 'ACTIVE')")
      .run();
    await t.db
      .prepare("INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_brief_scopeless', 'role_investment_team')")
      .run();
    const SCOPELESS = { "x-wpos-dev-user": "brief@westpeek.ventures" };

    // A source may be registered at any data class; its items inherit that label. RESTRICTED is
    // one of the four SENSITIVE labels an unscoped user may never see (P3).
    const sourceKey = uniq("restricted-desk");
    const source = await call<{ id: string }>("/api/intelligence/sources", SCOOTER, "POST", {
      source_key: sourceKey,
      name: "Restricted operator desk",
      kind: "MANUAL",
      data_class: "RESTRICTED",
    });
    expect(source.status).toBe(201);

    const run = await call<{ items: any[] }>("/api/intelligence/runs", SCOOTER, "POST", {
      idempotency_key: uniq("brief-privacy"),
      source_keys: [sourceKey],
      manual_items: [{ title: uniq("A restricted headline"), citation_locator: "restricted desk" }],
    });
    const restricted = run.body.items[0]!;
    expect(restricted.privacy_label).toBe("RESTRICTED");

    // The MP sees it in their briefing.
    const mpBriefing = await call<{ items: any[] }>("/api/briefings/current?date=2026-09-01", SCOOTER);
    expect(mpBriefing.body.items.some((i: any) => i.id === restricted.id)).toBe(true);

    // A user without the scope must not: the briefing is a READ of the same items, so the same
    // visibility rule applies. Before this repair the briefing had no privacy clause at all.
    const theirs = await call<{ items: any[] }>("/api/briefings/current?date=2026-09-01", SCOPELESS);
    expect(theirs.status).toBe(200);
    expect(theirs.body.items.some((i: any) => i.id === restricted.id)).toBe(false);
    expect(theirs.body.items.every((i: any) => i.privacy_label !== "RESTRICTED")).toBe(true);

    // And the same item is invisible on the ordinary item list, as it always was.
    const theirList = await call<{ items: any[] }>("/api/intelligence/items", SCOPELESS);
    expect(theirList.body.items.some((i: any) => i.id === restricted.id)).toBe(false);
  });
});

describe("home preferences are versioned, never edited in place", () => {
  it("writes a new version per change and keeps the history", async () => {
    const v1 = await call<{ version_no: number }>("/api/mp-home/preferences", SCOOTER, "POST", {
      modules: ["approvals", "intelligence"],
      briefing: { categories: ["SECONDARIES"], max_items: 5 },
    });
    expect(v1.status).toBe(201);
    expect(v1.body.version_no).toBe(1);

    const v2 = await call<{ version_no: number }>("/api/mp-home/preferences", SCOOTER, "POST", {
      modules: ["approvals", "intelligence", "portfolio_risk"],
      briefing: { categories: ["SECONDARIES", "PORTFOLIO"], max_items: 8 },
    });
    expect(v2.body.version_no).toBe(2);

    const read = await call<{ preference: any; history: any[] }>("/api/mp-home/preferences", SCOOTER);
    expect(read.body.preference.version_no).toBe(2);
    expect(read.body.history).toHaveLength(2);

    await expect(
      t.db.prepare("UPDATE mp_home_preference SET modules_json = '[]' WHERE firm_user_id = 'fu_scooter_taylor'").run(),
    ).rejects.toThrow(/immutable/);
  });
});

describe("MP home aggregates without widening access", () => {
  it("answers the ten Managing Partner questions from real modules", async () => {
    const home = await call<{ modules: any[]; questions: any[]; one_thing_to_watch: any }>("/api/mp-home", SCOOTER);
    expect(home.status).toBe(200);
    expect(home.body.questions).toHaveLength(10);
    const answered = home.body.questions.filter((q: any) => q.module !== null);
    expect(answered.length).toBeGreaterThan(0);
    for (const m of home.body.modules) {
      expect(typeof m.link).toBe("string");
      expect(typeof m.answers).toBe("string");
    }
  });

  it("states the rule behind 'one thing to watch' rather than asserting judgement", async () => {
    const home = await call<{ one_thing_to_watch: { because: string } | null }>("/api/mp-home", SCOOTER);
    if (home.body.one_thing_to_watch) {
      expect(home.body.one_thing_to_watch.because).toContain("rule:");
    }
  });

  it("omits LP and banking modules entirely for a user without the scope", async () => {
    await t.db
      .prepare(
        `INSERT INTO mp_home_preference (id, firm_user_id, version_no, modules_json, briefing_json, set_by)
         VALUES (?1, 'fu_test_member', 1, ?2, '{}', 'fu_test_member')`,
      )
      .bind(`mhp_${crypto.randomUUID()}`, JSON.stringify(["approvals", "lp_signals", "reconciliation", "my_work"]))
      .run();

    const home = await call<{ modules: any[] }>("/api/mp-home", MEMBER);
    const keys = home.body.modules.map((m: any) => m.key);
    expect(keys).toContain("approvals");
    expect(keys).not.toContain("lp_signals");
    expect(keys).not.toContain("reconciliation");
  });

  it("turns 'what changed' into a real diff once the operator marks home seen", async () => {
    const before = await buildHome(env, {
      id: "fu_sequoia_taylor",
      email: "sequoia@westpeek.ventures",
      fullName: "Sequoia Taylor",
      status: "ACTIVE",
      roles: ["MANAGING_PARTNER"],
      authorityScopes: [],
    });
    const firstVisit = before.modules.find((m) => m.key === "what_changed");
    expect(firstVisit?.note).toContain("First visit");

    const seen = await call<{ last_viewed_at: string }>("/api/mp-home/seen", SEQUOIA, "POST");
    expect(seen.status).toBe(200);

    const after = await call<{ modules: any[] }>("/api/mp-home", SEQUOIA);
    const changed = after.body.modules.find((m: any) => m.key === "what_changed");
    expect(changed.note).toContain("Diff since");
  });
});

describe("private personal intelligence is owner-only and honest about calculation", () => {
  it("starts UNPROVEN with no calculation source, and says so", async () => {
    const read = await call<{ profile: any; calculation_note: string }>("/api/personal-intelligence/profile", SCOOTER);
    expect(read.status).toBe(200);
    expect(read.body.profile).toBeNull();
    expect(read.body.calculation_note).toContain("does not compute planetary positions");
  });

  it("refuses entries until the owner enables their own layer", async () => {
    const refused = await call("/api/personal-intelligence/entries", SCOOTER, "POST", {
      entry_date: "2026-08-12",
      kind: "TRANSIT",
      headline: "premature",
    });
    expect(refused.status).toBe(409);
  });

  it("records operator entries as MANUAL_ENTRY, never as a computed ephemeris", async () => {
    const enabled = await call<{ profile: any }>("/api/personal-intelligence/profile", SCOOTER, "POST", {
      enabled: true,
      config: { overlays: ["TRANSIT"] },
      calculation_source: "NONE",
    });
    expect(enabled.status).toBe(201);
    expect(enabled.body.profile.calculation_state).toBe("UNPROVEN_NO_SOURCE");

    const entry = await call<{ entry: any; disclaimer: string }>("/api/personal-intelligence/entries", SCOOTER, "POST", {
      entry_date: "2026-08-12",
      kind: "TIMING_WINDOW",
      headline: "Hold the fund-terms conversation until next week",
    });
    expect(entry.status).toBe(201);
    expect(entry.body.entry.calculation_state).toBe("MANUAL_ENTRY");
    expect(entry.body.entry.source_note).toContain("no ephemeris source");
    expect(entry.body.disclaimer).toContain("Not institutional truth");
  });

  it("hides one Managing Partner's layer from the other Managing Partner", async () => {
    const otherMp = await call<{ entries: any[] }>("/api/personal-intelligence/entries", SEQUOIA);
    expect(otherMp.status).toBe(200);
    expect(otherMp.body.entries).toHaveLength(0);

    const owner = await call<{ entries: any[] }>("/api/personal-intelligence/entries", SCOOTER);
    expect(owner.body.entries.length).toBeGreaterThan(0);
  });

  it("keeps personal entries append-only", async () => {
    const owner = await call<{ entries: any[] }>("/api/personal-intelligence/entries", SCOOTER);
    await expect(
      t.db.prepare("UPDATE personal_intelligence_entry SET headline = 'rewritten' WHERE id = ?1").bind(owner.body.entries[0].id).run(),
    ).rejects.toThrow(/append-only/);
  });

  it("never leaks personal content into the firm event spine", async () => {
    const events = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'personal_intelligence.configured'")
      .all<{ payload_json: string }>();
    expect((events.results ?? []).length).toBeGreaterThan(0);
    for (const e of events.results ?? []) {
      expect(e.payload_json).not.toContain("overlays");
      expect(e.payload_json).not.toContain("Hold the fund-terms");
    }
  });
});

describe("the engine passes through authorize() like every other subsystem", () => {
  it("records a typed event for each completed run", async () => {
    const key = uniq("event");
    const res = await runIntelligence(env, MP_ACTOR, { idempotencyKey: key, triggerKind: "MANUAL" }, { manualItems: [] });
    const evt = await t.db
      .prepare("SELECT * FROM event_record WHERE object_id = ?1 AND event_type = 'intelligence_run.completed'")
      .bind(res.run.id)
      .first<{ payload_json: string }>();
    expect(evt).not.toBeNull();
    expect(JSON.parse(evt!.payload_json).status).toBe(res.run.status);
  });

  it("denies an unknown actor at the route boundary", async () => {
    const res = await call("/api/intelligence/items", { "x-wpos-dev-user": "stranger@example.com" });
    expect(res.status).toBe(401);
  });
});
