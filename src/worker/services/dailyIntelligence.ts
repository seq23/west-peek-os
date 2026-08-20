import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { notifyQuietly } from "./notifications";
import {
  EMPTY_INTERESTS, INTEREST_SUGGESTIONS, FIRM_INTERESTS, effectiveInterests, isFirmInterest,
  normaliseInterest, type PartnerInterests,
} from "../../shared/intelligence/interests";
import {
  PROMPT_VERSION, REPORT_SECTIONS, buildSynthesisPrompt, parseReport, resolveEventIds, verifyReport,
  type EvidenceEvent, type EvidencePacket,
} from "../../shared/intelligence/reportSchema";
import {
  SOURCE_AUTHORITY, classify, dedupe, isWeekend, localReportDate, rank,
  type NormalisedItem, type PartnerLens, type SourceType,
} from "../../shared/intelligence/pipeline";
import { readMarket } from "./liveSearch";
import { deliver } from "./deliverables";
import { chiefOfStaffFor } from "../../shared/work/chiefOfStaff";
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
      sectors_json: "[]", companies_json: "[]", themes_json: "[]", depth_json: "{}",
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
  const rows = await env.WP_OS_DB.prepare(
    `SELECT i.id, i.title, i.body, i.url, i.published_at, i.category, i.created_at,
            s.kind AS source_kind, s.name AS source_name
       FROM intelligence_item i
       LEFT JOIN intelligence_source s ON s.id = i.source_id
      WHERE i.archived = 0 AND i.firm_scope = ?1
        AND COALESCE(i.published_at, i.created_at) >= ?2
      ORDER BY COALESCE(i.published_at, i.created_at) DESC
      LIMIT 500`,
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

async function setStatus(env: Env, reportId: string, status: string): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE intelligence_report SET status = ?2 WHERE id = ?1").bind(reportId, status).run();
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
  const { run } = await runAi(env, {
    purpose: `daily intelligence report ${reportDate} for ${firmUserId}`,
    actor,
    inputs: [prompt],
    // A brief assembled from public sources is PUBLIC. Never raised, so it cannot be blocked by a
    // policy meant for confidential material — and never lowered either.
    sensitivity: "PUBLIC" as never,
    // v3 asks for a report several times longer than v2's, so the estimate has to say so. This
    // number is what the affordability check and the cost centre reason about; leaving it at the
    // old 2000 would have understated every brief by a factor of four.
    budgetContext: { expectedOutputTokens: 8000 },
    // NAMING A TASK CLASS IS WHAT MAKES A ROUTING POLICY POSSIBLE. Without it the router falls back
    // to "cheapest adequate priced model", which chose a flash-tier model and produced a report
    // containing "the 30-year U.S. tax at 19 year high" and a corrupted copy of its own event ids.
    // Structure was never the whole problem: choosing what belongs at the top of a brief is a
    // judgement task, and judgement is the thing the cheap tier does not have.
    routing: { category: "INTELLIGENCE", taskClass: "daily-intelligence" },
  });
  return {
    output: run.output_text ?? "",
    aiRunId: run.id,
    model: (run as unknown as { model?: string }).model ?? null,
    failure: run.status === "COMPLETED" && run.output_text ? undefined : (run.failure_reason ?? `run ${run.status}`),
  };
};

