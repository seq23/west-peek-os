import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import {
  CLOSING_SIX,
  championRestrictedSections,
  sectionsFor,
  type Sector,
} from "../../shared/ic/diligenceFramework";

/**
 * IC Decision Portal — diligence, readiness and follow-up (P34, V1 #26, canon §28.6).
 *
 * The decision spine lives in ic.ts and is unchanged: assemble → submit → approval card → decide,
 * with ic_decision append-only. This module adds what the decision is supposed to REST on.
 *
 * The two framework rules that are enforced here rather than suggested:
 *
 *   CHAMPION MAY NOT WRITE THE BEAR CASE — answering kill_case or closing_6 as the named champion
 *   is refused with 409. The operator's reason: "the deal champion should not answer #6 first.
 *   Have someone else make the bear case. Otherwise IC has a nasty tendency to become a sales
 *   meeting for the investment rather than an actual decision process."
 *
 *   READINESS IS NOT A PERCENTAGE — icReadiness() returns which sections are open, by name. A
 *   number would let a packet read "92% ready" with the entire kill case empty, which is precisely
 *   the failure the framework exists to prevent.
 *
 * NOTHING HERE BLOCKS A DECISION. Readiness is reported, not enforced: the partners are allowed to
 * decide against an incomplete packet — that is their authority — but they do it knowing exactly
 * what is missing, and the gap is recorded on the packet forever.
 */

export class IcPortalError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

interface PacketRow {
  id: string;
  opportunity_id: string;
  status: string;
  sector: Sector;
  champion_user_id: string | null;
  firm_scope: string;
}

export interface AnswerRow {
  id: string;
  ic_packet_id: string;
  section_id: string;
  state: string;
  body: string | null;
  na_reason: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

const CLOSING_IDS = CLOSING_SIX.map((q) => `closing_${q.n}`);

/** Section ids the champion may not author: the core bear case, plus Closing Six #6. */
export function restrictedSectionIds(): string[] {
  return [
    ...championRestrictedSections(),
    ...CLOSING_SIX.filter((q) => q.championMayNotAnswer).map((q) => `closing_${q.n}`),
  ];
}

/** Every section id a packet of this sector is expected to cover. */
export function expectedSectionIds(sector: Sector): string[] {
  const s = sectionsFor(sector);
  return [...s.core.map((c) => c.id), ...(s.sector ? [`sector_${s.sector.sector.toLowerCase()}`] : []), ...CLOSING_IDS];
}

export interface Readiness {
  /** Sections with no answer at all, or explicitly OPEN. Named, never counted into a score. */
  open: string[];
  answered: string[];
  not_applicable: string[];
  /** True only when nothing is open. Advisory — the partners may still decide. */
  complete: boolean;
  /** Present when the bear case is still unwritten; the single most important gap. */
  bear_case_missing: boolean;
}

export function icReadiness(sector: Sector, answers: readonly AnswerRow[]): Readiness {
  const byId = new Map(answers.map((a) => [a.section_id, a]));
  const open: string[] = [];
  const answered: string[] = [];
  const na: string[] = [];
  for (const id of expectedSectionIds(sector)) {
    const a = byId.get(id);
    if (!a || a.state === "OPEN") open.push(id);
    else if (a.state === "NOT_APPLICABLE") na.push(id);
    else answered.push(id);
  }
  return {
    open,
    answered,
    not_applicable: na,
    complete: open.length === 0,
    bear_case_missing: restrictedSectionIds().some((id) => open.includes(id)),
  };
}

async function requirePacket(env: Env, packetId: string): Promise<PacketRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT id, opportunity_id, status, sector, champion_user_id, firm_scope FROM ic_packet WHERE id = ?1",
  )
    .bind(packetId)
    .first<PacketRow>();
  if (!row) throw new IcPortalError(404, "not_found", "IC packet not found");
  return row;
}

