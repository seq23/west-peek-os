import type { Env } from "../env";
import { appendEvent } from "../events";
import { recordSwallowed } from "./swallowed";
import { runAi } from "../ai/runAi";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { notifyQuietly } from "./notifications";
import {
  DEFAULT_LENS, EMPTY_INTERESTS, INTEREST_SUGGESTIONS, FIRM_INTERESTS, LENSES, editionLine, effectiveInterests,
  isFirmInterest, isLensKey, lensFor, normaliseInterest, type LensKey, type PartnerInterests,
} from "../../shared/intelligence/interests";
import {
  PROMPT_VERSION, REPORT_SECTIONS, buildSources, buildSynthesisPrompt, citedEventIds, parseReport,
  renderCitations, resolveEventIds, verifyBrief, verifyReport,
  type EvidenceEvent, type EvidencePacket, type MacroReadingInput,
} from "../../shared/intelligence/reportSchema";
import {
  SOURCE_AUTHORITY, classify, dedupe, isAfterLocalTime, isWeekend, localReportDate, rank,
  type NormalisedItem, type PartnerLens, type SourceType,
} from "../../shared/intelligence/pipeline";
import { readMarket, type MarketRead } from "./liveSearch";
import { fetchMacroReadings, type MacroFailure, type MacroReading } from "../effects/macroClient";
import { deliver } from "./deliverables";
import { machineForKey } from "./attribution";
import { chiefOfStaffFor } from "../../shared/work/chiefOfStaff";
import { recentFeedbackFor } from "./deliverables";
import { z } from "zod";

/** Local body reader, matching the one in intelligence.ts: a malformed body is null, never a throw. */
async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Daily Executive Intelligence — the orchestrator (P41).
 *
 * Stages run in order and each records its progress on `intelligence_report.status`, so a run that
 * dies at 6:47am leaves evidence of WHERE it died rather than a missing report.
 *
 *   GATHERING → RANKING → GENERATING → VERIFYING → READY
 *
 * WHAT IS DELIBERATELY NOT HERE. No source fetching: sweeps already gather items into
 * `intelligence_item` through the existing run pipeline with its SSRF guards and its receipts.
 * This reads what sweeps collected. Duplicating acquisition would give the firm two source
 * pipelines with two sets of guards, and the second one always rots.
 *
 * COST CONTROL, per the brief's funnel: deduplication and ranking are arithmetic
 * (shared/intelligence/pipeline.ts), and only the surviving candidates reach a model. One
 * synthesis call per partner per day.
 *
 * GRACEFUL DEGRADATION: one partner failing must not stop another's report; a failed delivery must
 * not mark a good report failed. Both are enforced below rather than hoped for.
 */

export class DailyIntelError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

/** How many candidates reach synthesis. The brief asks for 20–50 from hundreds. */
const MAX_CANDIDATES = 30;

interface ProfileRow {
  firm_user_id: string;
  timezone: string;
  weekends: number;
  enabled: number;
  sectors_json: string;
  companies_json: string;
  themes_json: string;
  depth_json: string;
  /** Which way this partner reads the brief: 'investing' or 'growth'. See interests.ts. */
  lens: string;
}

function parseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A partner's profile, defaulted rather than absent — a partner with no row still gets a report. */
export async function loadProfile(env: Env, firmUserId: string): Promise<ProfileRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM partner_intelligence_profile WHERE firm_user_id = ?1")
    .bind(firmUserId)
    .first<ProfileRow>();
  return (
    row ?? {
      firm_user_id: firmUserId, timezone: "America/Chicago", weekends: 0, enabled: 1,
      sectors_json: "[]", companies_json: "[]", themes_json: "[]", depth_json: "{}", lens: DEFAULT_LENS,
    }
  );
}

function lensFrom(p: ProfileRow): PartnerLens {
  let depth: Record<string, number> = {};
  try {
    const parsed = JSON.parse(p.depth_json);
    if (parsed && typeof parsed === "object") depth = parsed as Record<string, number>;
  } catch { /* a malformed dial set means default depth, never a failed report */ }

  // The stored lists are what this partner ADDED. What the brief is written against is those plus
  // the firm floor — so a partner who has configured nothing still gets a complete briefing, and
  // one who has configured plenty still hears about the portfolio.
  const merged = effectiveInterests({
    sectors: parseArray(p.sectors_json),
    themes: parseArray(p.themes_json),
    companies: parseArray(p.companies_json),
  });
  return { sectors: merged.sectors, companies: parseArray(p.companies_json), themes: merged.themes, depth };
}

/** This partner's own additions, without the firm floor mixed in — what the interface edits. */
export async function loadInterests(env: Env, firmUserId: string): Promise<PartnerInterests> {
  const p = await loadProfile(env, firmUserId);
  return {
    sectors: parseArray(p.sectors_json),
    themes: parseArray(p.themes_json),
    companies: parseArray(p.companies_json),
  };
}

/** Firm-level entities that lift an item for everyone: portfolio, watchlist, live pipeline. */
async function firmEntities(env: Env, firmScope: string): Promise<string[]> {
  const q = async (sql: string) =>
    ((await env.WP_OS_DB.prepare(sql).bind(firmScope).all<{ name: string }>()).results ?? []).map((r) => r.name);
  const [portfolio, watchlist, pipeline] = await Promise.all([
    q(`SELECT DISTINCT c.canonical_name AS name FROM position p JOIN canonical_company c ON c.id = p.company_id
        WHERE p.status = 'OPEN' AND p.firm_scope = ?1 LIMIT 100`),
    q(`SELECT label AS name FROM watchlist_entry WHERE active = 1 AND firm_scope = ?1 LIMIT 100`),
    q(`SELECT DISTINCT c.canonical_name AS name FROM investment_opportunity o JOIN canonical_company c ON c.id = o.company_id
        WHERE o.status NOT IN ('PASS','CLOSED','WITHDRAWN') AND o.firm_scope = ?1 LIMIT 100`),
  ]);
  return Array.from(new Set([...portfolio, ...watchlist, ...pipeline].filter(Boolean)));
}

/** Map a sweep source's kind onto the pipeline's authority model. */
function sourceTypeOf(kind: string | null): SourceType {
  switch ((kind ?? "").toUpperCase()) {
    case "INTERNAL": return "internal";
    case "FILING": return "filing";
    case "GOVERNMENT": return "government";
    case "MARKET_DATA": return "market_data";
    case "RSS":
    case "NEWS": return "news";
    default: return "other";
  }
}

/** Read what the sweeps pipeline has already collected. */
async function gather(env: Env, firmScope: string, sinceIso: string): Promise<NormalisedItem[]> {
  // BOUNDED ON THE WAY IN. The body is cut to what the packet keeps (700 chars) in SQL, and the
  // window is 300 items: deserialising 500 full bodies was itself milliseconds of a 10 ms tick.
  const rows = await env.WP_OS_DB.prepare(
    `SELECT i.id, i.title, substr(i.body, 1, 700) AS body, i.url, i.published_at, i.category, i.created_at,
            s.kind AS source_kind, s.name AS source_name
       FROM intelligence_item i
       LEFT JOIN intelligence_source s ON s.id = i.source_id
      WHERE i.archived = 0 AND i.firm_scope = ?1
        AND COALESCE(i.published_at, i.created_at) >= ?2
      ORDER BY COALESCE(i.published_at, i.created_at) DESC
      LIMIT 300`,
  )
    .bind(firmScope, sinceIso)
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map((r) => {
    const sourceType = sourceTypeOf(r.source_kind as string | null);
    const title = String(r.title ?? "");
    const summary = r.body ? String(r.body) : null;
    return {
      id: String(r.id),
      sourceType,
      title,
      summary,
      url: r.url ? String(r.url) : null,
      publisher: r.source_name ? String(r.source_name) : null,
      publishedAt: (r.published_at ?? r.created_at) ? String(r.published_at ?? r.created_at) : null,
      entities: [],
      // The stored category is a sweep-time label; classify() adds the investor taxonomy on top.
      categories: classify({ title, summary }),
      sourceAuthority: SOURCE_AUTHORITY[sourceType],
    };
  });
}

