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
  SOURCE_AUTHORITY, classify, dedupe, localReportDate, rank,
  type NormalisedItem, type PartnerLens, type SourceType,
} from "../../shared/intelligence/pipeline";
import { readMarket, type MarketRead } from "./liveSearch";
import { fetchMacroReadings, type MacroFailure, type MacroReading } from "../effects/macroClient";
import { deliver } from "./deliverables";
import { machineForKey } from "./attribution";
import { chiefOfStaffFor } from "../../shared/work/chiefOfStaff";
import { CHAIN_BUDGET_MS } from "../ai/chainBudget";
import {
  STALLED_AFTER_MINUTES,
  briefRunState,
  type BriefExpectations,
  type BriefHistory,
  type BriefRunRow,
} from "../../shared/intelligence/briefRunState";
import { recentFeedbackFor } from "./deliverables";
import { z } from "zod";
import {
  MAX_BRIEF_ATTEMPTS,
  STRANDED_SQL,
  briefTerminality,
  strandedReason,
} from "../../shared/intelligence/briefTerminality";

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

/**
 * The output the write stage declares to the router. Measured from production (see the call site
 * in `defaultSynthesise`); exported so `validate:brief-lands` can hold it against the measured
 * floor rather than restating either number.
 */
export const BRIEF_EXPECTED_OUTPUT_TOKENS = 24_000;

/**
 * THE ONE MODEL THAT WRITES THE BRIEF — the owner's decision, 19 Sep 2026: "make them use Sonnet
 * … Sonnet for briefs only." Passed to the router as `requireModel`, which reduces the candidates
 * to lanes serving this model (OpenRouter, and Anthropic directly as the outage fallback) before
 * any ordering, assembles no free lane, and stops with a named reason if none serves it. Measured
 * cost on this model: $0.12–$0.30 a brief, mean $0.20 over 51 runs — and now only when she asks.
 * Every other lane in the firm keeps the free-first ladder untouched; `validate:brief-lands` names
 * this as the one caller allowed to pin.
 */
export const BRIEF_MODEL = "anthropic/claude-sonnet-5";

/**
 * How long a FAILED brief with attempts left waits before the clock tries again. Twenty minutes:
 * long enough for a provider blip to clear, short enough that three attempts fit in a morning.
 * Written onto the row as `retry_after` so the card can say "retrying at 07:05" as a fact.
 */
export const RETRY_AFTER_MINUTES = 20;



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
      firm_user_id: firmUserId, timezone: "America/Chicago", weekends: 1, enabled: 1,
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
export type Synthesise = (
  env: Env,
  actor: Actor,
  prompt: string,
  reportDate: string,
  firmUserId: string,
  /** The brief's own verifier, run inside the router's walk so a rejected reply hands on. */
  verify?: (text: string) => string | null,
) => Promise<SynthesisResult>;