async function mustAuthorize(env: Env, actor: Actor, packet: PacketRow, actionKey: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, {
    objectType: "ic_packet",
    objectId: packet.id,
    firmScope: packet.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new IcPortalError(403, "forbidden", authz.reason);
}

const answerSchema = z.object({
  section_id: z.string().min(2).max(60),
  state: z.enum(["OPEN", "ANSWERED", "NOT_APPLICABLE"]),
  body: z.string().max(20_000).nullish(),
  na_reason: z.string().max(1000).nullish(),
});

export async function saveAnswer(
  env: Env,
  actor: Actor,
  packetId: string,
  input: z.infer<typeof answerSchema>,
): Promise<AnswerRow> {
  const packet = await requirePacket(env, packetId);
  await mustAuthorize(env, actor, packet, "ic_packet.assemble");

  if (!expectedSectionIds(packet.sector).includes(input.section_id)) {
    throw new IcPortalError(400, "unknown_section", `${input.section_id} is not a section of this packet`);
  }

  // THE ANTI-BIAS RULE. Refused, not warned.
  if (
    restrictedSectionIds().includes(input.section_id) &&
    packet.champion_user_id &&
    actor.firmUserId === packet.champion_user_id
  ) {
    throw new IcPortalError(
      409,
      "champion_may_not_answer",
      "The deal champion cannot write the bear case. Someone else has to argue against this investment — otherwise IC becomes a sales meeting for it.",
    );
  }

  if (input.state === "ANSWERED" && !input.body?.trim()) {
    throw new IcPortalError(400, "empty_answer", "An answered section needs an answer.");
  }
  // An honest "not applicable" is complete; an unexplained one hides a forgotten category.
  if (input.state === "NOT_APPLICABLE" && !input.na_reason?.trim()) {
    throw new IcPortalError(400, "reason_required", "Say why this section does not apply.");
  }

  const id = `icd_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.WP_OS_DB.prepare(
    `INSERT INTO ic_diligence_answer (id, ic_packet_id, section_id, state, body, na_reason, answered_by, answered_at, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (ic_packet_id, section_id) DO UPDATE SET
       state = excluded.state, body = excluded.body, na_reason = excluded.na_reason,
       answered_by = excluded.answered_by, answered_at = excluded.answered_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(id, packetId, input.section_id, input.state, input.body ?? null, input.na_reason ?? null,
          actor.firmUserId ?? null, input.state === "OPEN" ? null : now, packet.firm_scope)
    .run();

  await appendEvent(env, {
    eventType: "ic.diligence_answered",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "ic_packet",
    objectId: packetId,
    firmScope: packet.firm_scope,
    payload: { section_id: input.section_id, state: input.state },
  });

  return (await env.WP_OS_DB.prepare(
    "SELECT * FROM ic_diligence_answer WHERE ic_packet_id = ?1 AND section_id = ?2",
  )
    .bind(packetId, input.section_id)
    .first<AnswerRow>())!;
}

// ── Route handlers ───────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof IcPortalError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

/** GET /api/ic/packets/:id/diligence — the framework, the answers, and what is still open. */
export async function handleGetDiligence(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  if (!packetId) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const packet = await requirePacket(ctx.env, packetId);
    const rows = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM ic_diligence_answer WHERE ic_packet_id = ?1",
    )
      .bind(packetId)
      .all<AnswerRow>();
    const answers = rows.results ?? [];
    const framework = sectionsFor(packet.sector);
    return json({
      packet: { id: packet.id, sector: packet.sector, champion_user_id: packet.champion_user_id, status: packet.status },
      framework: {
        core: framework.core,
        sector: framework.sector ?? null,
        closing_six: CLOSING_SIX,
      },
      answers,
      readiness: icReadiness(packet.sector, answers),
      // Sent so the client can disable the field rather than let someone write an answer the
      // server will reject — a refusal after typing 400 words is a bad way to learn a rule.
      restricted_section_ids: restrictedSectionIds(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/ic/packets/:id/diligence — save one section. */
export async function handleSaveDiligence(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  const parsed = answerSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!packetId || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await saveAnswer(ctx.env, actorFromIdentity(ctx.identity!), packetId, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const setupSchema = z.object({
  sector: z.enum(["AI", "HEALTH_TECH", "EDTECH", "CONSUMER", "B2B_SAAS", "FINTECH", "MARKETPLACE", "BIOTECH", "CYBERSECURITY", "OTHER"]).optional(),
  champion_user_id: z.string().max(80).nullish(),
});

/** POST /api/ic/packets/:id/setup — set sector and champion. */
export async function handleSetupPacket(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  const parsed = setupSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!packetId || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const packet = await requirePacket(ctx.env, packetId);
    const actor = actorFromIdentity(ctx.identity!);
    await mustAuthorize(ctx.env, actor, packet, "ic_packet.assemble");
    await ctx.env.WP_OS_DB.prepare(
      "UPDATE ic_packet SET sector = COALESCE(?2, sector), champion_user_id = COALESCE(?3, champion_user_id) WHERE id = ?1",
    )
      .bind(packetId, parsed.data.sector ?? null, parsed.data.champion_user_id ?? null)
      .run();
    await appendEvent(ctx.env, {
      eventType: "ic.packet_setup",
      actorType: "firm_user",
      actorId: actor.firmUserId ?? "system",
      objectType: "ic_packet",
      objectId: packetId,
      firmScope: packet.firm_scope,
      payload: { sector: parsed.data.sector, champion_user_id: parsed.data.champion_user_id },
    });
    return json(await requirePacket(ctx.env, packetId));
  } catch (err) {
    return errorResponse(err);
  }
}

const followupSchema = z.object({
  item_text: z.string().min(3).max(500),
  assignee_kind: z.enum(["AI_EMPLOYEE", "AI_WITH_HUMAN_TOUCH", "HUMAN_RECOMMENDED", "UNASSIGNED"]).default("UNASSIGNED"),
  ai_employee_id: z.string().max(80).nullish(),
  human_touch_reason: z.string().max(500).nullish(),
  due_date: z.string().max(40).nullish(),
});

/** GET /api/ic/packets/:id/followups */
export async function handleListFollowups(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  if (!packetId) return json({ error: "invalid_input" }, { status: 400 });
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM ic_followup WHERE ic_packet_id = ?1 ORDER BY created_at, id",
  )
    .bind(packetId)
    .all();
  return json({ followups: rows.results ?? [] });
}

/** POST /api/ic/packets/:id/followups */
export async function handleAddFollowup(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  const parsed = followupSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!packetId || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const packet = await requirePacket(ctx.env, packetId);
    const actor = actorFromIdentity(ctx.identity!);
    await mustAuthorize(ctx.env, actor, packet, "ic_packet.assemble");
    const id = `icf_${crypto.randomUUID()}`;
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO ic_followup (id, ic_packet_id, item_text, assignee_kind, ai_employee_id, human_touch_reason, due_date, firm_scope, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(id, packetId, parsed.data.item_text, parsed.data.assignee_kind, parsed.data.ai_employee_id ?? null,
            parsed.data.human_touch_reason ?? null, parsed.data.due_date ?? null, packet.firm_scope,
            actor.firmUserId ?? "system")
      .run();
    const rows = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM ic_followup WHERE ic_packet_id = ?1 ORDER BY created_at, id",
    )
      .bind(packetId)
      .all();
    return json({ followups: rows.results ?? [] }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * GET /api/ic/packets/:id/audit — the Audit tab.
 *
 * Every event ever appended against this packet, oldest first. Read straight from the append-only
 * event log rather than a summary table: a curated audit trail is one somebody chose the contents
 * of, which defeats the point.
 */
export async function handleGetIcAudit(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  if (!packetId) return json({ error: "invalid_input" }, { status: 400 });
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT event_type, actor_type, actor_id, payload_json, created_at
       FROM event_record
      WHERE object_type = 'ic_packet' AND object_id = ?1
      ORDER BY created_at, id`,
  )
    .bind(packetId)
    .all();
  return json({ events: rows.results ?? [] });
}

/**
 * GET /api/ic/packets/:id/records — what the Company, Memo, Market, People and Decision tabs show.
 *
 * One endpoint rather than five, because the tabs are five views of one deal and five round trips
 * to render one screen is a slow screen. Everything here already exists elsewhere in the system;
 * this assembles it against the packet so an IC does not have to.
 */
export async function handleGetIcRecords(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  if (!packetId) return json({ error: "invalid_input" }, { status: 400 });

  const packet = await ctx.env.WP_OS_DB.prepare(
    `SELECT p.id, p.opportunity_id, p.sector, p.champion_user_id, p.status, p.evidence_summary_json,
            p.unresolved_contradictions_json, o.title AS opportunity_title, o.status AS opportunity_status,
            o.company_id, c.canonical_name, c.website, c.description
       FROM ic_packet p
       LEFT JOIN investment_opportunity o ON o.id = p.opportunity_id
       LEFT JOIN canonical_company c ON c.id = o.company_id
      WHERE p.id = ?1`,
  )
    .bind(packetId)
    .first<Record<string, unknown>>();
  if (!packet) return json({ error: "not_found" }, { status: 404 });

  const companyId = packet.company_id ? String(packet.company_id) : null;
  const q = async (sql: string, ...binds: unknown[]) =>
    (await ctx.env.WP_OS_DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results ?? [];

  const [claims, metrics, dealMath, decisions, people, marketRows] = await Promise.all([
    // MEMO — the evidence the case rests on, newest first, superseded ones excluded.
    companyId
      ? q(`SELECT c.id, c.claim_text, c.claim_status, c.confidence, c.created_at,
                  (SELECT COUNT(*) FROM claim_source s WHERE s.claim_id = c.id) AS source_count
             FROM diligence_claim c
            WHERE c.company_id = ?1 AND c.superseded_by IS NULL
            ORDER BY c.created_at DESC LIMIT 40`, companyId)
      : Promise.resolve([]),
    // COMPANY — the latest reading of each metric.
    companyId
      ? q(`SELECT m.metric_key, m.value, m.as_of_date, m.source
             FROM portfolio_metric_snapshot m
             JOIN (SELECT metric_key, MAX(as_of_date) AS latest FROM portfolio_metric_snapshot
                    WHERE company_id = ?1 GROUP BY metric_key) x
               ON x.metric_key = m.metric_key AND x.latest = m.as_of_date
            WHERE m.company_id = ?1 ORDER BY m.metric_key`, companyId)
      : Promise.resolve([]),
    // COMPANY — the arithmetic, if a deal math packet was assembled.
    q(`SELECT id, deal_type, valuation, check_size, ownership_at_close, expected_exit_ownership, created_at
         FROM deal_math_packet WHERE opportunity_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      String(packet.opportunity_id ?? "")),
    // DECISION — append-only, so this is the whole history rather than the latest state.
    q(`SELECT id, decision, rationale, decided_by, created_at FROM ic_decision WHERE ic_packet_id = ?1 ORDER BY created_at`,
      packetId),
    // PEOPLE — founders and contacts the firm has on this company.
    companyId
      ? q(`SELECT p.id, p.full_name, p.email, r.relationship_type
             FROM organization_relationship r
             JOIN person p ON p.id = r.person_id
            WHERE r.company_id = ?1 LIMIT 40`, companyId)
      : Promise.resolve([]),
    // MARKET — the most recent map covering this packet's sector, if one has been built.
    q(`SELECT id, sector, company_count, coverage_note, created_at FROM mkt_map
        WHERE LOWER(sector) LIKE ?1 ORDER BY created_at DESC LIMIT 1`,
      `%${String(packet.sector ?? "").toLowerCase()}%`),
  ]);

  return json({
    packet,
    company: { metrics, deal_math: dealMath[0] ?? null },
    memo: { claims, unsourced: claims.filter((c) => Number(c.source_count ?? 0) === 0).length },
    market: marketRows[0] ?? null,
    people,
    decisions,
  });
}