/** Running stories, so today can say what changed. */
async function openNarratives(env: Env, firmScope: string) {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT topic, summary, last_seen_date FROM tracked_narrative WHERE status = 'ACTIVE' AND firm_scope = ?1 ORDER BY last_seen_date DESC LIMIT 12",
  )
    .bind(firmScope)
    .all<{ topic: string; summary: string; last_seen_date: string }>();
  return (rows.results ?? []).map((n) => ({ topic: n.topic, summary: n.summary, last_seen: n.last_seen_date }));
}

export interface GenerateResult {
  report_id: string;
  status: string;
  sections: number;
  candidates: number;
  flags: number;
}

/**
 * Generate one partner's report for one day.
 *
 * Idempotent on (firm_scope, firm_user_id, report_date): a second call the same day REPLACES the
 * sections of the existing report rather than creating a second one. The brief is explicit that a
 * retry must not deliver twice.
 */
export interface SynthesisResult {
  output: string;
  aiRunId: string | null;
  model: string | null;
  failure?: string;
}

/**
 * How the report gets written. Injectable for the same reason feedClient takes a fetchImpl: the
 * pipeline's behaviour — funnel counts, idempotency, verification, delivery — has to be testable
 * without a paid call, and the offline mock adapter returns prose rather than the JSON this
 * pipeline needs, so it cannot stand in for a model.
 */
export type Synthesise = (env: Env, actor: Actor, prompt: string, reportDate: string, firmUserId: string) => Promise<SynthesisResult>;

const defaultSynthesise: Synthesise = async (env, actor, prompt, reportDate, firmUserId) => {
  const intelligenceMachineId = await machineForKey(env, "research_intelligence");
  /*
   * WHOSE BRIEF, BY NAME. The purpose string is not internal bookkeeping — it is the line the AI
   * page lists every run under, so "daily intelligence report 2026-08-19 for fu_sequoia_taylor"
   * put a database id in front of a partner reading their own spend. Written at run time, so this
   * only helps runs from here on; the ones already recorded keep the id they were given.
   */
  const reader = await env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1")
    .bind(firmUserId)
    .first<{ full_name: string }>();
  const { run } = await runAi(env, {
    purpose: `daily intelligence report ${reportDate} for ${reader?.full_name ?? firmUserId}`,
    actor,
    inputs: [prompt],
    // A brief assembled from public sources is PUBLIC. Never raised, so it cannot be blocked by a
    // policy meant for confidential material — and never lowered either.
    sensitivity: "PUBLIC" as never,
    // v3 asks for a report several times longer than v2's, so the estimate has to say so. This
    // number is what the affordability check and the cost centre reason about; leaving it at the
    // old 2000 would have understated every brief by a factor of four.
    budgetContext: { judgement: true, expectedOutputTokens: 8000 },
    /*
     * THE BRIEF IS BUILT FROM OTHER PEOPLE'S WORDS, so a credential-shaped span in it is somebody
     * else's URL slug, not a mistake this firm can correct. On 19 August one such span blocked the
     * whole run and a partner got no brief at all. Redacting cuts the span and keeps the day's
     * intelligence; the span still never reaches a provider. This is the only caller in the system
     * that asks for this, and it asks because it is the only one assembling text nobody here wrote.
     */
    onCredentialLike: "redact",
    // NAMING A TASK CLASS IS WHAT MAKES A ROUTING POLICY POSSIBLE. Without it the router falls back
    // to "cheapest adequate priced model", which chose a flash-tier model and produced a report
    // containing "the 30-year U.S. tax at 19 year high" and a corrupted copy of its own event ids.
    // Structure was never the whole problem: choosing what belongs at the top of a brief is a
    // judgement task, and judgement is the thing the cheap tier does not have.
    // The brief is the Research & Intelligence machine's output. Attributed so its cost lands on that
      // machine's line rather than on nobody's, which is where all 64 prior runs went.
      routing: {
        category: "INTELLIGENCE",
        taskClass: "daily-intelligence",
        ...(intelligenceMachineId === null ? {} : { machineId: intelligenceMachineId }),
      },
  });
  return {
    output: run.output_text ?? "",
    aiRunId: run.id,
    model: (run as unknown as { model?: string }).model ?? null,
    failure: run.status === "COMPLETED" && run.output_text ? undefined : (run.failure_reason ?? `run ${run.status}`),
  };
};

/** What the brief needs from outside the database, injectable so the pipeline is testable offline. */
export interface BriefDeps {
  synthesise?: Synthesise;
  macro?: (now: Date) => Promise<{ readings: MacroReading[]; failures: MacroFailure[] }>;
  market?: (env: Env, actor: Actor, watchlist: readonly string[]) => Promise<MarketRead>;
}

/** How long one stage may hold the row. A stage that writes the brief is one model call, ~3 min. */
export const STAGE_LEASE_MINUTES = 10;

interface ReportRow {
  id: string;
  firm_user_id: string;
  report_date: string;
  status: string;
  attempts: number;
  candidates_json: string | null;
  market_json: string | null;
  stage_lease_until: string | null;
  ai_run_id: string | null;
}

interface StoredMarket {
  readings: MacroReadingInput[];
  failures: Array<{ label: string; detail: string }>;
  levels: MarketRead["levels"];
  calendar: MarketRead["calendar"];
  citations: string[];
  detail: string;
}

async function stamp(env: Env, id: string, status: string, extra: Record<string, string | number | null> = {}): Promise<void> {
  const sets = ["status = ?2", "stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", "stage_lease_until = NULL"];
  const binds: (string | number | null)[] = [id, status];
  for (const [k, v] of Object.entries(extra)) {
    binds.push(v);
    sets.push(`${k} = ?${binds.length}`);
  }
  await env.WP_OS_DB.prepare(`UPDATE intelligence_report SET ${sets.join(", ")} WHERE id = ?1`).bind(...binds).run();
}

async function failReport(env: Env, id: string, code: string, message: string, runId: string | null): Promise<GenerateResult> {
  await env.WP_OS_DB.prepare(
    "UPDATE intelligence_report SET status = 'FAILED', error_code = ?2, error_message = ?3, ai_run_id = ?4, stage_lease_until = NULL, stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(id, code, message.slice(0, 600), runId)
    .run();
  return { report_id: id, status: "FAILED", sections: 0, candidates: 0, flags: 0 };
}

/**
 * Open (or re-open) today's report row for a partner, counting the attempt on the way in.
 *
 * Idempotent on (firm_scope, firm_user_id, report_date): a second call the same day resets the same
 * row to GATHERING rather than creating a second report.
 */
export async function startReport(env: Env, firmScope: string, firmUserId: string, now: Date): Promise<{ id: string; reportDate: string }> {
  const profile = await loadProfile(env, firmUserId);
  const reportDate = localReportDate(now, profile.timezone);
  const reportId = `dir_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO intelligence_report (id, firm_user_id, report_date, status, prompt_version, firm_scope, stage_at)
     VALUES (?1, ?2, ?3, 'GATHERING', ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (firm_scope, firm_user_id, report_date)
       DO UPDATE SET status = 'GATHERING', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), stage_lease_until = NULL,
                     candidates_json = NULL, market_json = NULL, completed_at = NULL,
                     error_code = NULL, error_message = NULL, prompt_version = excluded.prompt_version,
                     -- Counted on the way IN, so a run that dies mid-flight still spends its
                     -- attempt. Counting on success would let a crash loop retry for ever.
                     attempts = intelligence_report.attempts + 1`,
  )
    .bind(reportId, firmUserId, reportDate, PROMPT_VERSION, firmScope)
    .run();
  const row = (await env.WP_OS_DB.prepare(
    "SELECT id FROM intelligence_report WHERE firm_scope = ?1 AND firm_user_id = ?2 AND report_date = ?3",
  ).bind(firmScope, firmUserId, reportDate).first<{ id: string }>())!;
  return { id: row.id, reportDate };
}