const defaultSynthesise: Synthesise = async (env, actor, prompt, reportDate, firmUserId, verify) => {
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
    ...(verify ? { verify } : {}),
    // A brief assembled from public sources is PUBLIC. Never raised, so it cannot be blocked by a
    // policy meant for confidential material — and never lowered either.
    sensitivity: "PUBLIC" as never,
    /*
     * MEASURED, NOT DECLARED. Fifty-one accepted briefs written by claude-sonnet-5 between 20 Aug
     * and 17 Sep 2026 returned 8,669–27,536 output tokens: median 17,415, p90 22,969, mean 17,668.
     * The old declaration of 8,000 understated every one of them — the affordability check and the
     * cost centre reasoned about a brief a third the size of the one that was written. 24,000 sits
     * at the p90 with a margin and under the 32,768 wire ceiling; the deadline is no longer derived
     * from this number (chainBudget.ts sizes it on the ceiling at the slowest measured rate), so
     * correcting it moves the cost estimate and nothing else. $0.12–$0.30 a brief, mean $0.20.
     */
    budgetContext: {
      judgement: true,
      expectedOutputTokens: BRIEF_EXPECTED_OUTPUT_TOKENS,
      // Sonnet, and nothing else — see BRIEF_MODEL. FREE_ONLY stops it with a named reason.
      requireModel: BRIEF_MODEL,
    },
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

/** How long one of the cheap stages may hold the row: gather, or the market read. */
export const STAGE_LEASE_MINUTES = 10;

/**
 * How long the WRITE stage may hold the row. It is one model call and possibly one retry, each of
 * which may walk the whole provider chain — so the lease is two chain budgets plus the stage's own
 * parsing and persisting, derived from chainBudget.ts rather than typed here. With the ten-minute
 * lease a write whose first lane hung to its 450s deadline and whose retry then took the usual
 * three minutes would have been re-claimed by the next tick mid-write and paid for twice.
 */
export const WRITE_LEASE_MINUTES = Math.ceil((2 * CHAIN_BUDGET_MS) / 60_000) + 4;

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

/**
 * ONE CLOCK. `stage_at` is what the closers compare against the caller's `now` to decide whether a
 * row has stopped moving, so it is written FROM that clock rather than from SQLite's — two clocks
 * agree in production and disagree under any test that moves time, which is how a requested brief
 * was swept as "abandoned" one second after it was opened.
 */
async function stamp(env: Env, id: string, status: string, now: Date, extra: Record<string, string | number | null> = {}): Promise<void> {
  const sets = ["status = ?2", "stage_at = ?3", "stage_lease_until = NULL"];
  const binds: (string | number | null)[] = [id, status, now.toISOString()];
  for (const [k, v] of Object.entries(extra)) {
    binds.push(v);
    sets.push(`${k} = ?${binds.length}`);
  }
  await env.WP_OS_DB.prepare(`UPDATE intelligence_report SET ${sets.join(", ")} WHERE id = ?1`).bind(...binds).run();
}

/**
 * When the clock may try a failed brief again, from the caller's clock — the same one the tick
 * compares `retry_after` against. SQLite's 'now' is a different clock (real wall time under a
 * test's fake one), and mixing the two is how a retry becomes "never" without anything saying so.
 */
export function retryAfterIso(now: Date): string {
  return new Date(now.getTime() + RETRY_AFTER_MINUTES * 60_000).toISOString();
}

/**
 * The SQL that keeps `retry_after` only while attempts remain. NULL when the budget is spent — the
 * card then says "nothing more is tried today" as a fact. `?R` is bound by the caller to
 * `retryAfterIso(now)`.
 */
const RETRY_AFTER_CASE = (param: string) => `CASE WHEN attempts < ${MAX_BRIEF_ATTEMPTS} THEN ${param} ELSE NULL END`;

async function failReport(env: Env, id: string, code: string, message: string, runId: string | null, now: Date = new Date()): Promise<GenerateResult> {
  await env.WP_OS_DB.prepare(
    `UPDATE intelligence_report SET status = 'FAILED', error_code = ?2, error_message = ?3, ai_run_id = ?4, stage_lease_until = NULL,
            stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            retry_after = ${RETRY_AFTER_CASE("?5")}
      WHERE id = ?1`,
  )
    .bind(id, code, message.slice(0, 600), runId, retryAfterIso(now))
    .run();
  return { report_id: id, status: "FAILED", sections: 0, candidates: 0, flags: 0 };
}

/**
 * Open (or re-open) today's report row for a partner, counting the attempt on the way in.
 *
 * Idempotent on (firm_scope, firm_user_id, report_date): a second call the same day resets the same
 * row to GATHERING rather than creating a second report.
 */
export async function startReport(
  env: Env,
  firmScope: string,
  firmUserId: string,
  now: Date,
  /*
   * A HUMAN PRESSING THE BUTTON GETS A FRESH BUDGET, and the cron does not.
   *
   * Without this, "Rebuild today's brief" on a row that had already spent its three attempts left
   * it at FOUR — past the cap — so if the rebuild also failed, nothing would ever retry it
   * automatically and her only remaining option was to keep pressing. The owner's requirement is
   * that it "should self heal and keep trying"; a manual rebuild is her saying try again today, so
   * the day's budget starts over and the cron can carry on from there. The cap itself is unchanged
   * at three, which is the number she asked for.
   */
  trigger: "scheduled" | "requested" = "scheduled",
  /** Who pressed the button, when `trigger` is "requested". Recorded on the row, shown on the card. */
  requestedBy: string | null = null,
): Promise<{ id: string; reportDate: string }> {
  const profile = await loadProfile(env, firmUserId);
  const reportDate = localReportDate(now, profile.timezone);
  const reportId = `dir_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO intelligence_report (id, firm_user_id, report_date, status, prompt_version, firm_scope, started_at, stage_at, requested_at, requested_by)
     VALUES (?1, ?2, ?3, 'GATHERING', ?4, ?5, ?8, ?8,
             CASE WHEN ?6 = 'requested' THEN ?8 ELSE NULL END,
             CASE WHEN ?6 = 'requested' THEN ?7 ELSE NULL END)
     ON CONFLICT (firm_scope, firm_user_id, report_date)
       DO UPDATE SET status = 'GATHERING', started_at = ?8,
                     stage_at = ?8, stage_lease_until = NULL,
                     candidates_json = NULL, market_json = NULL, completed_at = NULL, retry_after = NULL,
                     -- THE REQUEST IS A FACT ON THE ROW. The card reads it back as "requested by you
                     -- at 09:29"; a scheduled restart leaves whatever was there.
                     requested_at = CASE WHEN ?6 = 'requested' THEN ?8 ELSE intelligence_report.requested_at END,
                     requested_by = CASE WHEN ?6 = 'requested' THEN ?7 ELSE intelligence_report.requested_by END,
                     error_code = NULL, error_message = NULL, prompt_version = excluded.prompt_version,
                     -- Counted on the way IN, so a run that dies mid-flight still spends its
                     -- attempt. Counting on success would let a crash loop retry for ever.
                     -- A REQUESTED rebuild starts the day's budget over rather than adding to it;
                     -- see the trigger parameter on this function.
                     attempts = CASE WHEN ?6 = 'requested' THEN 1 ELSE intelligence_report.attempts + 1 END`,
  )
    .bind(reportId, firmUserId, reportDate, PROMPT_VERSION, firmScope, trigger, requestedBy, now.toISOString())
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
  await stamp(env, row.id, "RANKING", now, {
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
  await stamp(env, row.id, "GENERATING", now, { market_json: JSON.stringify(stored) });
  return "GENERATING";
}

/** Stage 3 — write, verify, persist. One model call (two if the first reply cannot be used). */
async function stageWrite(env: Env, actor: Actor, row: ReportRow, firmScope: string, deps: BriefDeps, now: Date): Promise<GenerateResult> {
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
  if (events.length === 0) return await failReport(env, row.id, "no_candidates", "the ranked candidates were lost between ticks; build it again", null, now);

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

  /*
   * THE VERIFIER RUNS INSIDE THE ROUTER'S WALK (19 Sep 2026). `check` is handed to the synthesiser
   * as `verify`, so a lane whose reply is unparseable, missing a section or citing nothing is a
   * FAILED attempt on the routing record and the chain moves to the next rung — instead of this
   * stage asking the same lane again, which is what six calls to one lane on 18 Sep amounted to.
   * The brief is pinned to one model, so for it "the next rung" is the same model at its own vendor
   * or nothing; the mechanism is general and every other verified caller gets the walk for free.
   */
  const check = (raw: string) => {
    const parsed = parseReport(raw);
    if (!parsed) return { parsed: null, problems: [{ section: "*", problem: "missing_section" as const, detail: "the reply was not in the ===SECTION format" }] };
    const sections = resolveEventIds(parsed, packet);
    return { parsed: sections, problems: verifyBrief(sections, sources, { watchlistEmpty: watchlist.length === 0 }) };
  };
  const verify = (text: string): string | null => {
    const c = check(text);
    return c.parsed && c.problems.length === 0 ? null : c.problems.map((p) => p.detail).join("; ");
  };
  const rejectionOf = (failure: string | undefined): string | null => {
    if (!failure) return null;
    const m = /verifier_rejected:([\s\S]*)$/.exec(failure);
    return m ? m[1]!.trim() : null;
  };

  let aiRunId: string | null = null;
  let model: string | null = null;
  let output = "";
  let rejected: string | null = null;
  try {
    const result = await synthesise(env, actor, `${feedback}${buildSynthesisPrompt(packet)}`, row.report_date, row.firm_user_id, verify);
    aiRunId = result.aiRunId;
    model = result.model;
    rejected = rejectionOf(result.failure);
    if (result.failure && rejected === null) return await failReport(env, row.id, "synthesis_failed", result.failure, aiRunId, now);
    output = result.output;
  } catch (err) {
    return await failReport(env, row.id, "synthesis_error", err instanceof Error ? err.message : String(err), aiRunId, now);
  }

  /*
   * ONE RETRY WHEN THE REPLY CANNOT BE USED — unparseable, or missing a section, or citing a source
   * that does not exist — whether the router reported the rejection or this stage found it. The
   * second attempt is told exactly what was wrong. One, not a loop: a model that cannot produce
   * the shape twice will not on the third try, and every attempt pays.
   */
  let { parsed, problems } = rejected !== null
    ? { parsed: null, problems: [{ section: "*", problem: "missing_section" as const, detail: rejected }] }
    : check(output);
  if (!parsed || problems.length > 0) {
    const why = problems.map((p) => p.detail).join("; ");
    const retry = await synthesise(
      env, actor,
      `${feedback}${buildSynthesisPrompt(packet)}\n\nYOUR PREVIOUS REPLY WAS REJECTED: ${why}. Every required section must be present with substance, every section must cite at least one [n] from the SOURCES list, and no [n] may exceed ${sources.length}. Return the whole report again in the ===SECTION format.`,
      row.report_date, row.firm_user_id, verify,
    );
    if (retry.aiRunId) aiRunId = retry.aiRunId;
    if (retry.model) model = retry.model;
    const retryRejected = rejectionOf(retry.failure);
    if (retryRejected !== null) ({ parsed, problems } = { parsed: null, problems: [{ section: "*", problem: "missing_section" as const, detail: retryRejected }] });
    else if (!retry.failure && retry.output) ({ parsed, problems } = check(retry.output));
    else if (retry.failure) return await failReport(env, row.id, "synthesis_failed", retry.failure, aiRunId, now);
  }
  if (!parsed && problems.length > 0 && problems[0]!.detail !== "the reply was not in the ===SECTION format") {
    return await failReport(env, row.id, "incomplete", `the brief was rejected twice: ${problems.map((p) => p.detail).join("; ")}`, aiRunId, now);
  }
  if (!parsed) return await failReport(env, row.id, "unparseable", "the model did not return a usable report, twice", aiRunId, now);
  if (problems.length > 0) {
    // NEVER DELIVERED THIN. A brief missing a section, or citing a source that does not exist,
    // is failed with the reason rather than shown with holes.
    return await failReport(env, row.id, "incomplete", `the brief was rejected twice: ${problems.map((p) => p.detail).join("; ")}`, aiRunId, now);
  }
  const sections = parsed;

  await stamp(env, row.id, "VERIFYING", now);
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
  const writeLease = new Date(now.getTime() + WRITE_LEASE_MINUTES * 60_000).toISOString();
  const claimed = await env.WP_OS_DB.prepare(
    `UPDATE intelligence_report
        SET stage_lease_until = CASE WHEN status IN ('GENERATING', 'VERIFYING') THEN ?6 ELSE ?4 END
      WHERE firm_scope = ?1 AND firm_user_id = ?2 AND report_date = ?3
        AND status NOT IN ('READY', 'FAILED')
        AND (stage_lease_until IS NULL OR stage_lease_until < ?5)`,
  ).bind(firmScope, firmUserId, reportDate, lease, now.toISOString(), writeLease).run();
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
    const out = await stageWrite(env, actor, row, firmScope, deps, now);
    return { report_id: row.id, status: out.status, stage: out.status === "READY" ? "written" : "failed" };
  } catch (err) {
    // A throw at any stage closes the row with the real error rather than leaving it mid-flight.
    const message = err instanceof Error ? err.message : String(err);
    await failReport(env, row.id, "generation_threw", message, row.ai_run_id, now).catch(() => undefined);
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
  return await failReport(env, id, "stalled", "the brief did not reach READY in one run; the row is left for the clock", null, now);
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
 * How many times a partner's brief may be attempted on one date.
 *
 * MOVED to `shared/intelligence/briefTerminality.ts` and re-exported here so existing importers are
 * unchanged.
 */
export { MAX_BRIEF_ATTEMPTS };

/*
 * THE SCHEDULED BRIEF IS RETIRED (19 Sep 2026), by the owner's decision: "Make the briefs on demand
 * and make them use Sonnet — that is the new solution. On demand + Sonnet for briefs only. On demand
 * any day of the week!" The every-partner-every-morning path — gated by earliest start
 * and weekends — is gone with it; migration 0211 records the retirement as a RETIRED scheduled_job
 * row so the Jobs page says so and no seed can re-open it. Nothing below starts a brief on its own:
 * the clock only ADVANCES a brief a person asked for. The profile's `weekends` and
 * `earliest_start_local` columns have no bearing on a brief any more; they are kept because rows
 * exist and other readers may still describe them.
 */

interface PartnerClock {
  id: string;
  timezone: string;
}

/** The managing partners and the zone each reads the day in — which decides `report_date`. */
async function partnerClocks(env: Env): Promise<PartnerClock[]> {
  return (
    (
      await env.WP_OS_DB.prepare(
        `SELECT u.id, COALESCE(p.timezone,'America/Chicago') AS timezone
           FROM firm_user u
           LEFT JOIN partner_intelligence_profile p ON p.firm_user_id = u.id
           JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
          WHERE u.status = 'ACTIVE' ORDER BY u.id`,
      ).all<PartnerClock>()
    ).results ?? []
  );
}

/**
 * ONE STAGE OF ONE PARTNER'S REQUESTED BRIEF — the unit of work.
 *
 * Production, 15 Sep 2026: seven ticks in a row died building Sequoia's brief before the model was
 * called — gather → dedupe → rank over 462 items on a 10 ms budget. A brief is three stages:
 * gathered, market read, written. `serveBrief` walks them inside one invocation now that the
 * account is on the Paid plan; this function is still the unit so a stage that dies leaves the row
 * saying which one.
 *
 * ── WHO GETS ADVANCED (19 Sep 2026, on demand only) ─────────────────────────────────────────────
 *
 *   1. A row that is MOVING (any non-terminal status) is advanced — whatever the day, whatever the
 *      hour. Every such row was opened by a person's press; nothing else opens one.
 *   2. A row that is FAILED with attempts left is restarted once `retry_after` has passed — three
 *      attempts for one press, then it says so and waits for her.
 *   3. Nothing is ever STARTED here. There is no owed brief; there is only a requested one.
 *
 * Terminal rows (READY, or FAILED with the attempts spent) are skipped — one definition of
 * terminal, `briefTerminality`, shared with the closers.
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
  await closeUnfinishableReports(env, now).catch(async (err) => {
    await recordSwallowed(env, "dailyIntelligence.closeUnfinishableReports", err);
    return 0;
  });
  const partners = await partnerClocks(env);
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT firm_user_id, report_date, status, attempts, stage_lease_until, retry_after, requested_at FROM intelligence_report
        WHERE firm_scope = ?1 AND report_date >= ?2 AND requested_at IS NOT NULL`,
    ).bind(firmScope, new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)).all<{ firm_user_id: string; report_date: string; status: string; attempts: number; stage_lease_until: string | null; retry_after: string | null; requested_at: string | null }>()
  ).results ?? [];
  const byKey = new Map(rows.map((r) => [`${r.firm_user_id}:${r.report_date}`, r]));
  const nowIso = now.toISOString();

  // The earliest request first: a person has been waiting longest on it.
  const ordered = [...partners].sort((a, b) => {
    const ra = byKey.get(`${a.id}:${localReportDate(now, a.timezone)}`)?.requested_at ?? "~";
    const rb = byKey.get(`${b.id}:${localReportDate(now, b.timezone)}`)?.requested_at ?? "~";
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  for (const p of ordered) {
    const date = localReportDate(now, p.timezone);
    const row = byKey.get(`${p.id}:${date}`);
    if (!row) continue;
    if (briefTerminality(row.status, row.attempts).terminal) continue;
    if (row.status !== "FAILED") {
      // Moving. Advance it unless another invocation holds the stage.
      if (row.stage_lease_until && row.stage_lease_until > nowIso) continue;
    } else {
      // FAILED with attempts left: the same press is tried again once its retry time has passed.
      if (row.retry_after && row.retry_after > nowIso) continue;
      await startReport(env, firmScope, p.id, now);
    }
    const step = await advanceBrief(env, actor, p.id, now, deps);
    if (step.status === "READY" && step.report_id) {
      await deliverReport(env, step.report_id).catch(async (err) => {
        await env.WP_OS_DB.prepare(
          `INSERT INTO intelligence_delivery (id, report_id, channel, status, detail) VALUES (?1, ?2, 'IN_APP', 'FAILED', ?3)`,
        ).bind(`did_${crypto.randomUUID()}`, step.report_id, String(err).slice(0, 400)).run();
      });
    }
    if (step.stage === "failed" && step.report_id) await noticeOfFailure(env, step.report_id, p, now);
    const detail =
      step.stage === "gathered" ? (step.status === "READY" ? "nothing reached the bar; an empty-day brief was written" : "gathered and ranked; next it reads the numbers")
      : step.stage === "market_read" ? "the numbers were fetched and read; next it writes the brief"
      : step.stage === "written" ? "written, verified and delivered"
      : step.stage === "failed" ? "failed — the brief's own row says why"
      : "another tick holds it";
    return { partner: p.id, report_id: step.report_id, stage: step.stage, status: step.status, detail };
  }
  return { partner: null, report_id: null, stage: "none", status: "NONE", detail: "no brief has been requested" };
}

/**
 * A BRIEF THAT FAILED SAYS SO WHERE SHE READS — a notification, addressed to her, with the reason
 * and what happens next. Two dedupe keys per day: the first failure ("retrying at 07:05") and the
 * last ("nothing more today"), so she hears each fact once and neither drowns the other.
 */
async function noticeOfFailure(env: Env, reportId: string, p: PartnerClock, _now: Date): Promise<void> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT firm_user_id, report_date, attempts, error_message, retry_after, firm_scope FROM intelligence_report WHERE id = ?1",
  ).bind(reportId).first<{ firm_user_id: string; report_date: string; attempts: number; error_message: string | null; retry_after: string | null; firm_scope: string }>();
  if (!row) return;
  const terminal = briefTerminality("FAILED", row.attempts).terminal;
  const why = (row.error_message ?? "").trim() || "the run did not record why";
  const clock = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: p.timezone }); } catch { return new Date(iso).toISOString(); }
  };
  const next = terminal
    ? `Nothing more is tried automatically. Press "Try again now" on Home to build it now.`
    : row.retry_after ? `The clock tries again at ${clock(row.retry_after)}.` : "The clock tries again on its next tick.";
  await notifyQuietly(env, {
    firmUserId: row.firm_user_id,
    kind: "INTELLIGENCE_BRIEF",
    severity: terminal ? "WARNING" : "INFO",
    dedupeKey: `daily_intelligence_failed:${row.firm_user_id}:${row.report_date}:${terminal ? "final" : "retrying"}`,
    title: terminal ? `No brief today (${row.report_date})` : `Your ${row.report_date} brief is being retried`,
    body: `Attempt ${row.attempts} of ${MAX_BRIEF_ATTEMPTS} failed: ${why} ${next}`.slice(0, 600),
    objectType: "intelligence_report",
    objectId: reportId,
    firmScope: row.firm_scope,
  });
}

