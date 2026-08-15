import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { notifyQuietly } from "./notifications";
import type { FirmUserIdentity } from "../auth";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { privacyLabelSchema } from "../../shared/privacy";

/**
 * Daily Intelligence Engine (P14, GAP-05).
 *
 * The governed recurring pipeline:
 *
 *   trigger → source acquisition → dedupe → relevance → citations → archive → feedback
 *
 * Laws this module enforces (task §7.3, §8 GAP-05, §10):
 * - An item is NOT evidence. It has citations and a source, but promotion into a
 *   diligence_claim still runs the P5 path — there is no write from here into
 *   diligence_claim, knowledge_record, or canonical_company.
 * - Every item carries at least one citation naming where it came from. The service
 *   refuses to write an item without one.
 * - relevance_score is HEURISTIC and its rule is stated in relevance_reason on every row.
 * - HTTP_FEED sources need network egress this runtime does not have. They fail closed
 *   with EGRESS_GATED and the run is PARTIAL, not SUCCEEDED. A configured feed is never
 *   reported as a working feed.
 * - Re-running an idempotency key returns the ORIGINAL run. Acquisition never doubles.
 */

export class IntelligenceError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof IntelligenceError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export const INTELLIGENCE_CATEGORIES = [
  "MARKET",
  "SECONDARIES",
  "FUNDING_MA",
  "WATCHLIST",
  "AI_TECH",
  "REGULATORY",
  "PORTFOLIO",
  "COMPETITOR",
  "LP_SIGNAL",
  "OPPORTUNITY",
  "OTHER",
] as const;

const categorySchema = z.enum(INTELLIGENCE_CATEGORIES);

export interface IntelligenceSourceRow {
  id: string;
  source_key: string;
  name: string;
  kind: "MANUAL" | "INTERNAL" | "HTTP_FEED";
  url: string | null;
  category: string;
  data_class: string;
  enabled: number;
  requires_credential: number;
  credential_name: string | null;
  status: string;
  status_detail: string | null;
  last_checked_at: string | null;
  registered_by: string;
  firm_scope: string;
  created_at: string;
}

export interface IntelligenceItemRow {
  id: string;
  run_id: string;
  source_id: string;
  external_id: string | null;
  title: string;
  url: string | null;
  body: string;
  published_at: string | null;
  dedupe_hash: string;
  category: string;
  company_id: string | null;
  relevance_score: number;
  relevance_reason: string;
  why_matters: string | null;
  why_matters_origin: string;
  what_changed: string | null;
  synthesis_run_id: string | null;
  privacy_label: string;
  archived: number;
  archived_by: string | null;
  archived_at: string | null;
  firm_scope: string;
  created_at: string;
}

export interface IntelligenceRunRow {
  id: string;
  trigger_kind: string;
  idempotency_key: string;
  status: string;
  requested_by_type: string;
  requested_by_id: string;
  sources_attempted: number;
  sources_failed: number;
  items_acquired: number;
  items_duplicate: number;
  items_kept: number;
  source_report_json: string;
  failure_reason: string | null;
  started_at: string;
  completed_at: string | null;
  firm_scope: string;
}

// ── Dedupe ──