/** Stage 1 — gather, dedupe, rank. Arithmetic only. Stores the candidates on the row. */
async function stageGather(env: Env, row: ReportRow, firmScope: string, now: Date): Promise<"RANKING" | "READY"> {
  const profile = await loadProfile(env, row.firm_user_id);
  const since = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const raw = await gather(env, firmScope, since);
  const { events: deduped, supporting } = dedupe(raw);
  const lens = lensFrom(profile);
  const entities = await firmEntities(env, firmScope);
  const candidates = rank(deduped.map((item) => ({ item, lens, firmEntities: entities, now })), { max: MAX_CANDIDATES });

  if (candidates.length === 0) {
    // An empty day is a real outcome, not a failure. Say so and stop — a padded report is worse.
    await env.WP_OS_DB.batch([
      env.WP_OS_DB.prepare("DELETE FROM intelligence_report_section WHERE report_id = ?1").bind(row.id),
      env.WP_OS_DB.prepare(
        `INSERT INTO intelligence_report_section (id, report_id, section_key, position, heading, body_md)
         VALUES (?1, ?2, 'executive_summary', 0, ?3, ?4)`,
      ).bind(`dis_${crypto.randomUUID()}`, row.id, "One-minute executive summary",
        "Nothing reached the bar this morning. Either the sources are quiet or nothing matched what this firm follows."),
      env.WP_OS_DB.prepare(
        "UPDATE intelligence_report SET status = 'READY', raw_count = ?2, deduped_count = ?3, candidate_count = 0, stage_lease_until = NULL, stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      ).bind(row.id, raw.length, deduped.length),
    ]);
    return "READY";
  }

  const packetEvents: EvidenceEvent[] = candidates.map((c) => ({
    event_id: c.id,
    title: c.title,
    summary: (c.summary ?? "").slice(0, 700),
    publisher: c.publisher ?? null,
    published_at: c.publishedAt ?? null,
    categories: c.categories,
    source_urls: [c.url, ...(supporting[c.id] ?? [])].filter((u): u is string => Boolean(u)),
    importance: c.score,
    why_ranked: c.reasons,
  }));
  await stamp(env, row.id, "RANKING", {
    raw_count: raw.length, deduped_count: deduped.length, candidate_count: candidates.length,
    candidates_json: JSON.stringify(packetEvents),
  });
  return "RANKING";
}

/** Stage 2 — the numbers: fetched figures from public pages, then the search-grounded read. I/O. */
async function stageMarket(env: Env, actor: Actor, row: ReportRow, now: Date, deps: BriefDeps): Promise<"GENERATING"> {
  const profile = await loadProfile(env, row.firm_user_id);
  const lens = lensFrom(profile);
  const macroFn = deps.macro ?? ((at: Date) => fetchMacroReadings(at));
  const marketFn = deps.market ?? readMarket;
  const [macro, market] = await Promise.all([
    macroFn(now).catch((err) => ({ readings: [] as MacroReading[], failures: [{ instrument: "US10Y" as const, label: "every fetched figure", detail: err instanceof Error ? err.message : String(err) }] })),
    marketFn(env, actor, lens.companies ?? []),
  ]);
  const stored: StoredMarket = {
    readings: macro.readings.map((r) => ({ label: r.label, value: r.value, asOf: r.asOf, sourceUrl: r.sourceUrl, sourceName: r.sourceName })),
    failures: macro.failures.map((f) => ({ label: f.label, detail: f.detail })),
    levels: market.levels,
    calendar: market.calendar,
    citations: market.citations,
    detail: market.detail,
  };
  // Every fetched figure is also kept on its own table, dated, so a later brief (or a partner)
  // can see what the page said on the day rather than only what the brief made of it.
  if (macro.readings.length > 0) {
    await env.WP_OS_DB.batch(
      macro.readings.map((r) =>
        env.WP_OS_DB.prepare(
          `INSERT INTO macro_reading (id, instrument, value, numeric_value, as_of, source_url, source_name, firm_scope)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (firm_scope, instrument, as_of) DO UPDATE SET value = excluded.value, numeric_value = excluded.numeric_value, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).bind(`mr_${crypto.randomUUID()}`, r.instrument, r.value, r.numericValue, r.asOf, r.sourceUrl, r.sourceName, actor.firmScopes[0] ?? "west-peek"),
      ),
    );
  }
  await stamp(env, row.id, "GENERATING", { market_json: JSON.stringify(stored) });
  return "GENERATING";
}

/** Stage 3 — write, verify, persist. One model call (two if the first reply cannot be used). */
async function stageWrite(env: Env, actor: Actor, row: ReportRow, firmScope: string, deps: BriefDeps): Promise<GenerateResult> {
  const synthesise = deps.synthesise ?? defaultSynthesise;
  const profile = await loadProfile(env, row.firm_user_id);
  const interests = lensFrom(profile);
  const user = await env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1").bind(row.firm_user_id).first<{ full_name: string }>();
  const entities = await firmEntities(env, firmScope);
  const watchlist = ((await env.WP_OS_DB.prepare(
    "SELECT label, kind, keywords_json FROM watchlist_entry WHERE active = 1 AND firm_scope = ?1 ORDER BY label LIMIT 40",
  ).bind(firmScope).all<{ label: string; kind: string; keywords_json: string }>()).results ?? []).map((w) => {
    let keywords: string[] = [];
    try { keywords = (JSON.parse(w.keywords_json) as unknown[]).filter((k): k is string => typeof k === "string"); } catch { keywords = []; }
    return { label: w.label, note: `${w.kind.toLowerCase()}${keywords.length ? `; watch for: ${keywords.join(", ")}` : ""}` };
  });

  let events: EvidenceEvent[] = [];
  let stored: StoredMarket = { readings: [], failures: [], levels: [], calendar: [], citations: [], detail: "" };
  try { events = JSON.parse(row.candidates_json ?? "[]") as EvidenceEvent[]; } catch { events = []; }
  try { stored = { ...stored, ...(JSON.parse(row.market_json ?? "{}") as Partial<StoredMarket>) }; } catch { /* the market read is optional */ }
  if (events.length === 0) return await failReport(env, row.id, "no_candidates", "the ranked candidates were lost between ticks; build it again", null);

  // THE SAME PACKET SHAPE FOR EVERY PARTNER. The lens and the edition line are the only fields a
  // partner's profile changes here; the section list, the sources and the verifier are shared.
  const lens = lensFor(profile.lens);
  const edition = editionLine(user?.full_name ?? "Partner", lens);
  const packet: EvidencePacket = {
    report_date: row.report_date,
    partner_name: user?.full_name ?? "Partner",
    edition,
    lens: { key: lens.key, label: lens.label, categories: lens.categories },
    market_levels: stored.levels,
    calendar: stored.calendar,
    macro_readings: stored.readings,
    macro_failures: stored.failures,
    market_citations: stored.citations,
    watchlist_entries: watchlist,
    firm_context: { sectors: interests.sectors, portfolio: entities.slice(0, 40), watchlist: watchlist.map((w) => w.label), themes: interests.themes },
    open_narratives: await openNarratives(env, firmScope),
    events,
  };
  const sources = buildSources(packet);

  // What the partner said last time, in front of the model before it writes.
  const bylineFor = chiefOfStaffFor(user?.full_name ?? "");
  const feedback = await recentFeedbackFor(env, bylineFor);

  let aiRunId: string | null = null;
  let model: string | null = null;
  let output = "";
  try {
    const result = await synthesise(env, actor, `${feedback}${buildSynthesisPrompt(packet)}`, row.report_date, row.firm_user_id);
    aiRunId = result.aiRunId;
    model = result.model;
    if (result.failure) return await failReport(env, row.id, "synthesis_failed", result.failure, aiRunId);
    output = result.output;
  } catch (err) {
    return await failReport(env, row.id, "synthesis_error", err instanceof Error ? err.message : String(err), aiRunId);
  }

  /*
   * ONE RETRY WHEN THE REPLY CANNOT BE USED — unparseable, or missing a section, or citing a source
   * that does not exist. The second attempt is told exactly what was wrong. One, not a loop: a
   * model that cannot produce the shape twice will not on the third try, and every attempt pays.
   */
  const check = (raw: string) => {
    const parsed = parseReport(raw);
    if (!parsed) return { parsed: null, problems: [{ section: "*", problem: "missing_section" as const, detail: "the reply was not in the ===SECTION format" }] };
    const sections = resolveEventIds(parsed, packet);
    return { parsed: sections, problems: verifyBrief(sections, sources, { watchlistEmpty: watchlist.length === 0 }) };
  };
  let { parsed, problems } = check(output);
  if (!parsed || problems.length > 0) {
    const why = problems.map((p) => p.detail).join("; ");
    const retry = await synthesise(
      env, actor,
      `${feedback}${buildSynthesisPrompt(packet)}\n\nYOUR PREVIOUS REPLY WAS REJECTED: ${why}. Every required section must be present with substance, every section must cite at least one [n] from the SOURCES list, and no [n] may exceed ${sources.length}. Return the whole report again in the ===SECTION format.`,
      row.report_date, row.firm_user_id,
    );
    if (retry.aiRunId) aiRunId = retry.aiRunId;
    if (retry.model) model = retry.model;
    if (!retry.failure && retry.output) ({ parsed, problems } = check(retry.output));
  }
  if (!parsed) return await failReport(env, row.id, "unparseable", "the model did not return a usable report, twice", aiRunId);
  if (problems.length > 0) {
    // NEVER DELIVERED THIN. A brief missing a section, or citing a source that does not exist,
    // is failed with the reason rather than shown with holes.
    return await failReport(env, row.id, "incomplete", `the brief was rejected twice: ${problems.map((p) => p.detail).join("; ")}`, aiRunId);
  }
  const sections = parsed;

  await stamp(env, row.id, "VERIFYING");
  const flags = verifyReport(sections, packet);
  const flagged = new Set(flags.map((f) => f.section));

  const order = new Map<string, number>(REPORT_SECTIONS.map((sec, n) => [sec.key as string, n]));
  const statements = [
    env.WP_OS_DB.prepare("DELETE FROM intelligence_report_section WHERE report_id = ?1").bind(row.id),
    ...sections
      // A flagged section is dropped rather than shown. The brief's whole point is that the operator
      // can trust it; showing a section known to cite something that does not exist would end that.
      .filter((sec) => !flagged.has(sec.key))
      .map((sec) =>
        env.WP_OS_DB.prepare(
          `INSERT INTO intelligence_report_section (id, report_id, section_key, position, heading, body_md, item_ids_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(
          `dis_${crypto.randomUUID()}`, row.id, sec.key, order.get(sec.key) ?? 99,
          REPORT_SECTIONS.find((r) => r.key === sec.key)?.heading ?? sec.key,
          sec.body_md,
          // Event ids from BOTH forms: the ===EVENTS line (older prompts) and the [n] citations.
          JSON.stringify(Array.from(new Set([...sec.event_ids, ...citedEventIds(sec.body_md, sources)]))),
        ),
      ),
    // The footer the [n]s resolve to — written by the system from the sources it supplied.
    env.WP_OS_DB.prepare(
      `INSERT INTO intelligence_report_section (id, report_id, section_key, position, heading, body_md, item_ids_json)
       VALUES (?1, ?2, 'citations', ?3, 'Sources', ?4, '[]')`,
    ).bind(`dis_${crypto.randomUUID()}`, row.id, order.get("citations") ?? 90, renderCitations(sources)),
    env.WP_OS_DB.prepare(
      `UPDATE intelligence_report SET status = 'READY', model = ?2, ai_run_id = ?3, verification_flags = ?4, edition = ?5,
              stage_lease_until = NULL, stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
    ).bind(row.id, model, aiRunId, flags.length, edition),
  ];
  await env.WP_OS_DB.batch(statements);

  await appendEvent(env, {
    eventType: "daily_intelligence.generated",
    actorType: "system", actorId: "system",
    objectType: "intelligence_report", objectId: row.id, firmScope,
    payload: { report_date: row.report_date, candidates: events.length, sections: sections.length, flags: flags.length, sources: sources.length, prompt_version: PROMPT_VERSION, lens: lens.key },
  });

  const kept = sections.filter((sec) => !flagged.has(sec.key)).length;
  return { report_id: row.id, status: "READY", sections: kept, candidates: events.length, flags: flags.length };
}

/**
 * Advance one partner's report by ONE stage. The unit of work a cron tick can carry.
 *
 * The lease is the lock: the cron fires every minute and the writing stage is a three-minute model
 * call, so without it the second tick would start writing the same brief again.
 */
export async function advanceBrief(
  env: Env,
  actor: Actor,
  firmUserId: string,
  now: Date,
  deps: BriefDeps = {},
): Promise<{ report_id: string | null; status: string; stage: "gathered" | "market_read" | "written" | "failed" | "busy" | "none" }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const profile = await loadProfile(env, firmUserId);
  const reportDate = localReportDate(now, profile.timezone);
  const lease = new Date(now.getTime() + STAGE_LEASE_MINUTES * 60_000).toISOString();
  const claimed = await env.WP_OS_DB.prepare(
    `UPDATE intelligence_report SET stage_lease_until = ?4
      WHERE firm_scope = ?1 AND firm_user_id = ?2 AND report_date = ?3
        AND status NOT IN ('READY', 'FAILED')
        AND (stage_lease_until IS NULL OR stage_lease_until < ?5)`,
  ).bind(firmScope, firmUserId, reportDate, lease, now.toISOString()).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const existing = await env.WP_OS_DB.prepare(
      "SELECT id, status FROM intelligence_report WHERE firm_scope = ?1 AND firm_user_id = ?2 AND report_date = ?3",
    ).bind(firmScope, firmUserId, reportDate).first<{ id: string; status: string }>();
    return { report_id: existing?.id ?? null, status: existing?.status ?? "NONE", stage: existing && existing.status !== "READY" && existing.status !== "FAILED" ? "busy" : "none" };
  }
  const row = (await env.WP_OS_DB.prepare(
    "SELECT id, firm_user_id, report_date, status, attempts, candidates_json, market_json, stage_lease_until, ai_run_id FROM intelligence_report WHERE firm_scope = ?1 AND firm_user_id = ?2 AND report_date = ?3",
  ).bind(firmScope, firmUserId, reportDate).first<ReportRow>())!;

  try {
    if (row.status === "QUEUED" || row.status === "GATHERING") {
      const next = await stageGather(env, row, firmScope, now);
      return { report_id: row.id, status: next, stage: "gathered" };
    }
    if (row.status === "RANKING") {
      await stageMarket(env, actor, row, now, deps);
      return { report_id: row.id, status: "GENERATING", stage: "market_read" };
    }
    // GENERATING or VERIFYING: write it (a VERIFYING row is a write that died before persisting).
    const out = await stageWrite(env, actor, row, firmScope, deps);
    return { report_id: row.id, status: out.status, stage: out.status === "READY" ? "written" : "failed" };
  } catch (err) {
    // A throw at any stage closes the row with the real error rather than leaving it mid-flight.
    const message = err instanceof Error ? err.message : String(err);
    await failReport(env, row.id, "generation_threw", message, row.ai_run_id).catch(() => undefined);
    await recordSwallowed(env, "dailyIntelligence.advanceBrief", err, { firm_user_id: firmUserId, report_id: row.id });
    return { report_id: row.id, status: "FAILED", stage: "failed" };
  }
}

/**
 * Generate one partner's report for one day, all stages in one call.
 *
 * The manual route and the tests use this; the cron uses `runBriefTick`, one stage per tick,
 * because a tick has ten milliseconds of CPU and this whole run has three model calls' worth of
 * parsing in it. Idempotent on (firm_scope, firm_user_id, report_date).
 */
export async function generateForPartner(
  env: Env,
  actor: Actor,
  firmUserId: string,
  now: Date,
  synthesise: Synthesise = defaultSynthesise,
  deps: Omit<BriefDeps, "synthesise"> = {},
): Promise<GenerateResult> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const { id } = await startReport(env, firmScope, firmUserId, now);
  const all: BriefDeps = { ...deps, synthesise };
  for (let i = 0; i < 4; i++) {
    const step = await advanceBrief(env, actor, firmUserId, now, all);
    if (step.status === "READY" || step.status === "FAILED") {
      const row = await env.WP_OS_DB.prepare("SELECT status, candidate_count, verification_flags FROM intelligence_report WHERE id = ?1").bind(id).first<{ status: string; candidate_count: number; verification_flags: number }>();
      const sections = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM intelligence_report_section WHERE report_id = ?1 AND section_key != 'citations'").bind(id).first<{ n: number }>())?.n ?? 0;
      return { report_id: id, status: row?.status ?? step.status, sections, candidates: row?.candidate_count ?? 0, flags: row?.verification_flags ?? 0 };
    }
    if (step.stage === "busy" || step.stage === "none") break;
  }
  return await failReport(env, id, "stalled", "the brief did not reach READY in one run; the row is left for the clock", null);
}

/**
 * Deliver a report. Separate from generation so a delivery failure never marks a good report bad,
 * and so a retry re-sends rather than regenerating.
 */
export async function deliverReport(env: Env, reportId: string): Promise<{ delivered: boolean }> {
  const report = await env.WP_OS_DB.prepare(
    "SELECT id, firm_user_id, report_date, status, firm_scope, edition FROM intelligence_report WHERE id = ?1",
  )
    .bind(reportId)
    .first<{ id: string; firm_user_id: string; report_date: string; status: string; firm_scope: string; edition: string | null }>();
  if (!report) throw new DailyIntelError(404, "not_found");
  if (report.status !== "READY") throw new DailyIntelError(409, "not_ready", `report is ${report.status}`);

  const prior = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) n FROM intelligence_delivery WHERE report_id = ?1",
  )
    .bind(reportId)
    .first<{ n: number }>();

  const summary = await env.WP_OS_DB.prepare(
    "SELECT body_md FROM intelligence_report_section WHERE report_id = ?1 ORDER BY position LIMIT 1",
  )
    .bind(reportId)
    .first<{ body_md: string }>();

  await notifyQuietly(env, {
    firmUserId: report.firm_user_id,
    kind: "INTELLIGENCE_BRIEF",
    severity: "INFO",
    dedupeKey: `daily_intelligence:${report.firm_user_id}:${report.report_date}`,
    title: `Your ${report.report_date} briefing`,
    body: (summary?.body_md ?? "Your briefing is ready.").slice(0, 240),
    objectType: "intelligence_report",
    objectId: reportId,
    firmScope: report.firm_scope,
  });

  await env.WP_OS_DB.prepare(
    `INSERT INTO intelligence_delivery (id, report_id, channel, status, detail, attempt)
     VALUES (?1, ?2, 'IN_APP', 'DELIVERED', 'in-app notification', ?3)`,
  )
    .bind(`did_${crypto.randomUUID()}`, reportId, (prior?.n ?? 0) + 1)
    .run();

  /*
   * AND HAND IT OVER AS A DELIVERABLE, so the brief can be kept.
   *
   * A notification tells you it exists; a deliverable is the thing itself — filed in Documents,
   * downloadable, emailable. The brief has been the firm's best output for months and there has
   * never been a way to send one to anybody, which is the gap the deliverable road closes for all
   * four artifacts at once.
   *
   * SIGNED BY THE READER'S OWN CHIEF OF STAFF. Intelligence assembles it; a person hands it over,
   * which is the whole delivery model and was the operator's explicit instruction for this artifact.
   *
   * Best effort: a failed handover must not fail a delivered brief.
   */
  try {
    const reader = await env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1")
      .bind(report.firm_user_id)
      .first<{ full_name: string }>();
    const sections = ((await env.WP_OS_DB.prepare(
      "SELECT heading, body_md FROM intelligence_report_section WHERE report_id = ?1 ORDER BY position",
    ).bind(reportId).all<{ heading: string; body_md: string }>()).results ?? []);

    if (sections.length > 0) {
      await deliver(
        env,
        { type: "SYSTEM", firmUserId: null, firmScopes: [report.firm_scope], roles: [] } as unknown as Actor,
        {
          kind: "daily_brief",
          title: `Morning brief — ${report.report_date}`,
          // The edition line leads the filed copy, so a brief read from Documents says whose it is.
          body: [report.edition ? `_${report.edition}_` : "", ...sections.map((sec) => `## ${sec.heading}\n\n${sec.body_md}`)].filter(Boolean).join("\n\n"),
          preparedBy: chiefOfStaffFor(reader?.full_name ?? ""),
          preparedFor: report.firm_user_id,
          sourceType: "intelligence_report",
          sourceId: reportId,
        },
      );
    }
  } catch (err) {
    // The brief is delivered. It simply has no filed copy — recorded, so a handover that has
    // silently stopped working shows up in Activity rather than in an empty table months later.
    await recordSwallowed(env, "daily_intelligence.deliverable", err, { report_id: reportId });
  }

  return { delivered: true };
}

/**
 * Every enabled partner. One partner failing is caught and recorded so the others still get a
 * report — the brief calls this out and it is the difference between one bad morning and none.
 */
/**
 * How many times a partner's brief may be attempted on one date.
 *
 * Three across a morning survives a provider blip and a bad feed. A fourth would be the system
 * insisting rather than trying, and every attempt pays for two AI calls.
 */
export const MAX_BRIEF_ATTEMPTS = 3;

/**
 * ONE PARTNER PER TICK, because a cron invocation gets ten milliseconds of CPU.
 *
 * This used to loop every partner in one invocation. On the Workers Free plan a Cron Trigger gets
 * 10 ms of CPU (Paid gets 30 s), and a brief is two AI calls and a report build per partner — so
 * the loop never reached its second partner, and usually died before its first. Four of the last
 * eight briefs failed that way, all of them the scheduled ones; every brief that succeeded was a
 * human pressing the button, which runs a DIFFERENT path that generates for one partner only.
 *
 * So: take the first partner who has no finished report for today, do that one, and say how many
 * are left. The next tick takes the next. `UNIQUE (firm_scope, firm_user_id, report_date)` plus the
 * report status IS the cursor — no new column, no new table, no new Cloudflare product. Fifteen
 * minutes between ticks means both partners are done inside half an hour.
 *
 * `limit` exists so the manual path can still do everyone in one go: a human pressing the button is
 * not on the cron's CPU budget, and making them press it once per partner would be absurd.
 */
/**
 * Is any partner's brief still owed today? The scheduled tick asks this first: a tick that owes a
 * brief builds only the brief; otherwise it reads one source. (A dry-run of `runDailyForAll`'s own
 * "due" filter, with none of the work.)
 */
export async function briefsOwedToday(env: Env, now: Date, firmScope = "west-peek"): Promise<boolean> {
  const partners = await env.WP_OS_DB.prepare(
    `SELECT u.id, COALESCE(p.enabled, 1) AS enabled, COALESCE(p.timezone,'America/Chicago') AS timezone,
            COALESCE(p.weekends, 0) AS weekends, COALESCE(p.earliest_start_local,'06:15') AS earliest_start_local
       FROM firm_user u
       LEFT JOIN partner_intelligence_profile p ON p.firm_user_id = u.id
       JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
      WHERE u.status = 'ACTIVE'`,
  ).all<{ id: string; enabled: number; timezone: string; weekends: number; earliest_start_local: string }>();
  const done = new Set(
    (
      (
        await env.WP_OS_DB.prepare(
          `SELECT firm_user_id, report_date FROM intelligence_report
            WHERE firm_scope = ?1 AND report_date >= ?2
              AND (status = 'READY' OR (status = 'FAILED' AND attempts >= ${MAX_BRIEF_ATTEMPTS}))`,
        )
          .bind(firmScope, new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10))
          .all<{ firm_user_id: string; report_date: string }>()
      ).results ?? []
    ).map((r) => `${r.firm_user_id}:${r.report_date}`),
  );
  return (partners.results ?? []).some(
    (p) =>
      p.enabled === 1 &&
      (p.weekends === 1 || !isWeekend(now, p.timezone)) &&
      isAfterLocalTime(now, p.timezone, p.earliest_start_local) &&
      !done.has(`${p.id}:${localReportDate(now, p.timezone)}`),
  );
}

export async function runDailyForAll(
  env: Env,
  actor: Actor,
  now: Date,
  synthesise: Synthesise = defaultSynthesise,
  limit = Number.POSITIVE_INFINITY,
  deps: Omit<BriefDeps, "synthesise"> = {},
): Promise<{ generated: number; failed: number; remaining: number }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const partners = await env.WP_OS_DB.prepare(
    `SELECT u.id, COALESCE(p.enabled, 1) AS enabled, COALESCE(p.timezone,'America/Chicago') AS timezone,
            COALESCE(p.weekends, 0) AS weekends, COALESCE(p.earliest_start_local,'06:15') AS earliest_start_local
       FROM firm_user u
       LEFT JOIN partner_intelligence_profile p ON p.firm_user_id = u.id
       JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
      WHERE u.status = 'ACTIVE'`,
  ).all<{ id: string; enabled: number; timezone: string; weekends: number; earliest_start_local: string }>();

  // Before starting anything: close out yesterday's casualties. A row still marked GENERATING from
  // a run that died hours ago is not in progress, and leaving it that way hides today's real state.
  await closeAbandonedReports(env, now).catch(async (err) => {
    await recordSwallowed(env, "dailyIntelligence.closeAbandonedReports", err);
    return 0;
  });

  /*
   * WHO STILL NEEDS ONE TODAY. A partner with a READY or FAILED report for today is finished:
   * READY means they have their brief, FAILED means it was tried and recorded, and re-running a
   * failure inside the same day is the retry decision made in jobs.ts, not here.
   */
  // Keyed by partner AND date, because "today" is the partner's own local date — the report_date on
  // the row comes from `localReportDate(now, profile.timezone)`, and two partners in different
  // timezones can legitimately be on different days at the same instant.
  const done = new Set(
    (
      (
        await env.WP_OS_DB.prepare(
          /*
           * READY is finished. FAILED is finished only once it has used its attempts.
           *
           * Treating any FAILED report as finished meant one transient failure at 06:45 cost the
           * partner their entire day — which is exactly what happened to Scooter on 21 Aug 2026.
           * Retrying unconditionally is the opposite mistake: the job fires every fifteen minutes,
           * so that is ninety-six attempts a day, each paying for two AI calls to fail again.
           */
          `SELECT firm_user_id, report_date FROM intelligence_report
            WHERE firm_scope = ?1 AND report_date >= ?2
              AND (status = 'READY' OR (status = 'FAILED' AND attempts >= ${MAX_BRIEF_ATTEMPTS}))`,
        )
          .bind(firmScope, new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10))
          .all<{ firm_user_id: string; report_date: string }>()
      ).results ?? []
    ).map((r) => `${r.firm_user_id}:${r.report_date}`),
  );

  const due = (partners.results ?? []).filter(
    (p) =>
      p.enabled === 1 &&
      (p.weekends === 1 || !isWeekend(now, p.timezone)) &&
      // Their own hour, in their own timezone. The job now fires all day, so this is the gate the
      // 06:00 schedule used to be — without it a brief gets built at midnight local and is stale
      // by the time anybody reads it.
      // The moment the brief may BEGIN, chosen so it is finished before the partner looks —
      // not the moment it is delivered. See migration 0099.
      isAfterLocalTime(now, p.timezone, p.earliest_start_local) &&
      !done.has(`${p.id}:${localReportDate(now, p.timezone)}`),
  );

  let generated = 0;
  let failed = 0;
  for (const p of due) {
    if (generated + failed >= limit) break;
    try {
      const out = await generateForPartner(env, actor, p.id, now, synthesise, deps);
      if (out.status === "READY") {
        generated += 1;
        await deliverReport(env, out.report_id).catch(async (err) => {
          // Generation succeeded; only delivery failed. Recorded and retryable.
          await env.WP_OS_DB.prepare(
            `INSERT INTO intelligence_delivery (id, report_id, channel, status, detail)
             VALUES (?1, ?2, 'IN_APP', 'FAILED', ?3)`,
          )
            .bind(`did_${crypto.randomUUID()}`, out.report_id, String(err).slice(0, 400))
            .run();
        });
      } else failed += 1;
    } catch (err) {
      /*
       * A THROW HERE USED TO VANISH. This catch was bare — `catch { failed += 1 }` — so when
       * generation threw part-way through, three things happened and none of them were visible:
       * the report row stayed at whatever stage it had reached, the error was discarded, and the
       * only trace was a number in a return value nobody reads. Sequoia's brief sat at VERIFYING
       * for four hours that way, with no error recorded, while the operator was told the system
       * was healthy.
       *
       * The row is now closed out as FAILED carrying the real error, and the swallow goes on the
       * ledger, so the same failure is findable from Activity and turns the health board red.
       */
      failed += 1;
      await env.WP_OS_DB.prepare(
        `UPDATE intelligence_report
            SET status = 'FAILED', error_code = 'generation_threw', error_message = ?2,
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE firm_scope = ?3 AND firm_user_id = ?1 AND status NOT IN ('READY','FAILED')`,
      )
        .bind(p.id, (err instanceof Error ? err.message : String(err)).slice(0, 400), firmScope)
        .run()
        .catch(() => undefined);
      await recordSwallowed(env, "dailyIntelligence.generateForPartner", err, { firm_user_id: p.id });
    }
  }
  // What the tick reports upward, so a partner can see the brief is still being built rather than
  // being told nothing happened.
  return { generated, failed, remaining: Math.max(0, due.length - (generated + failed)) };
}