/**
 * SERVE A REQUESTED BRIEF ON EVERY TICK (19 Sep 2026).
 *
 * The button used to run the write stage's model call inside her HTTP request, and died with it.
 * Now the press is a fact on the row and the tick — every minute, fifteen minutes of wall time on
 * the Paid plan — walks every ready stage inside one invocation before it looks at any job: a
 * press is picked up within a minute and the brief is READY about four minutes later (gather ~2s,
 * market ~10s, write 98–281s measured on Sonnet). When nothing has been requested this does one
 * indexed read and writes nothing — the tick reports `_morning_brief` only when it did something.
 *
 * `limit` bounds the loop: four stages is a whole brief with a stage to spare, per partner.
 */
export async function serveBrief(
  env: Env,
  now: Date,
  deps: BriefDeps = {},
  firmScope = "west-peek",
): Promise<{ served: boolean; partner: string | null; report_id: string | null; status: string; steps: string[]; summary: string }> {
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: [firmScope] };
  const steps: string[] = [];
  let partner: string | null = null;
  let reportId: string | null = null;
  let status = "NONE";
  for (let i = 0; i < 4; i++) {
    const step = await runBriefTick(env, actor, now, deps);
    if (step.stage === "none") break;
    partner = step.partner;
    reportId = step.report_id ?? reportId;
    status = step.status;
    steps.push(step.stage);
    if (step.stage === "busy" || step.stage === "failed" || step.stage === "written" || step.status === "READY" || step.status === "FAILED") break;
  }
  if (steps.length === 0) return { served: false, partner: null, report_id: null, status, steps, summary: "no brief has been requested" };
  return {
    served: true, partner, report_id: reportId, status, steps,
    summary: `Morning brief for ${partner}: ${steps.join(" → ")} — now ${status}.`,
  };
}

