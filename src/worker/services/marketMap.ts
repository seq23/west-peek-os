import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { searchFormD } from "../effects/secEdgarClient";
import { findCompanies } from "./liveSearch";
import {
  bySegment, coverageNote, groundCompanies, mergeCompanies, type CompanyFact,
} from "../../shared/market/mapping";

/**
 * The Market Mapping Room (P46, V1 #33).
 *
 * "Which companies exist in this sector, and how big are they." Four passes, cheapest and most
 * authoritative first:
 *
 *   1 · the firm's own records — companies we hold or are looking at;
 *   2 · funding news the sweeps already gathered;
 *   3 · SEC Form D filings — free, and a filing beats a press release on the raise;
 *   4 · a model pass to SEGMENT what we found and name the obvious gaps.
 *
 * ONE SOURCE FAILING DEGRADES THE MAP, NEVER FAILS IT. If EDGAR is down you get a thinner map and
 * the coverage note says EDGAR was unavailable. A market map that refuses to render because one of
 * four sources timed out is a market map nobody can rely on at 8am.
 *
 * WHAT THE MODEL IS AND IS NOT FOR. It groups companies into subsegments and flags what is missing.
 * It does NOT invent companies and it does NOT supply funding figures — those come from records,
 * and a figure with no source is not shown. Asking a model "who else is in this space" produces
 * plausible names that do not exist, which on a market map is indistinguishable from research.
 */

export class MarketMapError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

/** Pass 1 — companies the firm already knows, with our own position flagged. */
async function fromFirmRecords(env: Env, firmScope: string, sector: string): Promise<CompanyFact[]> {
  const like = `%${sector.toLowerCase().split(/\s+/)[0] ?? ""}%`;
  const rows = await env.WP_OS_DB.prepare(
    `SELECT c.id, c.canonical_name, c.description, c.website,
            (SELECT COUNT(*) FROM position p WHERE p.company_id = c.id AND p.status = 'OPEN') AS held,
            (SELECT COUNT(*) FROM investment_opportunity o WHERE o.company_id = c.id
              AND o.status NOT IN ('PASS','CLOSED','WITHDRAWN')) AS in_pipeline
       FROM canonical_company c
      WHERE c.firm_scope = ?1
        AND (LOWER(COALESCE(c.description,'')) LIKE ?2 OR LOWER(c.canonical_name) LIKE ?2)
      LIMIT 100`,
  )
    .bind(firmScope, like)
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map((r) => ({
    name: String(r.canonical_name),
    description: r.description ? String(r.description) : null,
    website: r.website ? String(r.website) : null,
    company_id: String(r.id),
    is_ours: Number(r.held ?? 0) > 0 || Number(r.in_pipeline ?? 0) > 0,
    funding_source: "FIRM_RECORD" as const,
  }));
}