/**
 * ONE STAGE OF ONE PARTNER'S BRIEF — what a scheduled tick does when a brief is owed.
 *
 * Production, 15 Sep 2026: seven ticks in a row died building Sequoia's brief before the model was
 * called — gather → dedupe → rank over 462 items on a 10 ms budget. A brief is now three ticks:
 * gathered, market read, written. Fifteen minutes apart that is three quarters of an hour after
 * the partner's earliest start, which is why the schedule starts when it does.
 */
export async function runBriefTick(
  env: Env,
  actor: Actor,
  now: Date,
  deps: BriefDeps = {},
): Promise<{ partner: string | null; report_id: string | null; stage: string; status: string; detail: string }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  await closeAbandonedReports(env, now).catch(async (err) => {
    await recordSwallowed(env, "dailyIntelligence.closeAbandonedReports", err);
    return 0;
  });
  const partners = await env.WP_OS_DB.prepare(
    `SELECT u.id, COALESCE(p.enabled, 1) AS enabled, COALESCE(p.timezone,'America/Chicago') AS timezone,
            COALESCE(p.weekends, 0) AS weekends, COALESCE(p.earliest_start_local,'06:15') AS earliest_start_local
       FROM firm_user u
       LEFT JOIN partner_intelligence_profile p ON p.firm_user_id = u.id
       JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
      WHERE u.status = 'ACTIVE' ORDER BY u.id`,
  ).all<{ id: string; enabled: number; timezone: string; weekends: number; earliest_start_local: string }>();
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT firm_user_id, report_date, status, attempts, stage_lease_until FROM intelligence_report
        WHERE firm_scope = ?1 AND report_date >= ?2`,
    ).bind(firmScope, new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)).all<{ firm_user_id: string; report_date: string; status: string; attempts: number; stage_lease_until: string | null }>()
  ).results ?? [];
  const byKey = new Map(rows.map((r) => [`${r.firm_user_id}:${r.report_date}`, r]));

  for (const p of partners.results ?? []) {
    if (p.enabled !== 1) continue;
    if (p.weekends !== 1 && isWeekend(now, p.timezone)) continue;
    if (!isAfterLocalTime(now, p.timezone, p.earliest_start_local)) continue;
    const date = localReportDate(now, p.timezone);
    const row = byKey.get(`${p.id}:${date}`);
    if (row?.status === "READY") continue;
    if (row?.status === "FAILED" && row.attempts >= MAX_BRIEF_ATTEMPTS) continue;
    if (row && row.status !== "FAILED" && row.stage_lease_until && row.stage_lease_until > now.toISOString()) continue;

    if (!row || row.status === "FAILED") await startReport(env, firmScope, p.id, now);
    const step = await advanceBrief(env, actor, p.id, now, deps);
    if (step.status === "READY" && step.report_id) {
      await deliverReport(env, step.report_id).catch(async (err) => {
        await env.WP_OS_DB.prepare(
          `INSERT INTO intelligence_delivery (id, report_id, channel, status, detail) VALUES (?1, ?2, 'IN_APP', 'FAILED', ?3)`,
        ).bind(`did_${crypto.randomUUID()}`, step.report_id, String(err).slice(0, 400)).run();
      });
    }
    const detail =
      step.stage === "gathered" ? (step.status === "READY" ? "nothing reached the bar; an empty-day brief was written" : "gathered and ranked; the next tick reads the numbers")
      : step.stage === "market_read" ? "the numbers were fetched and read; the next tick writes the brief"
      : step.stage === "written" ? "written, verified and delivered"
      : step.stage === "failed" ? "failed — the brief's own row says why"
      : "another tick holds it";
    return { partner: p.id, report_id: step.report_id, stage: step.stage, status: step.status, detail };
  }
  return { partner: null, report_id: null, stage: "none", status: "NONE", detail: "no brief is owed right now" };
}

/**
 * Close out reports that stopped mid-flight.
 *
 * THE CATCH ABOVE CANNOT COVER EVERY CASE, and pretending otherwise is how a row stays stuck. If
 * the isolate is evicted — CPU limit, a deploy landing mid-run, the platform reclaiming it — no
 * code of ours runs at all, so nothing marks the row and nothing is caught. It simply stops, in
 * GATHERING or GENERATING or VERIFYING, and stays there.
 *
 * A row that has been mid-flight for half an hour is not running; the whole pipeline takes about
 * five minutes. Closing it as FAILED is what makes it visible on the health board and what lets a
 * retry be told apart from a run still in progress. `abandoned` is a distinct error code precisely
 * so it is never confused with a run that got far enough to fail on its merits.
 */
export const STALE_AFTER_MINUTES = 30;

export async function closeAbandonedReports(env: Env, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MINUTES * 60_000).toISOString();
  // Judged by the last MOVEMENT (stage_at), not the start: a brief now crosses several ticks and a
  // row that gathered twenty minutes ago and read the market five minutes ago is alive.
  const res = await env.WP_OS_DB.prepare(
    `UPDATE intelligence_report
        SET status = 'FAILED', error_code = 'abandoned',
            error_message = 'The run stopped part-way through and never finished. Build it again.',
            stage_lease_until = NULL,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status NOT IN ('READY','FAILED') AND COALESCE(stage_at, started_at) < ?1`,
  )
    .bind(cutoff)
    .run();
  return res.meta?.changes ?? 0;
}

// ── Route handlers ───────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof DailyIntelError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

/** GET /api/daily-intelligence — today's report for the signed-in partner. */
export async function handleGetDailyReport(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const url = new URL(ctx.request.url);
  const firmUserId = actor.firmUserId!;
  const profile = await loadProfile(ctx.env, firmUserId);
  const date = url.searchParams.get("date") ?? localReportDate(new Date(), profile.timezone);

  const report = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM intelligence_report WHERE firm_user_id = ?1 AND report_date = ?2",
  )
    .bind(firmUserId, date)
    .first<Record<string, unknown>>();
  if (!report) {
    /*
     * WHY THERE IS NO BRIEF, not merely that there is none.
     *
     * Operator, 22 Aug 2026: "my brief was not in my home page today at 7am ET" — and it was a
     * Saturday, with weekends off, so the pipeline had behaved exactly as configured. The bug is
     * that she had to work that out. A blank where a brief should be reads as broken, and a partner
     * who believes the morning brief is broken stops relying on it.
     *
     * So the empty state carries the reason the schedule gives. Reading the profile costs one query
     * on a path that has already decided it has nothing to show.
     */
    const profile = await ctx.env.WP_OS_DB.prepare(
      "SELECT enabled, weekends, timezone, earliest_start_local FROM partner_intelligence_profile WHERE firm_user_id = ?1",
    )
      .bind(firmUserId)
      .first<{ enabled: number; weekends: number; timezone: string; earliest_start_local: string }>();

    let why: string | null = null;
    if (!profile) {
      why = "You have no brief settings yet, so nothing is being built for you.";
    } else if (profile.enabled === 0) {
      why = "Your morning brief is switched off.";
    } else {
      // The reader's own weekday, not the server's: at 02:00 UTC on a Monday it is still Sunday in
      // New York, and the schedule runs on the partner's calendar rather than on UTC's.
      let weekday = "today";
      let isWeekend = false;
      try {
        weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: profile.timezone }).format(new Date());
        isWeekend = weekday === "Saturday" || weekday === "Sunday";
      } catch {
        isWeekend = false;
      }
      if (isWeekend && profile.weekends === 0) {
        why = `No brief on a ${weekday} — weekends are off in your settings. Turn them on if you want one.`;
      } else {
        why = `Nothing built yet today. It starts after ${profile.earliest_start_local} your time, and needs a sweep to have found something.`;
      }
    }
    return json({ report: null, sections: [], date, no_brief_because: why });
  }

  const sections = await ctx.env.WP_OS_DB.prepare(
    "SELECT section_key, heading, body_md, item_ids_json, position FROM intelligence_report_section WHERE report_id = ?1 ORDER BY position",
  )
    .bind(String(report.id))
    .all<Record<string, unknown>>();

  // Attach the real sources for each section. Citations come from records, never from the model.
  const ids = Array.from(new Set((sections.results ?? []).flatMap((s) => {
    try { return JSON.parse(String(s.item_ids_json)) as string[]; } catch { return []; }
  })));
  const items = ids.length
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT i.id, i.title, i.url, s.name AS publisher FROM intelligence_item i
           LEFT JOIN intelligence_source s ON s.id = i.source_id
          WHERE i.id IN (${ids.map(() => "?").join(",")})`,
      ).bind(...ids).all<Record<string, unknown>>()
    : { results: [] as Array<Record<string, unknown>> };

  return json({ report, sections: sections.results ?? [], citations: items.results ?? [], date });
}

