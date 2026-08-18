import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import {
  buildSponsorRecap,
  canExportAttendees,
  sponsorPolicyFailure,
  type MemberIdentity,
} from "../../shared/community/sponsorPolicy";

/**
 * The Room sponsorship pipeline — Wynn's desk (P51, docs/COMMUNITY.md).
 *
 * Rooms are the primary monetization layer, so a sponsor is a prospect moving through stages, not a
 * logo on a page. The pilot's shape is one presenting partner, one supporting partner, one in-kind
 * partner, targeting $30–45k.
 *
 * TWO RULES LIVE HERE BECAUSE THEY CANNOT LIVE IN THE SCHEMA:
 *
 *   1. CATEGORY EXCLUSIVITY. "Brex is a credible alternate to Ramp, but I would not put both in the
 *      same Room — they occupy competing categories." That depends on the event, so a CHECK cannot
 *      express it. Enforced on assignment, as a refusal rather than a warning, because a warning in
 *      a pipeline is read once and then never again.
 *
 *   2. NOTHING ABOUT MEMBERS GOES OUT. Every sponsor-facing payload runs through the policy in
 *      shared/community/sponsorPolicy.ts. Sponsor staff attend Rooms — that is the product — but no
 *      attendee list, export or follow-up file ever leaves.
 */

export class SponsorError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

export interface SponsorRow {
  id: string;
  org_name: string;
  tier: string;
  category: string;
  ask_low_usd: number | null;
  ask_high_usd: number | null;
  pitch: string | null;
  ask_detail: string | null;
  stage: string;
  packet_id: string | null;
  event_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  committed_usd: number | null;
  decline_reason: string | null;
  note: string | null;
  owner_employee: string;
  firm_scope: string;
}

async function requireSponsor(env: Env, id: string): Promise<SponsorRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM evt_sponsor_prospect WHERE id = ?1").bind(id).first<SponsorRow>();
  if (!row) throw new SponsorError(404, "not_found", "no such sponsor prospect");
  return row;
}

/**
 * Refuse a second sponsor in the same category on the same Room.
 *
 * IN_KIND is exempt: a hospitality partner underwriting the venue does not compete with a cloud
 * partner, and in practice the in-kind slot is where a venue or a caterer sits.
 */
export async function checkCategoryConflict(
  env: Env,
  eventId: string,
  category: string,
  tier: string,
  excludeId?: string,
): Promise<string | null> {
  if (tier === "IN_KIND" || category === "OTHER") return null;
  const row = await env.WP_OS_DB.prepare(
    `SELECT org_name FROM evt_sponsor_prospect
     WHERE event_id = ?1 AND category = ?2 AND tier <> 'IN_KIND'
       AND stage NOT IN ('DECLINED','PARKED') AND id <> ?3`,
  ).bind(eventId, category, excludeId ?? "").first<{ org_name: string }>();

  return row
    ? `${row.org_name} already holds the ${category} category for this Room. Two sponsors in one category makes the Room feel crowded and puts competitors at the same table.`
    : null;
}

const createSchema = z.object({
  org_name: z.string().min(2).max(160),
  tier: z.enum(["PRESENTING", "SUPPORTING", "IN_KIND"]).default("SUPPORTING"),
  category: z.enum(["CLOUD", "FINTECH_SPEND", "EQUITY_CAPTABLE", "LEGAL", "PAYROLL_HR", "BANKING", "HOSPITALITY", "RECRUITING", "OTHER"]).default("OTHER"),
  ask_low_usd: z.number().min(0).max(1_000_000).nullish(),
  ask_high_usd: z.number().min(0).max(1_000_000).nullish(),
  pitch: z.string().max(500).nullish(),
  ask_detail: z.string().max(2000).nullish(),
  packet_id: z.string().max(80).nullish(),
  event_id: z.string().max(80).nullish(),
  contact_name: z.string().max(160).nullish(),
  contact_email: z.string().max(200).nullish(),
  contact_url: z.string().max(500).nullish(),
  source_url: z.string().max(500).nullish(),
  note: z.string().max(2000).nullish(),
});