/** Normalized identity of a story: same headline + link is the same story. */
export function dedupeKeyFor(title: string, url: string | null | undefined): string {
  const normTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normUrl = (url ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  return `${normTitle}|${normUrl}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Relevance (deterministic, explainable, heuristic) ──

export interface WatchlistMatchable {
  id: string;
  label: string;
  kind: string;
  company_id: string | null;
  keywords_json: string;
}

export interface RelevanceResult {
  score: number;
  reason: string;
  matchedWatchlistIds: string[];
}

/**
 * Deterministic relevance. The rule, in full:
 *
 *   0.50  a watchlist entry matched (company id, label, or a configured keyword)
 *   0.20  the item's category is one the operator asked for in briefing preferences
 *   0.15  the item names a canonical company West Peek already tracks
 *   0.15  published within the last 3 days of `now`
 *
 * Nothing here is a model judgement. The reason string always names which parts fired,
 * so an operator can disagree with the ranking on the evidence rather than on vibes.
 */
export function scoreRelevance(
  item: { title: string; body: string; category: string; company_id: string | null; published_at: string | null },
  watchlists: WatchlistMatchable[],
  preferredCategories: string[],
  now: Date,
): RelevanceResult {
  const haystack = `${item.title}\n${item.body}`.toLowerCase();
  const matched: string[] = [];
  const reasons: string[] = [];
  let score = 0;

  for (const w of watchlists) {
    let keywords: string[] = [];
    try {
      keywords = JSON.parse(w.keywords_json) as string[];
    } catch {
      keywords = [];
    }
    const terms = [w.label, ...keywords].map((t) => t.toLowerCase()).filter((t) => t.length > 0);
    const hit =
      (w.company_id !== null && item.company_id === w.company_id) || terms.some((t) => haystack.includes(t));
    if (hit) matched.push(w.id);
  }
  if (matched.length > 0) {
    score += 0.5;
    reasons.push(`watchlist match (${matched.length} entr${matched.length === 1 ? "y" : "ies"})`);
  }

  if (preferredCategories.includes(item.category)) {
    score += 0.2;
    reasons.push(`category ${item.category} is in briefing preferences`);
  }

  if (item.company_id) {
    score += 0.15;
    reasons.push("names a tracked canonical company");
  }

  if (item.published_at) {
    const published = new Date(item.published_at);
    if (!Number.isNaN(published.getTime())) {
      const ageDays = (now.getTime() - published.getTime()) / 86_400_000;
      if (ageDays >= 0 && ageDays <= 3) {
        score += 0.15;
        reasons.push("published within 3 days");
      }
    }
  }

  return {
    score: Math.round(Math.min(1, score) * 100) / 100,
    reason: reasons.length > 0 ? `heuristic: ${reasons.join("; ")}` : "heuristic: no watchlist or category match",
    matchedWatchlistIds: matched,
  };
}

// ── Acquisition ──

export interface AcquiredItem {
  external_id?: string;
  title: string;
  url?: string;
  body?: string;
  published_at?: string;
  category?: (typeof INTELLIGENCE_CATEGORIES)[number];
  company_id?: string;
  privacy_label?: string;
  citation: { locator: string; quote?: string; url?: string };
}

export interface SourceReport {
  source_key: string;
  kind: string;
  ok: boolean;
  acquired: number;
  detail: string;
}

export interface IntelligenceRunDeps {
  /**
   * Injected fetch for HTTP_FEED sources. ABSENT BY DESIGN in the product runtime:
   * no live feed credential or egress approval exists, so feeds fail closed. Tests
   * inject a stub to prove the acquisition/dedupe path, never a real network call.
   */
  feedFetch?: (source: IntelligenceSourceRow) => Promise<AcquiredItem[]>;
  now?: Date;
  /** Manual items supplied by the operator with this run (MANUAL source). */
  manualItems?: AcquiredItem[];
}

/**
 * INTERNAL source acquisition: West Peek's own governed state, read-only.
 * This is the one acquisition path that always works offline, and it is the reason
 * the engine is useful before any external feed exists.
 */
async function acquireInternal(env: Env, now: Date): Promise<AcquiredItem[]> {
  const items: AcquiredItem[] = [];

  const alerts = await env.WP_OS_DB.prepare(
    `SELECT a.id, a.alert_type, a.severity, a.metric_key, a.detail_json, a.company_id, a.last_seen_at, c.canonical_name
       FROM portfolio_alert a
       LEFT JOIN canonical_company c ON c.id = a.company_id
      WHERE a.status = 'OPEN'
      ORDER BY a.last_seen_at DESC
      LIMIT 25`,
  ).all<{
    id: string;
    alert_type: string;
    severity: string;
    metric_key: string | null;
    detail_json: string;
    company_id: string;
    last_seen_at: string;
    canonical_name: string | null;
  }>();
  for (const a of alerts.results ?? []) {
    const body = `${a.alert_type}${a.metric_key ? ` on ${a.metric_key}` : ""} — severity ${a.severity}. Detail: ${a.detail_json}`;
    items.push({
      external_id: `portfolio_alert:${a.id}`,
      title: `${a.severity} portfolio alert — ${a.canonical_name ?? a.company_id}: ${a.alert_type}`,
      body,
      published_at: a.last_seen_at,
      category: "PORTFOLIO",
      company_id: a.company_id,
      privacy_label: "CONFIDENTIAL",
      citation: { locator: `portfolio_alert/${a.id}`, quote: body },
    });
  }

  const opportunities = await env.WP_OS_DB.prepare(
    `SELECT o.id, o.status, o.title, o.opportunity_type, o.company_id, o.created_at, c.canonical_name
       FROM investment_opportunity o
       LEFT JOIN canonical_company c ON c.id = o.company_id
      WHERE o.status IN ('NEW','SCREENING','IC_READY')
      ORDER BY o.created_at DESC
      LIMIT 25`,
  ).all<{ id: string; status: string; title: string; opportunity_type: string; company_id: string; created_at: string; canonical_name: string | null }>();
  for (const o of opportunities.results ?? []) {
    items.push({
      external_id: `opportunity:${o.id}`,
      title: `${o.opportunity_type} opportunity at ${o.status} — ${o.canonical_name ?? o.company_id}: ${o.title}`,
      body: `Investment opportunity ${o.id} is at status ${o.status}.`,
      published_at: o.created_at,
      category: o.status === "IC_READY" ? "OPPORTUNITY" : "SECONDARIES",
      company_id: o.company_id,
      privacy_label: "CONFIDENTIAL",
      citation: { locator: `investment_opportunity/${o.id}` },
    });
  }

  const constraints = await env.WP_OS_DB.prepare(
    `SELECT id, kind, severity, detail, created_at FROM constraint_violation ORDER BY created_at DESC LIMIT 10`,
  ).all<{ id: string; kind: string; severity: string; detail: string; created_at: string }>();
  for (const c of constraints.results ?? []) {
    items.push({
      external_id: `constraint:${c.id}`,
      title: `Allocation constraint ${c.severity} — ${c.kind}`,
      body: c.detail,
      published_at: c.created_at,
      category: "MARKET",
      privacy_label: "CONFIDENTIAL",
      citation: { locator: `constraint_violation/${c.id}`, quote: c.detail },
    });
  }

  void now;
  return items;
}

/**
 * Run the engine. Never throws for a source failure: a failed source is recorded in the
 * run's source report, counted, and the run finishes PARTIAL. Only a total inability to
 * write the run itself fails it.
 */
export async function runIntelligence(
  env: Env,
  actor: Actor,
  input: { idempotencyKey: string; triggerKind: "MANUAL" | "SCHEDULED"; sourceKeys?: string[] },
  deps: IntelligenceRunDeps = {},
): Promise<{ run: IntelligenceRunRow; items: IntelligenceItemRow[]; replayed: boolean }> {
  const authz = await authorize(env, actor, "intelligence_run.execute", { objectType: "intelligence_run" });
  if (authz.decision !== "ALLOW") throw new IntelligenceError(403, "forbidden", authz.reason);

  const existing = await env.WP_OS_DB.prepare("SELECT * FROM intelligence_run WHERE idempotency_key = ?1")
    .bind(input.idempotencyKey)
    .first<IntelligenceRunRow>();
  if (existing) {
    const rows = await env.WP_OS_DB.prepare("SELECT * FROM intelligence_item WHERE run_id = ?1 ORDER BY relevance_score DESC, id")
      .bind(existing.id)
      .all<IntelligenceItemRow>();
    return { run: existing, items: rows.results ?? [], replayed: true };
  }

  const now = deps.now ?? new Date();
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const runId = `irun_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO intelligence_run (id, trigger_kind, idempotency_key, status, requested_by_type, requested_by_id, firm_scope)
     VALUES (?1, ?2, ?3, 'RUNNING', ?4, ?5, ?6)`,
  )
    .bind(runId, input.triggerKind, input.idempotencyKey, actor.type, actor.firmUserId ?? actor.aiEmployeeId ?? "system", firmScope)
    .run();

  // Sources in scope.
  const allSources = await env.WP_OS_DB.prepare("SELECT * FROM intelligence_source WHERE enabled = 1 ORDER BY rowid").all<IntelligenceSourceRow>();
  const sources = (allSources.results ?? []).filter((s) => !input.sourceKeys || input.sourceKeys.includes(s.source_key));

  // Preferences + watchlists drive the deterministic score.
  const watchRows = await env.WP_OS_DB.prepare(
    "SELECT id, label, kind, company_id, keywords_json FROM watchlist_entry WHERE active = 1",
  ).all<WatchlistMatchable>();
  const watchlists = watchRows.results ?? [];
  const preferredCategories = await preferredCategoriesFor(env, actor.firmUserId ?? null);

  const reports: SourceReport[] = [];
  let acquired = 0;
  let duplicates = 0;
  let kept = 0;
  let failed = 0;
  const keptItems: IntelligenceItemRow[] = [];

  for (const source of sources) {
    let batch: AcquiredItem[] = [];
    let ok = true;
    let detail = "";
    try {
      if (source.kind === "MANUAL") {
        batch = deps.manualItems ?? [];
        detail = batch.length > 0 ? "operator-supplied items" : "no manual items supplied with this run";
      } else if (source.kind === "INTERNAL") {
        batch = await acquireInternal(env, now);
        detail = "derived from governed West Peek records";
      } else {
        if (!deps.feedFetch) {
          ok = false;
          detail =
            "EGRESS_GATED — no outbound feed client is configured in this runtime; external retrieval is UNPROVEN and was not attempted";
        } else {
          batch = await deps.feedFetch(source);
          detail = "acquired through the injected feed client";
        }
      }
    } catch (err) {
      ok = false;
      detail = `source failure: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!ok) {
      failed++;
      await env.WP_OS_DB.prepare(
        "UPDATE intelligence_source SET status = ?2, status_detail = ?3, last_checked_at = ?4 WHERE id = ?1",
      )
        .bind(source.id, source.kind === "HTTP_FEED" ? "EGRESS_GATED" : "FAILED", detail, now.toISOString())
        .run();
    } else {
      await env.WP_OS_DB.prepare(
        "UPDATE intelligence_source SET status = 'CONFIGURED', status_detail = ?2, last_checked_at = ?3 WHERE id = ?1",
      )
        .bind(source.id, detail, now.toISOString())
        .run();
    }

    let acquiredFromSource = 0;
    for (const raw of batch) {
      acquired++;
      acquiredFromSource++;
      const hash = await sha256Hex(dedupeKeyFor(raw.title, raw.url));
      const dupe = await env.WP_OS_DB.prepare("SELECT id FROM intelligence_item WHERE dedupe_hash = ?1").bind(hash).first<{ id: string }>();
      if (dupe) {
        duplicates++;
        continue;
      }
      const category = raw.category ?? "OTHER";
      const relevance = scoreRelevance(
        {
          title: raw.title,
          body: raw.body ?? "",
          category,
          company_id: raw.company_id ?? null,
          published_at: raw.published_at ?? null,
        },
        watchlists,
        preferredCategories,
        now,
      );
      const itemId = `iitem_${crypto.randomUUID()}`;
      await env.WP_OS_DB.prepare(
        `INSERT INTO intelligence_item
           (id, run_id, source_id, external_id, title, url, body, published_at, dedupe_hash, category,
            company_id, relevance_score, relevance_reason, why_matters, why_matters_origin, privacy_label, firm_scope)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'DETERMINISTIC', ?15, ?16)`,
      )
        .bind(
          itemId,
          runId,
          source.id,
          raw.external_id ?? null,
          raw.title,
          raw.url ?? null,
          raw.body ?? "",
          raw.published_at ?? null,
          hash,
          category,
          raw.company_id ?? null,
          relevance.score,
          relevance.reason,
          whyMattersFor(relevance, category),
          raw.privacy_label ?? source.data_class ?? "INTERNAL",
          firmScope,
        )
        .run();

      // Provenance is mandatory: an item without a citation is not writable.
      await env.WP_OS_DB.prepare(
        "INSERT INTO intelligence_citation (id, item_id, source_id, locator, quote, url) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
        .bind(`icit_${crypto.randomUUID()}`, itemId, source.id, raw.citation.locator, raw.citation.quote ?? null, raw.citation.url ?? raw.url ?? null)
        .run();

      kept++;
      const stored = await env.WP_OS_DB.prepare("SELECT * FROM intelligence_item WHERE id = ?1").bind(itemId).first<IntelligenceItemRow>();
      if (stored) keptItems.push(stored);
    }

    reports.push({ source_key: source.source_key, kind: source.kind, ok, acquired: acquiredFromSource, detail });
  }

  const status = failed > 0 ? "PARTIAL" : "SUCCEEDED";
  await env.WP_OS_DB.prepare(
    `UPDATE intelligence_run
        SET status = ?2, sources_attempted = ?3, sources_failed = ?4, items_acquired = ?5,
            items_duplicate = ?6, items_kept = ?7, source_report_json = ?8, completed_at = ?9,
            failure_reason = ?10
      WHERE id = ?1`,
  )
    .bind(
      runId,
      status,
      sources.length,
      failed,
      acquired,
      duplicates,
      kept,
      JSON.stringify(reports),
      now.toISOString(),
      failed > 0 ? `${failed} of ${sources.length} sources did not deliver` : null,
    )
    .run();

  await appendEvent(env, {
    eventType: "intelligence_run.completed",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "intelligence_run",
    objectId: runId,
    firmScope,
    payload: { status, sources_attempted: sources.length, sources_failed: failed, items_kept: kept, items_duplicate: duplicates },
  });

  const run = (await env.WP_OS_DB.prepare("SELECT * FROM intelligence_run WHERE id = ?1").bind(runId).first<IntelligenceRunRow>())!;
  return { run, items: keptItems, replayed: false };
}