/**
 * POST /api/daily-intelligence/generate — build (or rebuild) today's report.
 *
 * `for_firm_user_id` builds another partner's brief. The operator's question was "can you run his
 * brief without him being logged in", and until now the answer was no: this only ever built for
 * the caller, so a failing brief could not be diagnosed or re-run by the partner sitting next to
 * the one it belongs to.
 *
 * MANAGING PARTNER TO MANAGING PARTNER ONLY. The two partners are peers and the brief is firm work,
 * so one re-running the other's is ordinary. Anything else is refused — this must not become a way
 * for a role-less identity to generate, read, or spend against somebody else's profile.
 */
export async function handleGenerateDailyReport(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "intelligence_report", firmScope: actor.firmScopes[0] });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const body = (await ctx.request.json().catch(() => ({}))) as { for_firm_user_id?: unknown };
  let target = actor.firmUserId!;
  if (typeof body.for_firm_user_id === "string" && body.for_firm_user_id !== target) {
    if (!ctx.identity!.roles.includes("MANAGING_PARTNER")) {
      return json({ error: "forbidden", detail: "only a Managing Partner may build another partner's brief" }, { status: 403 });
    }
    const other = await ctx.env.WP_OS_DB.prepare(
      `SELECT u.id FROM firm_user u
         JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
        WHERE u.id = ?1 AND u.status = 'ACTIVE'`,
    ).bind(body.for_firm_user_id).first<{ id: string }>();
    if (!other) {
      return json({ error: "not_a_partner", detail: "briefs can only be built for an active Managing Partner" }, { status: 400 });
    }
    target = other.id;
  }

  /*
   * ONE STAGE PER REQUEST, and the page calls again until it is done. An HTTP request has the same
   * ten milliseconds of CPU as a cron tick, so the button cannot do in one request what the tick
   * could not do in one invocation. A READY or FAILED row is started again from the top; a row
   * mid-flight is advanced one stage.
   */
  try {
    const now = new Date();
    const firmScope = actor.firmScopes[0] ?? "west-peek";
    const profile = await loadProfile(ctx.env, target);
    const reportDate = localReportDate(now, profile.timezone);
    const existing = await ctx.env.WP_OS_DB.prepare(
      "SELECT status FROM intelligence_report WHERE firm_scope = ?1 AND firm_user_id = ?2 AND report_date = ?3",
    ).bind(firmScope, target, reportDate).first<{ status: string }>();
    const fresh = !existing || existing.status === "READY" || existing.status === "FAILED";
    if (fresh) await startReport(ctx.env, firmScope, target, now);
    const step = await advanceBrief(ctx.env, actor, target, now, {});
    if (step.status === "READY" && step.report_id) await deliverReport(ctx.env, step.report_id).catch(() => undefined);
    const done = step.status === "READY" || step.status === "FAILED";
    const row = step.report_id
      ? await ctx.env.WP_OS_DB.prepare("SELECT status, error_message, candidate_count FROM intelligence_report WHERE id = ?1").bind(step.report_id).first<{ status: string; error_message: string | null; candidate_count: number }>()
      : null;
    return json({
      report_id: step.report_id, status: row?.status ?? step.status, stage: step.stage, done,
      candidates: row?.candidate_count ?? 0, detail: row?.error_message ?? null,
    }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Interests: what this partner has added to their own briefing ──

/**
 * Read the interests screen: the firm floor, this partner's additions, and what they could add.
 *
 * The floor is returned alongside rather than merged, because the interface has to show the two
 * differently — one is a list you edit, the other is a statement of what you get regardless.
 */
export async function handleGetInterests(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const profile = await loadProfile(ctx.env, actor.firmUserId!);
  const mine: PartnerInterests = {
    sectors: parseArray(profile.sectors_json), themes: parseArray(profile.themes_json), companies: parseArray(profile.companies_json),
  };
  return json({
    firm: { sectors: FIRM_INTERESTS.sectors, themes: FIRM_INTERESTS.themes },
    mine,
    // The lens: the one named difference between two partners' briefs, and the choices on offer.
    lens: lensFor(profile.lens),
    lenses: Object.values(LENSES),
    suggestions: INTEREST_SUGGESTIONS,
    note:
      "Firm interests are on every partner's brief and cannot be removed — a partner should still " +
      "hear that a portfolio company is in trouble whatever else they follow. What you add here is " +
      "yours alone and changes what leads your brief, how much room it gets, and which sections " +
      "get written at all.",
  });
}

const interestsSchema = z.object({
  sectors: z.array(z.string().trim().min(2).max(120)).max(30).optional(),
  themes: z.array(z.string().trim().min(2).max(200)).max(30).optional(),
  companies: z.array(z.string().trim().min(1).max(120)).max(60).optional(),
  lens: z.enum(["investing", "growth"]).optional(),
});

/**
 * Replace this partner's own interests.
 *
 * A WHOLE-LIST WRITE rather than add/remove deltas. The interface offers adding and removing one
 * at a time, but sending the resulting list is what makes two edits in quick succession converge
 * instead of racing — and there is no case here where a partial update is what anybody wanted.
 *
 * Firm-floor entries are dropped rather than rejected: adding "venture capital" to a personal list
 * is harmless and meaningless, and refusing the whole save over it would be obnoxious.
 */
export async function handleSetInterests(ctx: RouteContext): Promise<Response> {
  const parsed = interestsSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "mp_home_preference.set", {
    objectType: "partner_intelligence_profile",
    objectId: actor.firmUserId!,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const current = await loadInterests(ctx.env, actor.firmUserId!);
  const clean = (list: string[] | undefined, fallback: string[], kind?: "sectors" | "themes"): string[] => {
    if (!list) return fallback;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const value = raw.trim();
      const key = normaliseInterest(value);
      if (!key || seen.has(key)) continue;
      if (kind && isFirmInterest(kind, value)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  };

  const next: PartnerInterests = {
    sectors: clean(parsed.data.sectors, current.sectors, "sectors"),
    themes: clean(parsed.data.themes, current.themes, "themes"),
    companies: clean(parsed.data.companies, current.companies),
  };

  const currentProfile = await loadProfile(ctx.env, actor.firmUserId!);
  const lens: LensKey = parsed.data.lens ?? (isLensKey(currentProfile.lens) ? currentProfile.lens : DEFAULT_LENS);
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO partner_intelligence_profile (firm_user_id, sectors_json, themes_json, companies_json, lens)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (firm_user_id) DO UPDATE SET
       sectors_json = excluded.sectors_json,
       themes_json = excluded.themes_json,
       companies_json = excluded.companies_json,
       lens = excluded.lens`,
  )
    .bind(actor.firmUserId!, JSON.stringify(next.sectors), JSON.stringify(next.themes), JSON.stringify(next.companies), lens)
    .run();

  await appendEvent(ctx.env, {
    eventType: "daily_intelligence.interests_changed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "partner_intelligence_profile",
    objectId: actor.firmUserId!,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    // Counts, not contents: what somebody chooses to read about is theirs.
    payload: { sectors: next.sectors.length, themes: next.themes.length, companies: next.companies.length, lens },
  });

  return json({ mine: next, lens: lensFor(lens), note: "Saved. Your next brief is written against these." }, { status: 201 });
}