export async function generateForPartner(
  env: Env,
  actor: Actor,
  firmUserId: string,
  now: Date,
  synthesise: Synthesise = defaultSynthesise,
): Promise<GenerateResult> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const profile = await loadProfile(env, firmUserId);
  const reportDate = localReportDate(now, profile.timezone);

  const user = await env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1")
    .bind(firmUserId)
    .first<{ full_name: string }>();

  const reportId = `dir_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO intelligence_report (id, firm_user_id, report_date, status, prompt_version, firm_scope)
     VALUES (?1, ?2, ?3, 'GATHERING', ?4, ?5)
     ON CONFLICT (firm_scope, firm_user_id, report_date)
       DO UPDATE SET status = 'GATHERING', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     error_code = NULL, error_message = NULL, prompt_version = excluded.prompt_version`,
  )
    .bind(reportId, firmUserId, reportDate, PROMPT_VERSION, firmScope)
    .run();

  const report = (await env.WP_OS_DB.prepare(
    "SELECT id FROM intelligence_report WHERE firm_scope = ?1 AND firm_user_id = ?2 AND report_date = ?3",
  )
    .bind(firmScope, firmUserId, reportDate)
    .first<{ id: string }>())!;
  const id = report.id;

  // The run id is captured by the synthesis step below and read here, so a FAILED report points at
  // the run that actually failed. It used to be written only on success, which left the row
  // carrying the id of whatever ran LAST TIME — so investigating a failure led straight to a
  // healthy older run and its perfectly good output. That cost an hour once; it should cost nobody
  // an hour again.
  let failedRunId: string | null = null;
  const fail = async (code: string, message: string): Promise<GenerateResult> => {
    await env.WP_OS_DB.prepare(
      "UPDATE intelligence_report SET status = 'FAILED', error_code = ?2, error_message = ?3, ai_run_id = ?4, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    )
      .bind(id, code, message, failedRunId)
      .run();
    return { report_id: id, status: "FAILED", sections: 0, candidates: 0, flags: 0 };
  };

  // ── Gather: the last 48 hours, so a Monday still sees the weekend. ──
  const since = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const raw = await gather(env, firmScope, since);

  // ── Dedupe and rank: arithmetic, no model. ──
  await setStatus(env, id, "RANKING");
  const { events: deduped, supporting } = dedupe(raw);
  const lens = lensFrom(profile);
  const entities = await firmEntities(env, firmScope);
  const candidates = rank(deduped.map((item) => ({ item, lens, firmEntities: entities, now })), { max: MAX_CANDIDATES });

  await env.WP_OS_DB.prepare(
    "UPDATE intelligence_report SET raw_count = ?2, deduped_count = ?3, candidate_count = ?4 WHERE id = ?1",
  )
    .bind(id, raw.length, deduped.length, candidates.length)
    .run();

  if (candidates.length === 0) {
    // An empty day is a real outcome, not a failure. Say so and stop — a padded report is worse.
    await env.WP_OS_DB.prepare("DELETE FROM intelligence_report_section WHERE report_id = ?1").bind(id).run();
    await env.WP_OS_DB.prepare(
      `INSERT INTO intelligence_report_section (id, report_id, section_key, position, heading, body_md)
       VALUES (?1, ?2, 'executive_summary', 0, ?3, ?4)`,
    )
      .bind(`dis_${crypto.randomUUID()}`, id, "The one-minute version",
            "Nothing reached the bar this morning. Either the sources are quiet or nothing matched what this firm follows.")
      .run();
    await env.WP_OS_DB.prepare(
      "UPDATE intelligence_report SET status = 'READY', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    ).bind(id).run();
    return { report_id: id, status: "READY", sections: 1, candidates: 0, flags: 0 };
  }

  // ── Evidence packet: facts, never raw article text. ──
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

  // Levels and the calendar, from a search-grounded pass. Deliberately AFTER the candidate check:
  // a day with nothing to report does not spend a search call, and the empty-day path above already
  // returned. Failure here degrades the report rather than failing it — the swept half is unaffected,
  // and the prompt is told to say the levels could not be read rather than to invent any.
  const market = await readMarket(env, actor, lens.companies ?? []);

  const packet: EvidencePacket = {
    report_date: reportDate,
    partner_name: user?.full_name ?? "Partner",
    market_levels: market.levels,
    calendar: market.calendar,
    firm_context: {
      sectors: lens.sectors, portfolio: entities.slice(0, 40), watchlist: lens.companies, themes: lens.themes,
    },
    open_narratives: await openNarratives(env, firmScope),
    events: packetEvents,
  };

  // ── Synthesis: one governed call. ──
  await setStatus(env, id, "GENERATING");
  let output = "";
  let aiRunId: string | null = null;
  let model: string | null = null;
  try {
    const result = await synthesise(env, actor, buildSynthesisPrompt(packet), reportDate, firmUserId);
    aiRunId = result.aiRunId;
    failedRunId = result.aiRunId;
    model = result.model;
    if (result.failure) return await fail("synthesis_failed", result.failure);
    output = result.output;
  } catch (err) {
    return await fail("synthesis_error", err instanceof Error ? err.message : String(err));
  }

  const parsed = parseReport(output);
  if (!parsed) return await fail("unparseable", "the model did not return a usable report");

  // Citations first, verification second. Models abbreviate UUIDs, and an id shortened to its first
  // block resolves to exactly one event or to none — the former is the id it meant, the latter
  // still fails below. Without this every citation reads as invented and the whole report is
  // withheld as unverifiable, which is precisely what happened the first time a model was good
  // enough to write all of it.
  const sections = resolveEventIds(parsed, packet);

  // ── Verify against the evidence, deterministically. ──
  await setStatus(env, id, "VERIFYING");
  const flags = verifyReport(sections, packet);

  // ── Persist. Replace sections wholesale: a regenerated report is one report, not two. ──
  await env.WP_OS_DB.prepare("DELETE FROM intelligence_report_section WHERE report_id = ?1").bind(id).run();
  const order = new Map<string, number>(REPORT_SECTIONS.map((s, n) => [s.key as string, n]));
  for (const s of sections) {
    // A flagged section is dropped rather than shown. The brief's whole point is that the operator
    // can trust it; showing a section known to cite something that does not exist would end that.
    if (flags.some((f) => f.section === s.key)) continue;
    await env.WP_OS_DB.prepare(
      `INSERT INTO intelligence_report_section (id, report_id, section_key, position, heading, body_md, item_ids_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        `dis_${crypto.randomUUID()}`, id, s.key, order.get(s.key) ?? 99,
        REPORT_SECTIONS.find((r) => r.key === s.key)?.heading ?? s.key,
        s.body_md, JSON.stringify(s.event_ids),
      )
      .run();
  }

  await env.WP_OS_DB.prepare(
    `UPDATE intelligence_report SET status = 'READY', model = ?2, ai_run_id = ?3,
            verification_flags = ?4, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    .bind(id, model, aiRunId, flags.length)
    .run();

  await appendEvent(env, {
    eventType: "daily_intelligence.generated",
    actorType: "system", actorId: "system",
    objectType: "intelligence_report", objectId: id, firmScope,
    payload: { report_date: reportDate, candidates: candidates.length, sections: sections.length, flags: flags.length, prompt_version: PROMPT_VERSION },
  });

  const flagged = new Set(flags.map((f) => f.section));
  const kept = sections.filter((s) => !flagged.has(s.key)).length;
  return { report_id: id, status: "READY", sections: kept, candidates: candidates.length, flags: flags.length };
}

/**
 * Deliver a report. Separate from generation so a delivery failure never marks a good report bad,
 * and so a retry re-sends rather than regenerating.
 */
export async function deliverReport(env: Env, reportId: string): Promise<{ delivered: boolean }> {
  const report = await env.WP_OS_DB.prepare(
    "SELECT id, firm_user_id, report_date, status, firm_scope FROM intelligence_report WHERE id = ?1",
  )
    .bind(reportId)
    .first<{ id: string; firm_user_id: string; report_date: string; status: string; firm_scope: string }>();
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
          body: sections.map((sec) => `## ${sec.heading}\n\n${sec.body_md}`).join("\n\n"),
          preparedBy: chiefOfStaffFor(reader?.full_name ?? ""),
          preparedFor: report.firm_user_id,
          sourceType: "intelligence_report",
          sourceId: reportId,
        },
      );
    }
  } catch {
    // The brief is delivered. It simply has no filed copy, which the interface reports.
  }

  return { delivered: true };
}