/**
 * WHAT A BUILD USUALLY TAKES, measured from this firm's own completed runs rather than typed in.
 *
 * The figure is the write stage's model call (`ai_run` created → completed) over the last thirty
 * completed briefs, plus the measured overhead of the two cheap stages and one tick of waiting.
 * The write call is the honest unit: whole-row durations from 15–17 Sep read 31–36 minutes only
 * because a stage then waited a quarter of an hour for the next job run, which is the very thing
 * this change removes. Production to 17 Sep: 98–281s, median 189s, p90 238s.
 */
export const PRE_WRITE_OVERHEAD_SECONDS = 75;
export const FALLBACK_EXPECTATIONS: BriefExpectations = { usualSeconds: 189 + PRE_WRITE_OVERHEAD_SECONDS, slowSeconds: 238 + PRE_WRITE_OVERHEAD_SECONDS, measuredFrom: 0 };

export async function measuredExpectations(env: Env): Promise<BriefExpectations> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT (julianday(completed_at) - julianday(created_at)) * 86400 AS secs
         FROM ai_run
        WHERE purpose LIKE 'daily intelligence report%' AND status = 'COMPLETED' AND completed_at IS NOT NULL
          AND output_text IS NOT NULL AND length(output_text) > 4000
        ORDER BY completed_at DESC LIMIT 30`,
    ).all<{ secs: number }>().catch(() => ({ results: [] as Array<{ secs: number }> }))
  ).results ?? [];
  const secs = rows.map((r) => Number(r.secs)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (secs.length < 3) return FALLBACK_EXPECTATIONS;
  const at = (q: number) => secs[Math.min(secs.length - 1, Math.floor(q * secs.length))]!;
  return {
    usualSeconds: Math.round(at(0.5)) + PRE_WRITE_OVERHEAD_SECONDS,
    slowSeconds: Math.round(at(0.9)) + PRE_WRITE_OVERHEAD_SECONDS,
    measuredFrom: secs.length,
  };
}

/** Today's row for a partner, with the section count, as the state function wants it. */
async function todaysRow(env: Env, firmScope: string, firmUserId: string, date: string): Promise<BriefRunRow | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT r.id, r.status, r.report_date, r.attempts, r.started_at, r.stage_at, r.stage_lease_until, r.completed_at,
            r.requested_at, r.requested_by, r.retry_after, r.error_code, r.error_message,
            (SELECT COUNT(*) FROM intelligence_report_section s WHERE s.report_id = r.id AND s.section_key != 'citations') AS section_count
       FROM intelligence_report r WHERE r.firm_scope = ?1 AND r.firm_user_id = ?2 AND r.report_date = ?3`,
  ).bind(firmScope, firmUserId, date).first<BriefRunRow & { id: string }>();
  return row ?? null;
}