export async function createSponsor(env: Env, actor: Actor, input: z.infer<typeof createSchema>): Promise<SponsorRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "sponsor.manage", { objectType: "sponsor_prospect", firmScope });
  if (authz.decision !== "ALLOW") throw new SponsorError(403, "forbidden", authz.reason);

  if (input.event_id) {
    const conflict = await checkCategoryConflict(env, input.event_id, input.category, input.tier);
    if (conflict) throw new SponsorError(409, "category_conflict", conflict);
  }

  const id = `spn_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_sponsor_prospect
       (id, org_name, tier, category, ask_low_usd, ask_high_usd, pitch, ask_detail, packet_id,
        event_id, contact_name, contact_email, contact_url, source_url, note, firm_scope, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
  )
    .bind(
      id, input.org_name, input.tier, input.category, input.ask_low_usd ?? null,
      input.ask_high_usd ?? null, input.pitch ?? null, input.ask_detail ?? null,
      input.packet_id ?? null, input.event_id ?? null, input.contact_name ?? null,
      input.contact_email ?? null, input.contact_url ?? null, input.source_url ?? null,
      input.note ?? null, firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "Wynn",
    )
    .run();

  await appendEvent(env, {
    eventType: "sponsor.identified",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Wynn",
    objectType: "sponsor_prospect", objectId: id, firmScope,
    payload: { org: input.org_name, tier: input.tier },
  });
  return await requireSponsor(env, id);
}

const STAGES = ["IDENTIFIED", "RESEARCHING", "DRAFTED", "SENT", "IN_CONVERSATION", "COMMITTED", "DECLINED", "PARKED"] as const;

/**
 * Move a prospect along.
 *
 * COMMITTED requires a human. Recording that a sponsor has committed $25,000 is a claim about money
 * the firm expects, and it flows into the Room's economics — an AI employee inferring a commitment
 * from an enthusiastic reply would put an invented number in a budget.
 */
export async function advanceSponsor(
  env: Env,
  actor: Actor,
  id: string,
  input: { stage: (typeof STAGES)[number]; committed_usd?: number | null; decline_reason?: string | null; note?: string | null },
): Promise<SponsorRow> {
  const sponsor = await requireSponsor(env, id);
  const authz = await authorize(env, actor, "sponsor.manage", {
    objectType: "sponsor_prospect", objectId: id, firmScope: sponsor.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new SponsorError(403, "forbidden", authz.reason);

  if (input.stage === "COMMITTED" && actor.type !== "HUMAN") {
    throw new SponsorError(403, "human_required", "A commitment is recorded by a person — it puts real money into a Room's budget.");
  }
  if (input.stage === "COMMITTED" && (input.committed_usd ?? 0) <= 0) {
    throw new SponsorError(400, "amount_required", "A commitment needs the amount committed.");
  }
  if (input.stage === "DECLINED" && !input.decline_reason) {
    throw new SponsorError(400, "reason_required", "Record why they declined — it is the most useful thing for the next Room.");
  }

  await env.WP_OS_DB.prepare(
    `UPDATE evt_sponsor_prospect SET stage = ?2, committed_usd = ?3, decline_reason = ?4,
            note = COALESCE(?5, note), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?1`,
  ).bind(id, input.stage, input.committed_usd ?? sponsor.committed_usd, input.decline_reason ?? null, input.note ?? null).run();

  await appendEvent(env, {
    eventType: "sponsor.stage_changed",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Wynn",
    objectType: "sponsor_prospect", objectId: id, firmScope: sponsor.firm_scope,
    payload: { from: sponsor.stage, to: input.stage },
  });
  return await requireSponsor(env, id);
}

/**
 * The wrap a sponsor may receive after a Room.
 *
 * Built by naming the permitted fields rather than by filtering an event record, then checked
 * again by the policy before it is returned. Belt and braces on purpose: the shape is safe by
 * construction, and the check catches the case where a person or a model wrote prose into `themes`
 * that names somebody.
 */
export async function buildRecap(
  env: Env,
  actor: Actor,
  eventId: string,
  themes: string[] = [],
): Promise<ReturnType<typeof buildSponsorRecap>> {
  const event = await env.WP_OS_DB.prepare(
    "SELECT title, starts_at, firm_scope FROM evt_event WHERE id = ?1",
  ).bind(eventId).first<{ title: string; starts_at: string | null; firm_scope: string }>();
  if (!event) throw new SponsorError(404, "not_found", "no such event");

  const authz = await authorize(env, actor, "sponsor.manage", {
    objectType: "event", objectId: eventId, firmScope: event.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new SponsorError(403, "forbidden", authz.reason);

  const attendees = await env.WP_OS_DB.prepare(
    "SELECT attendee_role, display_name, person_id FROM evt_attendee WHERE event_id = ?1 AND rsvp = 'ATTENDED'",
  ).bind(eventId).all<{ attendee_role: string; display_name: string; person_id: string | null }>();

  const rows = attendees.results ?? [];
  const recap = buildSponsorRecap({
    eventTitle: event.title,
    eventDate: event.starts_at,
    attendeeRoles: rows.map((r) => r.attendee_role),
    themes,
  });

  const members: MemberIdentity[] = rows.map((r) => ({ personId: r.person_id, displayName: r.display_name }));
  const failure = sponsorPolicyFailure("SPONSOR", recap, members);
  if (failure) {
    // Refuse rather than redact. A silent redaction teaches nobody, and the next payload assembled
    // the same way would go out through a path that has no check.
    throw new SponsorError(422, "sponsor_policy", failure);
  }
  return recap;
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof SponsorError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleListSponsors(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, org_name, tier, category, stage, ask_low_usd, ask_high_usd, committed_usd, pitch,
            packet_id, event_id, contact_name, owner_employee, decline_reason, note, created_at
     FROM evt_sponsor_prospect ORDER BY
       CASE stage WHEN 'COMMITTED' THEN 0 WHEN 'IN_CONVERSATION' THEN 1 WHEN 'SENT' THEN 2
                  WHEN 'DRAFTED' THEN 3 WHEN 'RESEARCHING' THEN 4 WHEN 'IDENTIFIED' THEN 5
                  WHEN 'PARKED' THEN 6 ELSE 7 END,
       created_at DESC
     LIMIT 200`,
  ).all();

  const totals = await ctx.env.WP_OS_DB.prepare(
    "SELECT COALESCE(SUM(committed_usd),0) AS committed FROM evt_sponsor_prospect WHERE stage = 'COMMITTED'",
  ).first<{ committed: number }>();

  return json({ sponsors: rows.results ?? [], committedUsd: totals?.committed ?? 0 });
}

export async function handleCreateSponsor(ctx: RouteContext): Promise<Response> {
  const parsed = createSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createSponsor(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

const advanceSchema = z.object({
  stage: z.enum(STAGES),
  committed_usd: z.number().min(0).max(1_000_000).nullish(),
  decline_reason: z.string().max(1000).nullish(),
  note: z.string().max(2000).nullish(),
});

export async function handleAdvanceSponsor(ctx: RouteContext): Promise<Response> {
  const parsed = advanceSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await advanceSponsor(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, parsed.data));
  } catch (err) {
    return fail(err);
  }
}

export async function handleSponsorRecap(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const themes = new URL(ctx.request.url).searchParams.getAll("theme");
    return json(await buildRecap(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, themes));
  } catch (err) {
    return fail(err);
  }
}

/**
 * The route that exists in order to refuse.
 *
 * Someone will look for an attendee export. Better they find a 403 that explains the policy and
 * points at the recap than that they find nothing, assume it was an oversight, and write one.
 */
export async function handleSponsorAttendeeExport(ctx: RouteContext): Promise<Response> {
  const refusal = canExportAttendees("SPONSOR")!;
  return json({ error: refusal.code, detail: refusal.detail }, { status: 403 });
}