/** Pass 2 — funding news the sweeps already collected. Free, and already paid for. */
async function fromSweptNews(env: Env, firmScope: string, sector: string): Promise<CompanyFact[]> {
  const terms = sector.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 4);
  if (terms.length === 0) return [];
  const where = terms.map(() => "(LOWER(i.title) LIKE ? OR LOWER(i.body) LIKE ?)").join(" OR ");
  const binds = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);

  const rows = await env.WP_OS_DB.prepare(
    `SELECT i.title, i.body, i.url, i.published_at
       FROM intelligence_item i
      WHERE i.archived = 0 AND i.firm_scope = ? AND (${where})
      ORDER BY COALESCE(i.published_at, i.created_at) DESC LIMIT 80`,
  )
    .bind(firmScope, ...binds)
    .all<Record<string, unknown>>();

  const out: CompanyFact[] = [];
  for (const r of rows.results ?? []) {
    const title = String(r.title ?? "");
    // "Acme raises $12M Series A" — the company is what precedes the verb. Deliberately narrow: a
    // loose extractor invents companies out of headline fragments, which is worse than missing them.
    const m = title.match(/^([A-Z][\w.&' -]{1,40}?)\s+(?:raises|raised|closes|lands|secures|announces)\b/);
    if (!m) continue;
    const amount = title.match(/\$\s?([\d.]+)\s*(billion|million|B|M)\b/i);
    let usd: number | null = null;
    if (amount) {
      const n = Number(amount[1]);
      const unit = amount[2]!.toLowerCase();
      if (Number.isFinite(n)) usd = unit.startsWith("b") ? n * 1e9 : n * 1e6;
    }
    out.push({
      name: m[1]!.trim(),
      last_round_usd: usd,
      last_round_date: r.published_at ? String(r.published_at) : null,
      source_url: r.url ? String(r.url) : null,
      description: r.body ? String(r.body).slice(0, 300) : null,
      funding_source: "SWEPT_NEWS",
    });
  }
  return out;
}

/** Pass 4 — the model segments what the records found. It never adds a company. */
async function segmentWithModel(
  env: Env,
  actor: Actor,
  sector: string,
  companies: readonly CompanyFact[],
): Promise<{ segments: Record<string, string>; runId: string | null }> {
  if (companies.length === 0) return { segments: {}, runId: null };

  const prompt = [
    `A partner is mapping the "${sector}" sector.`,
    "",
    "Group the companies below into 3–6 meaningful SUBSEGMENTS of this sector. Judge from the name",
    "and description supplied — nothing else.",
    "",
    "RULES:",
    "- Do NOT add companies. The list is the list; inventing a plausible name is indistinguishable",
    "  from research and worse than an incomplete map.",
    "- Do NOT supply funding figures, valuations or stages. Those come from records, not from you.",
    '- A company you cannot place goes in "Unsegmented". That is an honest answer.',
    "",
    "COMPANIES:",
    companies.map((c) => `- ${c.name}${c.description ? `: ${c.description.slice(0, 160)}` : ""}`).join("\n"),
    "",
    'Return ONLY JSON: {"segments":{"Company Name":"Subsegment name"}}',
  ].join("\n");

  try {
    const { run } = await runAi(env, {
      purpose: `market map segmentation: ${sector}`,
      actor,
      inputs: [prompt],
      sensitivity: "PUBLIC" as never,
      budgetContext: { judgement: true, expectedOutputTokens: 900 },
      // Pinned: a market map is read as a firm document, and a segmenter that mislabels a
      // company puts every downstream count wrong while still looking finished.
      routing: { category: "INTELLIGENCE", taskClass: "market-map" },
    });
    if (run.status !== "COMPLETED" || !run.output_text) return { segments: {}, runId: run.id };

    const fenced = run.output_text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = (fenced?.[1] ?? run.output_text).trim();
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) return { segments: {}, runId: run.id };

    const parsed = JSON.parse(body.slice(start, end + 1)) as { segments?: Record<string, unknown> };
    const known = new Map(companies.map((c) => [c.name.toLowerCase(), c.name]));
    const segments: Record<string, string> = {};
    for (const [name, seg] of Object.entries(parsed.segments ?? {})) {
      // Only accept a segment for a company that was actually supplied. This is what stops the
      // model quietly adding a name by putting it in the mapping.
      const real = known.get(name.toLowerCase());
      if (real && typeof seg === "string" && seg.trim()) segments[real] = seg.trim();
    }
    return { segments, runId: run.id };
  } catch {
    // Segmentation is a nicety; an unsegmented map is still a useful map.
    return { segments: {}, runId: null };
  }
}

export interface BuildResult {
  map_id: string;
  companies: number;
  segments: number;
  sources_used: string[];
  sources_failed: string[];
}

export async function buildMap(
  env: Env,
  actor: Actor,
  sector: string,
  deps: { edgar?: typeof searchFormD; search?: typeof findCompanies } = {},
): Promise<BuildResult> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "ai.run", { objectType: "mkt_map", firmScope });
  if (authz.decision !== "ALLOW") throw new MarketMapError(403, "forbidden", authz.reason);

  const term = sector.trim();
  if (term.length < 3) throw new MarketMapError(400, "sector_required", "Name the sector you want mapped.");

  const id = `mkm_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO mkt_map (id, sector, status, firm_scope, created_by) VALUES (?1, ?2, 'BUILDING', ?3, ?4)",
  )
    .bind(id, term, firmScope, actor.firmUserId ?? "system")
    .run();

  const used: string[] = [];
  const failed: string[] = [];
  const facts: CompanyFact[] = [];

  // Each source is attempted independently. One failing must not take the map with it.
  const firm = await fromFirmRecords(env, firmScope, term).catch(() => null);
  if (firm) { facts.push(...firm); if (firm.length) used.push("firm records"); }
  else failed.push("firm records");

  const news = await fromSweptNews(env, firmScope, term).catch(() => null);
  if (news) { facts.push(...news); if (news.length) used.push("swept funding news"); }
  else failed.push("swept funding news");

  const edgar = await (deps.edgar ?? searchFormD)(term);
  if (edgar.ok) { facts.push(...edgar.companies); if (edgar.companies.length) used.push("SEC Form D"); }
  else failed.push(`SEC Form D (${edgar.detail})`);

  // Pass 4 — live discovery. This is what finds companies the firm has never encountered and that
  // did not file a Form D; without it a map only reflects what was already known.
  const search = await (deps.search ?? findCompanies)(env, actor, term);
  if (search.ok) {
    for (const h of search.hits) {
      facts.push({
        name: h.name,
        description: h.description,
        website: h.url,
        source_url: h.url,
        funding_source: "WEB_SEARCH",
      });
    }
    if (search.hits.length) used.push("live web search");
  } else failed.push(`live web search (${search.detail})`);

  const { kept } = groundCompanies(facts);
  const merged = mergeCompanies(kept);

  const { segments, runId } = await segmentWithModel(env, actor, term, merged);
  for (const c of merged) c.segment = segments[c.name] ?? "Unsegmented";

  for (const c of merged) {
    await env.WP_OS_DB.prepare(
      `INSERT OR IGNORE INTO mkt_map_company
         (id, map_id, name, segment, description, stage, total_raised_usd, last_round_usd,
          last_round_date, valuation_usd, investors, website, funding_source, source_url, company_id, is_ours)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
    )
      .bind(
        `mkc_${crypto.randomUUID()}`, id, c.name, c.segment ?? "Unsegmented", c.description ?? null,
        c.stage ?? null, c.total_raised_usd ?? null, c.last_round_usd ?? null, c.last_round_date ?? null,
        c.valuation_usd ?? null, c.investors ?? null, c.website ?? null, c.funding_source,
        c.source_url ?? null, c.company_id ?? null, c.is_ours ? 1 : 0,
      )
      .run();
  }

  const panels = bySegment(merged);
  const note = `${coverageNote({ companies: merged, sourcesUsed: used })}${failed.length ? ` Unavailable this run: ${failed.join("; ")}.` : ""}`;

  /*
   * COUNTED FROM THE ROWS, NOT FROM THE INTENTION.
   *
   * This stored `merged.length` — how many companies the run MEANT to write. The insert above is
   * `INSERT OR IGNORE` against `UNIQUE (map_id, name)`, so any two companies the merge left sharing
   * a name are silently reduced to one and the stored number keeps counting both. The map then
   * reports "24 companies" over a list of 23, for ever, and nothing reconciles them: the count is
   * written once and never looked at again.
   *
   * `INSERT OR IGNORE` is kept — a name collision inside one map is a merge that could have been
   * tighter, not a reason to fail a whole market map — but the number now describes what is
   * actually there. One extra COUNT on a path that already made one query per company.
   */
  const landed = { n: await landedCompanyCount(env, id) };

  await env.WP_OS_DB.prepare(
    `UPDATE mkt_map SET status = 'READY', segments_json = ?2, company_count = ?3,
            coverage_note = ?4, sources_used = ?5, ai_run_id = ?6,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    .bind(id, JSON.stringify(panels.map((p) => p.segment)), landed?.n ?? 0, note, JSON.stringify(used), runId)
    .run();

  await appendEvent(env, {
    eventType: "market_map.built",
    actorType: "firm_user", actorId: actor.firmUserId ?? "system",
    objectType: "mkt_map", objectId: id, firmScope,
    payload: { sector: term, companies: merged.length, segments: panels.length, sources_used: used, sources_failed: failed },
  });

  return { map_id: id, companies: merged.length, segments: panels.length, sources_used: used, sources_failed: failed };
}

/**
 * How many companies are ACTUALLY on this map.
 *
 * Exported so the invariant can be asserted directly rather than inferred from a build that needs a
 * model and a web search to run. The number `mkt_map.company_count` stores must always be this.
 */
export async function landedCompanyCount(env: Env, mapId: string): Promise<number> {
  const row = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM mkt_map_company WHERE map_id = ?1")
    .bind(mapId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ── Routes ───────────────────────────────────────────────────────────────────

const buildSchema = z.object({ sector: z.string().min(3).max(120) });

export async function handleBuildMap(ctx: RouteContext): Promise<Response> {
  const parsed = buildSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await buildMap(ctx.env, actorFromIdentity(ctx.identity!), parsed.data.sector), { status: 201 });
  } catch (err) {
    if (err instanceof MarketMapError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}

export async function handleListMaps(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, sector, status, company_count, created_at FROM mkt_map ORDER BY created_at DESC LIMIT 50",
  ).all();
  return json({ maps: rows.results ?? [] });
}

export async function handleGetMap(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  if (!id) return json({ error: "invalid_input" }, { status: 400 });
  const map = await ctx.env.WP_OS_DB.prepare("SELECT * FROM mkt_map WHERE id = ?1").bind(id).first<Record<string, unknown>>();
  if (!map) return json({ error: "not_found" }, { status: 404 });
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM mkt_map_company WHERE map_id = ?1",
  ).bind(id).all<Record<string, unknown>>();

  const companies = (rows.results ?? []).map((r) => ({
    ...r,
    is_ours: Number(r.is_ours) === 1,
  })) as unknown as CompanyFact[];

  return json({ map, panels: bySegment(companies) });
}