function whyMattersFor(relevance: RelevanceResult, category: string): string {
  if (relevance.matchedWatchlistIds.length > 0) {
    return `Surfaced because it matched ${relevance.matchedWatchlistIds.length} active watchlist entr${relevance.matchedWatchlistIds.length === 1 ? "y" : "ies"}. Heuristic ranking, not a judgement.`;
  }
  return `Surfaced as ${category} coverage. Heuristic ranking, not a judgement.`;
}

async function preferredCategoriesFor(env: Env, firmUserId: string | null): Promise<string[]> {
  if (!firmUserId) return [];
  const pref = await latestPreference(env, firmUserId);
  if (!pref) return [];
  try {
    const briefing = JSON.parse(pref.briefing_json) as { categories?: string[] };
    return briefing.categories ?? [];
  } catch {
    return [];
  }
}

// ── Preferences ──

export interface MpHomePreferenceRow {
  id: string;
  firm_user_id: string;
  version_no: number;
  modules_json: string;
  briefing_json: string;
  set_by: string;
  firm_scope: string;
  created_at: string;
}

export async function latestPreference(env: Env, firmUserId: string): Promise<MpHomePreferenceRow | null> {
  return env.WP_OS_DB.prepare(
    "SELECT * FROM mp_home_preference WHERE firm_user_id = ?1 ORDER BY version_no DESC LIMIT 1",
  )
    .bind(firmUserId)
    .first<MpHomePreferenceRow>();
}