/**
 * Every enabled partner. One partner failing is caught and recorded so the others still get a
 * report — the brief calls this out and it is the difference between one bad morning and none.
 */
export async function runDailyForAll(
  env: Env,
  actor: Actor,
  now: Date,
  synthesise: Synthesise = defaultSynthesise,
): Promise<{ generated: number; failed: number }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const partners = await env.WP_OS_DB.prepare(
    `SELECT u.id, COALESCE(p.enabled, 1) AS enabled, COALESCE(p.timezone,'America/Chicago') AS timezone,
            COALESCE(p.weekends, 0) AS weekends
       FROM firm_user u
       LEFT JOIN partner_intelligence_profile p ON p.firm_user_id = u.id
       JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
      WHERE u.status = 'ACTIVE'`,
  ).all<{ id: string; enabled: number; timezone: string; weekends: number }>();

  let generated = 0;
  let failed = 0;
  for (const p of partners.results ?? []) {
    if (p.enabled !== 1) continue;
    if (p.weekends !== 1 && isWeekend(now, p.timezone)) continue;
    try {
      const out = await generateForPartner(env, actor, p.id, now, synthesise);
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
    } catch {
      failed += 1;
    }
  }
  return { generated, failed };
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
  if (!report) return json({ report: null, sections: [], date });

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

/** POST /api/daily-intelligence/generate — build (or rebuild) today's report. */
export async function handleGenerateDailyReport(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "intelligence_report", firmScope: actor.firmScopes[0] });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  try {
    const out = await generateForPartner(ctx.env, actor, actor.firmUserId!, new Date());
    if (out.status === "READY") await deliverReport(ctx.env, out.report_id).catch(() => undefined);
    return json(out, { status: 201 });
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
  const mine = await loadInterests(ctx.env, actor.firmUserId!);
  return json({
    firm: { sectors: FIRM_INTERESTS.sectors, themes: FIRM_INTERESTS.themes },
    mine,
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

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO partner_intelligence_profile (firm_user_id, sectors_json, themes_json, companies_json)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (firm_user_id) DO UPDATE SET
       sectors_json = excluded.sectors_json,
       themes_json = excluded.themes_json,
       companies_json = excluded.companies_json`,
  )
    .bind(actor.firmUserId!, JSON.stringify(next.sectors), JSON.stringify(next.themes), JSON.stringify(next.companies))
    .run();

  await appendEvent(ctx.env, {
    eventType: "daily_intelligence.interests_changed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "partner_intelligence_profile",
    objectId: actor.firmUserId!,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    // Counts, not contents: what somebody chooses to read about is theirs.
    payload: { sectors: next.sectors.length, themes: next.themes.length, companies: next.companies.length },
  });

  return json({ mine: next, note: "Saved. Your next brief is written against these." }, { status: 201 });
}