/** The last brief that actually arrived for this partner — the fact an idle morning carries. */
async function historyFor(env: Env, firmScope: string, firmUserId: string): Promise<BriefHistory> {
  const last = await env.WP_OS_DB.prepare(
    `SELECT r.completed_at, r.report_date, r.requested_by FROM intelligence_report r
      WHERE r.firm_scope = ?1 AND r.firm_user_id = ?2 AND r.status = 'READY'
        AND EXISTS (SELECT 1 FROM intelligence_report_section s WHERE s.report_id = r.id AND s.section_key != 'citations')
      ORDER BY r.completed_at DESC LIMIT 1`,
  ).bind(firmScope, firmUserId).first<{ completed_at: string | null; report_date: string; requested_by: string | null }>();
  return { lastArrivedAt: last?.completed_at ?? null, lastReportDate: last?.report_date ?? null, lastRequestedBy: last?.requested_by ?? null };
}

async function timezoneFor(env: Env, firmUserId: string): Promise<string> {
  return (await partnerClocks(env)).find((x) => x.id === firmUserId)?.timezone ?? "America/Chicago";
}

/** The named state of a partner's brief today — what the status route returns and the band renders. */
export async function briefStateFor(env: Env, firmScope: string, firmUserId: string, now: Date) {
  const timezone = await timezoneFor(env, firmUserId);
  const date = localReportDate(now, timezone);
  const [row, expectations, history] = await Promise.all([
    todaysRow(env, firmScope, firmUserId, date), measuredExpectations(env), historyFor(env, firmScope, firmUserId),
  ]);
  const state = briefRunState(row, history, expectations, now, timezone);
  return { date, row, state, expectations, history, timezone };
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
export const STALE_AFTER_MINUTES = STALLED_AFTER_MINUTES;

export async function closeAbandonedReports(env: Env, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MINUTES * 60_000).toISOString();
  // Judged by the last MOVEMENT (stage_at), not the start: a brief now crosses several ticks and a
  // row that gathered twenty minutes ago and read the market five minutes ago is alive.
  /*
   * A REQUEST WAITING ITS TURN IS NOT ABANDONED (19 Sep 2026). A row a partner just pressed for sits
   * at GATHERING with no lease until the tick reaches it — and the tick serves one partner's whole
   * brief at a time, so the second press of a morning can wait a few minutes behind the first.
   * Only a row that has MOVED (past GATHERING) or was CLAIMED (held a lease) and then stopped is
   * abandoned; a never-claimed request is queued, and the card says so.
   */
  const res = await env.WP_OS_DB.prepare(
    `UPDATE intelligence_report
        SET status = 'FAILED', error_code = 'abandoned',
            error_message = 'The run stopped part-way through and never finished.',
            stage_lease_until = NULL,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            retry_after = ${RETRY_AFTER_CASE("?2")}
      WHERE status NOT IN ('READY','FAILED') AND COALESCE(stage_at, started_at) < ?1
        AND (status <> 'GATHERING' OR stage_lease_until IS NOT NULL)`,
  )
    .bind(cutoff, retryAfterIso(now))
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * Close reports that are holding a spent attempt budget in a non-terminal status.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A WIDER `closeAbandonedReports`. The two close different
 * things for different reasons and must say different things to the partner. A row that stopped
 * moving with attempts still on the clock is `abandoned` — it will be started again and probably
 * succeed. A row that stopped moving with the budget gone is the END of the day's attempts, and
 * telling her "build it again" without saying nothing further will be tried automatically is the
 * difference between a card she can act on and one she has to interpret.
 *
 * WHAT IT IS FOR, precisely. On 18 Sep 2026 Sequoia's write stage made both its model calls at
 * 14:56 and 14:57 and the row's `stage_at` never moved from 14:41:47: the isolate was evicted
 * between the model returning and the outcome being persisted. `advanceBrief`'s catch cannot help,
 * because no code of ours ran at all. Her partner's row, whose stage did complete, ended FAILED
 * with a reason a person could read; hers ended with nothing, and the asymmetry was the bug.
 *
 * THE GRACE WINDOW IS NOT OPTIONAL. A healthy third attempt sits between stages holding no lease —
 * the pipeline is three ticks — so closing every non-terminal row with a spent budget would kill
 * runs that were about to write the brief. A row qualifies only once it is also holding no stage
 * lease and has not moved for longer than a whole stage's lease. The tick runs every minute, so a
 * live run moves long before that; a dead one never moves again.
 */
export async function closeUnfinishableReports(env: Env, now: Date = new Date()): Promise<number> {
  const graceCutoff = new Date(now.getTime() - STAGE_LEASE_MINUTES * 60_000).toISOString();
  const res = await env.WP_OS_DB.prepare(
    `UPDATE intelligence_report
        SET status = 'FAILED', error_code = 'unfinishable',
            error_message = ?3,
            -- The budget is spent by definition of "stranded": no retry time is a fact, stated.
            retry_after = NULL,
            stage_lease_until = NULL,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE ${STRANDED_SQL}`,
  )
    .bind(now.toISOString(), graceCutoff, strandedReason(MAX_BRIEF_ATTEMPTS))
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
     * WHY THERE IS NO BRIEF, not merely that there is none — and since 19 Sep 2026 the answer is
     * the same on every day: nobody has asked for one yet today. There is no schedule to explain,
     * no weekend switch, no earliest hour. The one fact worth adding is when the last one arrived,
     * which the status route carries in full; this line stays short and true for the callers that
     * only read this route.
     */
    const { state } = await briefStateFor(ctx.env, actor.firmScopes[0] ?? "west-peek", firmUserId, new Date());
    return json({ report: null, sections: [], date, no_brief_because: state.line });
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
 * POST /api/daily-intelligence/generate — ASK for today's brief. The clock builds it.
 *
 * WHAT THIS USED TO DO, AND WHY IT COULD NOT WORK (19 Sep 2026). It advanced the brief one stage
 * per request and the page called it again until done — which put the write stage's model call
 * inside an HTTP request. Her press at 13:29:30Z opened that call at 13:29:37Z; the request was
 * cut, no code of ours ran afterwards, and the `ai_run` was still RUNNING at 13:45 with the row
 * at GENERATING holding a lease. Her second press met the lease and was told "Another run holds
 * it". A model call that takes 98–281 seconds (measured) does not belong inside a request.
 *
 * NOW: the press is recorded on the row (`requested_at`, `requested_by`), the row is (re)opened
 * from the top with a fresh attempt budget, and the tick — every minute — walks every stage
 * inside one invocation with fifteen minutes of wall time. This returns at once with the named
 * state, and the page polls `/status` until the state is terminal.
 *
 * A SECOND PRESS WHILE IT IS MOVING DOES NOTHING and says so: `already: true` with the state,
 * which carries "started 1m 20s ago". The row decides, never the client.
 *
 * `for_firm_user_id` builds another partner's brief — Managing Partner to Managing Partner only.
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

  try {
    const now = new Date();
    const firmScope = actor.firmScopes[0] ?? "west-peek";
    const before = await briefStateFor(ctx.env, firmScope, target, now);
    if (!before.state.button.enabled) {
      // Moving under a live lease, or freshly requested. Nothing is started twice.
      return json({ already: true, ...before.state, date: before.date, report_id: (before.row as { id?: string } | null)?.id ?? null }, { status: 200 });
    }
    await startReport(ctx.env, firmScope, target, now, "requested", actor.firmUserId ?? null);
    await appendEvent(ctx.env, {
      eventType: "daily_intelligence.requested",
      actorType: "firm_user", actorId: actor.firmUserId ?? "unknown",
      objectType: "intelligence_report", objectId: target, firmScope,
      payload: { for: target, report_date: before.date },
    });
    const after = await briefStateFor(ctx.env, firmScope, target, now);
    return json({ already: false, ...after.state, date: after.date, report_id: (after.row as { id?: string } | null)?.id ?? null }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * GET /api/daily-intelligence/status — the named state of today's brief, for the band to poll.
 * Cheap: one row, one profile read, one measured-durations read. Never infers from silence.
 */
export async function handleBriefStatus(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const { date, row, state, expectations, history } = await briefStateFor(ctx.env, firmScope, actor.firmUserId!, new Date());
  return json({
    date,
    ...state,
    report_id: (row as { id?: string } | null)?.id ?? null,
    status: row?.status ?? null,
    attempts: row?.attempts ?? 0,
    requested_at: row?.requested_at ?? null,
    requested_by: row?.requested_by ?? null,
    started_at: row?.started_at ?? null,
    completed_at: row?.completed_at ?? null,
    expectations,
    history,
  });
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