const preferenceSchema = z.object({
  modules: z.array(z.string().trim().min(1)),
  briefing: z
    .object({
      categories: z.array(categorySchema).optional(),
      delivery_hour_local: z.number().int().min(0).max(23).optional(),
      quiet_hours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).optional(),
      max_items: z.number().int().min(1).max(50).optional(),
    })
    .default({}),
});

export async function setPreference(
  env: Env,
  actor: Actor,
  body: z.infer<typeof preferenceSchema>,
): Promise<MpHomePreferenceRow> {
  if (actor.type !== "HUMAN" || !actor.firmUserId) {
    throw new IntelligenceError(403, "forbidden", "home preferences belong to a human operator");
  }
  const authz = await authorize(env, actor, "mp_home_preference.set", { objectType: "mp_home_preference", objectId: actor.firmUserId });
  if (authz.decision !== "ALLOW") throw new IntelligenceError(403, "forbidden", authz.reason);

  const current = await latestPreference(env, actor.firmUserId);
  const nextVersion = (current?.version_no ?? 0) + 1;
  const id = `mhp_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO mp_home_preference (id, firm_user_id, version_no, modules_json, briefing_json, set_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, actor.firmUserId, nextVersion, JSON.stringify(body.modules), JSON.stringify(body.briefing), actor.firmUserId, actor.firmScopes[0] ?? "west-peek")
    .run();

  await appendEvent(env, {
    eventType: "mp_home_preference.set",
    actorType: "firm_user",
    actorId: actor.firmUserId,
    objectType: "mp_home_preference",
    objectId: id,
    payload: { version_no: nextVersion, modules: body.modules },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM mp_home_preference WHERE id = ?1").bind(id).first<MpHomePreferenceRow>())!;
}

// ── Watchlists ──

const watchlistSchema = z.object({
  kind: z.enum(["COMPANY", "TOPIC", "SECTOR", "PERSON"]),
  label: z.string().trim().min(1),
  company_id: z.string().trim().min(1).optional(),
  keywords: z.array(z.string().trim().min(1)).default([]),
});

export async function addWatchlistEntry(env: Env, actor: Actor, body: z.infer<typeof watchlistSchema>) {
  if (actor.type !== "HUMAN" || !actor.firmUserId) {
    throw new IntelligenceError(403, "forbidden", "a watchlist belongs to a human operator");
  }
  const authz = await authorize(env, actor, "watchlist.manage", { objectType: "watchlist_entry" });
  if (authz.decision !== "ALLOW") throw new IntelligenceError(403, "forbidden", authz.reason);

  if (body.company_id) {
    const company = await env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(body.company_id).first();
    if (!company) throw new IntelligenceError(404, "company_not_found", "watchlist company must be a canonical company (D3)");
  }
  const id = `wl_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO watchlist_entry (id, owner_id, kind, label, company_id, keywords_json, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, actor.firmUserId, body.kind, body.label, body.company_id ?? null, JSON.stringify(body.keywords), actor.firmScopes[0] ?? "west-peek")
    .run();
  await env.WP_OS_DB.prepare("INSERT INTO watchlist_change (id, watchlist_id, action, actor_id) VALUES (?1, ?2, 'ADD', ?3)")
    .bind(`wlc_${crypto.randomUUID()}`, id, actor.firmUserId)
    .run();
  await appendEvent(env, {
    eventType: "watchlist.added",
    actorType: "firm_user",
    actorId: actor.firmUserId,
    objectType: "watchlist_entry",
    objectId: id,
    payload: { kind: body.kind, label: body.label },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM watchlist_entry WHERE id = ?1").bind(id).first();
}

export async function setWatchlistActive(env: Env, actor: Actor, id: string, active: boolean) {
  if (actor.type !== "HUMAN" || !actor.firmUserId) throw new IntelligenceError(403, "forbidden", "human only");
  const row = await env.WP_OS_DB.prepare("SELECT * FROM watchlist_entry WHERE id = ?1").bind(id).first<{ id: string; owner_id: string; active: number }>();
  if (!row) throw new IntelligenceError(404, "not_found");
  if (row.owner_id !== actor.firmUserId) {
    throw new IntelligenceError(403, "forbidden", "a watchlist entry may only be changed by its owner");
  }
  const authz = await authorize(env, actor, "watchlist.manage", { objectType: "watchlist_entry", objectId: id });
  if (authz.decision !== "ALLOW") throw new IntelligenceError(403, "forbidden", authz.reason);
  await env.WP_OS_DB.prepare("UPDATE watchlist_entry SET active = ?2 WHERE id = ?1").bind(id, active ? 1 : 0).run();
  await env.WP_OS_DB.prepare("INSERT INTO watchlist_change (id, watchlist_id, action, actor_id) VALUES (?1, ?2, ?3, ?4)")
    .bind(`wlc_${crypto.randomUUID()}`, id, active ? "REACTIVATE" : "DEACTIVATE", actor.firmUserId)
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM watchlist_entry WHERE id = ?1").bind(id).first();
}

// ── Item lifecycle ──

/**
 * An item the caller may not READ is an item they may not ACT ON. Every mutation path below
 * resolves the item through this helper so the SQL visibility rule is applied once, uniformly.
 */
async function getVisibleItem(env: Env, identity: FirmUserIdentity, id: string): Promise<IntelligenceItemRow | null> {
  const visibility = privacyVisibilityClause(identity, "privacy_label");
  return env.WP_OS_DB.prepare(`SELECT * FROM intelligence_item WHERE id = ?1 AND ${visibility}`).bind(id).first<IntelligenceItemRow>();
}

export async function archiveItem(env: Env, identity: FirmUserIdentity, itemId: string) {
  const actor = actorFromIdentity(identity);
  if (actor.type !== "HUMAN" || !actor.firmUserId) throw new IntelligenceError(403, "forbidden", "human only");
  const authz = await authorize(env, actor, "intelligence_item.archive", { objectType: "intelligence_item", objectId: itemId });
  if (authz.decision !== "ALLOW") throw new IntelligenceError(403, "forbidden", authz.reason);
  const item = await getVisibleItem(env, identity, itemId);
  if (!item) throw new IntelligenceError(404, "not_found");
  if (item.archived === 1) throw new IntelligenceError(409, "already_archived");
  await env.WP_OS_DB.prepare("UPDATE intelligence_item SET archived = 1, archived_by = ?2, archived_at = ?3 WHERE id = ?1")
    .bind(itemId, actor.firmUserId, new Date().toISOString())
    .run();
  await appendEvent(env, {
    eventType: "intelligence_item.archived",
    actorType: "firm_user",
    actorId: actor.firmUserId,
    objectType: "intelligence_item",
    objectId: itemId,
    payload: { title: item.title },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM intelligence_item WHERE id = ?1").bind(itemId).first<IntelligenceItemRow>();
}

const feedbackSchema = z.object({
  signal: z.enum(["USEFUL", "NOT_RELEVANT", "MORE_LIKE_THIS", "LESS_LIKE_THIS"]),
  note: z.string().trim().min(1).optional(),
});

export async function recordFeedback(env: Env, identity: FirmUserIdentity, itemId: string, body: z.infer<typeof feedbackSchema>) {
  const actor = actorFromIdentity(identity);
  if (actor.type !== "HUMAN" || !actor.firmUserId) throw new IntelligenceError(403, "forbidden", "human only");
  const authz = await authorize(env, actor, "intelligence_feedback.record", { objectType: "intelligence_item", objectId: itemId });
  if (authz.decision !== "ALLOW") throw new IntelligenceError(403, "forbidden", authz.reason);
  const item = await getVisibleItem(env, identity, itemId);
  if (!item) throw new IntelligenceError(404, "not_found");
  const id = `ifb_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO intelligence_feedback (id, item_id, firm_user_id, signal, note) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, itemId, actor.firmUserId, body.signal, body.note ?? null)
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM intelligence_feedback WHERE id = ?1").bind(id).first();
}

/**
 * Draft "why this matters" through the governed AI boundary.
 *
 * Quarantine law (P4): an external-provider output lands quarantined. We record the run
 * id and mark the item AI_QUARANTINED — the quarantined text is NOT copied into
 * why_matters. Only an unquarantined completed run (local adapter, or an output a human
 * already accepted) writes the text, as AI_ACCEPTED.
 */
export async function synthesizeItem(env: Env, identity: FirmUserIdentity, itemId: string) {
  const actor = actorFromIdentity(identity);
  const authz = await authorize(env, actor, "intelligence_item.synthesize", { objectType: "intelligence_item", objectId: itemId });
  if (authz.decision !== "ALLOW") throw new IntelligenceError(403, "forbidden", authz.reason);
  const item = await getVisibleItem(env, identity, itemId);
  if (!item) throw new IntelligenceError(404, "not_found");

  const { run } = await runAi(env, {
    purpose: `intelligence synthesis: why this matters to West Peek`,
    actor,
    inputs: [`Headline: ${item.title}`, `Body: ${item.body}`, `Category: ${item.category}`, `Heuristic ranking: ${item.relevance_reason}`],
    sensitivity: (item.privacy_label as never) ?? "INTERNAL",
    capabilityRequirement: "text-completion",
  });

  if (run.status !== "COMPLETED") {
    await env.WP_OS_DB.prepare("UPDATE intelligence_item SET synthesis_run_id = ?2, why_matters_origin = 'DETERMINISTIC' WHERE id = ?1")
      .bind(itemId, run.id)
      .run();
    return { item: await getItem(env, itemId), run, applied: false, reason: run.failure_reason ?? run.status };
  }
  if (run.output_quarantine === 1) {
    await env.WP_OS_DB.prepare("UPDATE intelligence_item SET synthesis_run_id = ?2, why_matters_origin = 'AI_QUARANTINED' WHERE id = ?1")
      .bind(itemId, run.id)
      .run();
    return {
      item: await getItem(env, itemId),
      run,
      applied: false,
      reason: "output_quarantined: accept the run output before it can be shown as why-it-matters",
    };
  }
  await env.WP_OS_DB.prepare(
    "UPDATE intelligence_item SET why_matters = ?2, why_matters_origin = 'AI_ACCEPTED', synthesis_run_id = ?3 WHERE id = ?1",
  )
    .bind(itemId, run.output_text, run.id)
    .run();
  return { item: await getItem(env, itemId), run, applied: true, reason: null };
}

async function getItem(env: Env, id: string): Promise<IntelligenceItemRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM intelligence_item WHERE id = ?1").bind(id).first<IntelligenceItemRow>();
}

// ── Briefing assembly ──

export interface BriefingRow {
  id: string;
  briefing_date: string;
  firm_user_id: string;
  run_id: string | null;
  status: string;
  item_ids_json: string;
  one_thing_to_watch: string | null;
  selection_rule: string;
  generated_at: string;
  viewed_at: string | null;
  firm_scope: string;
}

const SELECTION_RULE =
  "top N active items by heuristic relevance score, then recency; one_thing_to_watch is the single highest-scoring item";

/**
 * Assemble (or return) the briefing for a date. Deterministic and idempotent per
 * (date, user): the same day's briefing is one addressable, archived artifact.
 */
export async function assembleBriefing(
  env: Env,
  identity: FirmUserIdentity,
  opts: { date?: string; now?: Date } = {},
): Promise<{ briefing: BriefingRow; items: IntelligenceItemRow[] }> {
  const actor = actorFromIdentity(identity);
  if (!actor.firmUserId) throw new IntelligenceError(403, "forbidden", "a briefing belongs to a firm user");
  const now = opts.now ?? new Date();
  const date = opts.date ?? now.toISOString().slice(0, 10);

  // A briefing is a READ of intelligence items, so it obeys the same visibility rule the item
  // list does. Without this, a user with no sensitive-label scope would receive CONFIDENTIAL
  // items in their own briefing — privacy enforced in SQL, never by what the client renders.
  const visibility = privacyVisibilityClause(identity, "privacy_label");

  const existing = await env.WP_OS_DB.prepare("SELECT * FROM briefing WHERE briefing_date = ?1 AND firm_user_id = ?2")
    .bind(date, actor.firmUserId)
    .first<BriefingRow>();
  if (existing) {
    return { briefing: existing, items: await itemsByIds(env, JSON.parse(existing.item_ids_json) as string[], visibility) };
  }

  const pref = await latestPreference(env, actor.firmUserId);
  let maxItems = 10;
  if (pref) {
    try {
      maxItems = (JSON.parse(pref.briefing_json) as { max_items?: number }).max_items ?? 10;
    } catch {
      maxItems = 10;
    }
  }

  const rows = await env.WP_OS_DB.prepare(
    `SELECT * FROM intelligence_item
      WHERE archived = 0 AND ${visibility}
      ORDER BY relevance_score DESC, created_at DESC, id
      LIMIT ?1`,
  )
    .bind(maxItems)
    .all<IntelligenceItemRow>();
  const items = rows.results ?? [];

  const lastRun = await env.WP_OS_DB.prepare("SELECT id FROM intelligence_run ORDER BY started_at DESC LIMIT 1").first<{ id: string }>();
  const id = `brf_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO briefing (id, briefing_date, firm_user_id, run_id, status, item_ids_json, one_thing_to_watch, selection_rule, firm_scope)
     VALUES (?1, ?2, ?3, ?4, 'READY', ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      date,
      actor.firmUserId,
      lastRun?.id ?? null,
      JSON.stringify(items.map((i) => i.id)),
      items[0] ? `${items[0].title} — ${items[0].relevance_reason}` : null,
      SELECTION_RULE,
      actor.firmScopes[0] ?? "west-peek",
    )
    .run();

  await appendEvent(env, {
    eventType: "briefing.generated",
    actorType: "firm_user",
    actorId: actor.firmUserId,
    objectType: "briefing",
    objectId: id,
    payload: { date, item_count: items.length },
  });

  await notifyQuietly(env, {
    kind: "INTELLIGENCE_BRIEF",
    severity: "INFO",
    title: `Your ${date} intelligence brief is ready`,
    body: items.length > 0 ? `${items.length} item(s); top: ${items[0]!.title}` : "No items ranked for today.",
    objectType: "briefing",
    objectId: id,
    firmUserId: actor.firmUserId,
    dedupeKey: `briefing:${id}`,
    firmScope: actor.firmScopes[0] ?? "west-peek",
  });

  const briefing = (await env.WP_OS_DB.prepare("SELECT * FROM briefing WHERE id = ?1").bind(id).first<BriefingRow>())!;
  return { briefing, items };
}

/**
 * Re-read a stored briefing's items under the CURRENT reader's visibility. An item whose label
 * the reader may not see is dropped from the read, even though it is still listed on the archived
 * briefing row — the artifact is immutable, the view of it is not.
 */
async function itemsByIds(env: Env, ids: string[], visibility: string): Promise<IntelligenceItemRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const rows = await env.WP_OS_DB.prepare(
    `SELECT * FROM intelligence_item WHERE id IN (${placeholders}) AND ${visibility} ORDER BY relevance_score DESC, id`,
  )
    .bind(...ids)
    .all<IntelligenceItemRow>();
  return rows.results ?? [];
}

// ── HTTP handlers ──

const sourceSchema = z.object({
  source_key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(["MANUAL", "INTERNAL", "HTTP_FEED"]),
  url: z.string().trim().url().optional(),
  category: categorySchema.default("OTHER"),
  data_class: privacyLabelSchema.default("PUBLIC"),
  requires_credential: z.boolean().default(false),
  credential_name: z.string().trim().min(1).optional(),
});

export async function handleRegisterSource(ctx: RouteContext): Promise<Response> {
  const parsed = sourceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "intelligence_source.register", { objectType: "intelligence_source" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const body = parsed.data;
  // An HTTP feed is registered as UNCONFIGURED until an egress path exists: registering a
  // URL is not the same as being able to read it, and the surface must not imply otherwise.
  const status = body.kind === "HTTP_FEED" ? "EGRESS_GATED" : "CONFIGURED";
  const detail =
    body.kind === "HTTP_FEED"
      ? "registered; external retrieval is UNPROVEN in this runtime (no outbound feed client, no credential)"
      : "registered";
  const id = `isrc_${crypto.randomUUID()}`;
  try {
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO intelligence_source (id, source_key, name, kind, url, category, data_class, requires_credential, credential_name, status, status_detail, registered_by, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
      .bind(
        id,
        body.source_key,
        body.name,
        body.kind,
        body.url ?? null,
        body.category,
        body.data_class,
        body.requires_credential ? 1 : 0,
        body.credential_name ?? null,
        status,
        detail,
        ctx.identity!.id,
        actor.firmScopes[0] ?? "west-peek",
      )
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) return json({ error: "duplicate_source_key" }, { status: 409 });
    throw err;
  }
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM intelligence_source WHERE id = ?1").bind(id).first();
  return json(row, { status: 201 });
}

export async function handleListSources(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM intelligence_source ORDER BY rowid").all<IntelligenceSourceRow>();
  return json({
    sources: rows.results ?? [],
    note: "status EGRESS_GATED means the source is registered but has never been read: this runtime has no outbound feed client.",
  });
}

const updateSourceSchema = z.object({ enabled: z.boolean() });

export async function handleUpdateSource(ctx: RouteContext): Promise<Response> {
  const parsed = updateSourceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "intelligence_source.update", { objectType: "intelligence_source", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  const row = await ctx.env.WP_OS_DB.prepare("SELECT id FROM intelligence_source WHERE id = ?1").bind(ctx.params.id!).first();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  await ctx.env.WP_OS_DB.prepare("UPDATE intelligence_source SET enabled = ?2 WHERE id = ?1")
    .bind(ctx.params.id!, parsed.data.enabled ? 1 : 0)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM intelligence_source WHERE id = ?1").bind(ctx.params.id!).first());
}

const manualItemSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().url().optional(),
  body: z.string().trim().default(""),
  published_at: z.string().trim().min(1).optional(),
  category: categorySchema.optional(),
  company_id: z.string().trim().min(1).optional(),
  citation_locator: z.string().trim().min(1),
  citation_quote: z.string().trim().min(1).optional(),
});

const runSchema = z.object({
  idempotency_key: z.string().trim().min(1),
  source_keys: z.array(z.string().trim().min(1)).optional(),
  manual_items: z.array(manualItemSchema).optional(),
});

export async function handleRunIntelligence(ctx: RouteContext): Promise<Response> {
  const parsed = runSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const result = await runIntelligence(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      { idempotencyKey: parsed.data.idempotency_key, triggerKind: "MANUAL", sourceKeys: parsed.data.source_keys },
      {
        manualItems: (parsed.data.manual_items ?? []).map((m) => ({
          title: m.title,
          url: m.url,
          body: m.body,
          published_at: m.published_at,
          category: m.category,
          company_id: m.company_id,
          citation: { locator: m.citation_locator, quote: m.citation_quote, url: m.url },
        })),
      },
    );
    return json({ run: result.run, items: result.items, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListRuns(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM intelligence_run ORDER BY started_at DESC LIMIT 50").all<IntelligenceRunRow>();
  return json({ runs: rows.results ?? [] });
}

export async function handleListItems(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const includeArchived = url.searchParams.get("archived") === "1";
  const category = url.searchParams.get("category");
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const clauses = [visibility, includeArchived ? "1=1" : "archived = 0"];
  const binds: string[] = [];
  if (category) {
    clauses.push(`category = ?${binds.length + 1}`);
    binds.push(category);
  }
  const stmt = ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM intelligence_item WHERE ${clauses.join(" AND ")} ORDER BY relevance_score DESC, created_at DESC LIMIT 200`,
  );
  const rows = binds.length > 0 ? await stmt.bind(...binds).all<IntelligenceItemRow>() : await stmt.all<IntelligenceItemRow>();
  return json({
    items: rows.results ?? [],
    ranking: "relevance_score is a deterministic heuristic; relevance_reason states which rules fired",
  });
}

export async function handleGetItem(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const item = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM intelligence_item WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<IntelligenceItemRow>();
  if (!item) return json({ error: "not_found" }, { status: 404 });
  const citations = await ctx.env.WP_OS_DB.prepare(
    "SELECT c.*, s.name AS source_name, s.kind AS source_kind FROM intelligence_citation c JOIN intelligence_source s ON s.id = c.source_id WHERE c.item_id = ?1 ORDER BY c.created_at",
  )
    .bind(item.id)
    .all();
  const feedback = await ctx.env.WP_OS_DB.prepare("SELECT * FROM intelligence_feedback WHERE item_id = ?1 ORDER BY created_at")
    .bind(item.id)
    .all();
  return json({ ...item, citations: citations.results ?? [], feedback: feedback.results ?? [] });
}

export async function handleArchiveItem(ctx: RouteContext): Promise<Response> {
  try {
    return json(await archiveItem(ctx.env, ctx.identity!, ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleItemFeedback(ctx: RouteContext): Promise<Response> {
  const parsed = feedbackSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordFeedback(ctx.env, ctx.identity!, ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleSynthesizeItem(ctx: RouteContext): Promise<Response> {
  try {
    const result = await synthesizeItem(ctx.env, ctx.identity!, ctx.params.id!);
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleAddWatchlist(ctx: RouteContext): Promise<Response> {
  const parsed = watchlistSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await addWatchlistEntry(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListWatchlist(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM watchlist_entry WHERE owner_id = ?1 ORDER BY created_at DESC",
  )
    .bind(ctx.identity!.id)
    .all();
  return json({ watchlist: rows.results ?? [] });
}

const watchlistActiveSchema = z.object({ active: z.boolean() });

export async function handleSetWatchlistActive(ctx: RouteContext): Promise<Response> {
  const parsed = watchlistActiveSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await setWatchlistActive(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.active));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetPreferences(ctx: RouteContext): Promise<Response> {
  const pref = await latestPreference(ctx.env, ctx.identity!.id);
  const history = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, version_no, modules_json, briefing_json, set_by, created_at FROM mp_home_preference WHERE firm_user_id = ?1 ORDER BY version_no DESC",
  )
    .bind(ctx.identity!.id)
    .all();
  return json({ preference: pref, history: history.results ?? [] });
}

export async function handleSetPreferences(ctx: RouteContext): Promise<Response> {
  const parsed = preferenceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await setPreference(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetBriefing(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const date = url.searchParams.get("date") ?? undefined;
  try {
    const { briefing, items } = await assembleBriefing(ctx.env, ctx.identity!, { date });
    return json({ briefing, items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListBriefings(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM briefing WHERE firm_user_id = ?1 ORDER BY briefing_date DESC LIMIT 60",
  )
    .bind(ctx.identity!.id)
    .all();
  return json({ briefings: rows.results ?? [] });
}
