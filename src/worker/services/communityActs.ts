import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import {
  ACT_KINDS,
  ACT_SOURCES,
  type CommunityAct,
  describeEvidence,
  summariseEvidence,
  validateCouncilDecision,
} from "../../shared/community/acts";

/**
 * Community acts and the Council — Waverly's desk (P51, docs/COMMUNITY.md).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. There is no member ranking endpoint, no "ready for Council"
 * queue, no participation score and no engagement dashboard. Each of those is a status ladder in a
 * different costume, and the Council is defined by the document as not being one.
 *
 * What it does: record what West Peek witnessed, and assemble it for a partner to read.
 *
 * WHY ONLY WITNESSED ACTS. A member promising another member an introduction is between those two
 * members (operator, 17 Aug 2026). The OS does not track interactions West Peek is not part of, so
 * "follow-through" here means follow-through on a commitment made TO West Peek.
 */

export class CommunityError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

const recordSchema = z.object({
  person_id: z.string().min(3).max(80),
  kind: z.enum(ACT_KINDS),
  source: z.enum(ACT_SOURCES).default("PARTNER_ENTRY"),
  occurred_at: z.string().min(8).max(40),
  event_id: z.string().max(80).nullish(),
  note: z.string().max(1000).nullish(),
});

export async function recordAct(env: Env, actor: Actor, input: z.infer<typeof recordSchema>): Promise<{ id: string }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "community.act", { objectType: "com_act", firmScope });
  if (authz.decision !== "ALLOW") throw new CommunityError(403, "forbidden", authz.reason);

  const person = await env.WP_OS_DB.prepare("SELECT id FROM person WHERE id = ?1").bind(input.person_id).first();
  if (!person) throw new CommunityError(404, "unknown_person", "an act must attach to a real person record");

  const id = `cma_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO com_act (id, person_id, kind, source, occurred_at, event_id, note, recorded_by, firm_scope)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  )
    .bind(id, input.person_id, input.kind, input.source, input.occurred_at, input.event_id ?? null,
          input.note ?? null, actor.firmUserId ?? actor.aiEmployeeId ?? "system", firmScope)
    .run();

  await appendEvent(env, {
    eventType: "community.act_recorded",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "com_act", objectId: id, firmScope,
    payload: { person_id: input.person_id, kind: input.kind },
  });
  return { id };
}

/**
 * Retract rather than delete.
 *
 * The table refuses both DELETE and any UPDATE that changes what happened, so a mis-keyed act is
 * corrected by retracting it and recording the right one. Evidence a partner may act on should not
 * be silently rewritable.
 */
export async function retractAct(env: Env, actor: Actor, id: string, reason: string): Promise<void> {
  if (actor.type !== "HUMAN") throw new CommunityError(403, "human_required", "Only a person retracts a record of what someone did.");
  if (reason.trim().length < 5) throw new CommunityError(400, "reason_required", "Say why it is being retracted.");

  const result = await env.WP_OS_DB.prepare(
    `UPDATE com_act SET retracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), retracted_by = ?2, retraction_reason = ?3
     WHERE id = ?1 AND retracted_at IS NULL`,
  ).bind(id, actor.firmUserId ?? "system", reason).run();
  if (!result.meta.changes) throw new CommunityError(404, "not_found", "no such act, or it is already retracted");
}

/** Load a member's unretracted acts and group them. Returns evidence, never a verdict. */
export async function evidenceFor(env: Env, personId: string): Promise<{
  evidence: ReturnType<typeof summariseEvidence>;
  summary: string;
  inCouncil: boolean;
  councilReason: string | null;
  acts: CommunityAct[];
}> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, person_id, kind, source, occurred_at, event_id, note
     FROM com_act WHERE person_id = ?1 AND retracted_at IS NULL ORDER BY occurred_at DESC`,
  ).bind(personId).all<{
    id: string; person_id: string; kind: string; source: string;
    occurred_at: string; event_id: string | null; note: string | null;
  }>();

  const acts: CommunityAct[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    personId: r.person_id,
    kind: r.kind as CommunityAct["kind"],
    source: r.source as CommunityAct["source"],
    occurredAt: r.occurred_at,
    eventId: r.event_id,
    note: r.note,
  }));

  const latest = await env.WP_OS_DB.prepare(
    "SELECT in_council, reason FROM com_council_decision WHERE person_id = ?1 ORDER BY decided_at DESC LIMIT 1",
  ).bind(personId).first<{ in_council: number; reason: string }>();

  const evidence = summariseEvidence(personId, acts);
  return {
    evidence,
    summary: describeEvidence(evidence),
    inCouncil: Number(latest?.in_council ?? 0) === 1,
    councilReason: latest?.reason ?? null,
    acts,
  };
}

/**
 * Record a Council decision. HUMAN ONLY, and a reason is required.
 *
 * There is no eligibility check to pass and no threshold to cross. The document is explicit that
 * Council membership emerges from participation and is not an application; the code's job is to
 * make the judgement legible a year later, not to make it automatic.
 */
export async function decideCouncil(
  env: Env,
  actor: Actor,
  input: { personId: string; inCouncil: boolean; reason: string },
): Promise<void> {
  if (actor.type !== "HUMAN") {
    throw new CommunityError(403, "human_required", "The Council is a human judgement. No employee, and no threshold, decides it.");
  }
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "council.decide", { objectType: "com_council_decision", firmScope });
  if (authz.decision !== "ALLOW") throw new CommunityError(403, "forbidden", authz.reason);

  const valid = validateCouncilDecision({ ...input, decidedBy: actor.firmUserId ?? "system" });
  if (!valid.ok) throw new CommunityError(400, "invalid_input", valid.error);

  const id = `ccd_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO com_council_decision (id, person_id, in_council, reason, decided_by, firm_scope) VALUES (?1,?2,?3,?4,?5,?6)",
  ).bind(id, input.personId, input.inCouncil ? 1 : 0, input.reason, actor.firmUserId ?? "system", firmScope).run();

  await appendEvent(env, {
    eventType: input.inCouncil ? "council.joined" : "council.left",
    actorType: "firm_user", actorId: actor.firmUserId ?? "system",
    objectType: "com_council_decision", objectId: id, firmScope,
    payload: { person_id: input.personId },
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof CommunityError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleRecordAct(ctx: RouteContext): Promise<Response> {
  const parsed = recordSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordAct(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleRetractAct(ctx: RouteContext): Promise<Response> {
  const body = await ctx.request.json().catch(() => null) as { reason?: string } | null;
  if (!ctx.params.id || !body?.reason) return json({ error: "invalid_input" }, { status: 400 });
  try {
    await retractAct(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, body.reason);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

export async function handleMemberEvidence(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await evidenceFor(ctx.env, ctx.params.id));
  } catch (err) {
    return fail(err);
  }
}

const councilSchema = z.object({
  person_id: z.string().min(3).max(80),
  in_council: z.boolean(),
  reason: z.string().min(10).max(1000),
});

export async function handleDecideCouncil(ctx: RouteContext): Promise<Response> {
  const parsed = councilSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    await decideCouncil(ctx.env, actorFromIdentity(ctx.identity!), {
      personId: parsed.data.person_id,
      inCouncil: parsed.data.in_council,
      reason: parsed.data.reason,
    });
    return json({ ok: true }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

/**
 * The members list.
 *
 * Ordered by most recent activity, NOT by how much anyone has done. Sorting by contribution would
 * make the list a leaderboard, which is the thing this module exists not to build. Each row carries
 * the unranked one-line description from describeEvidence().
 */
export async function handleListMembers(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT m.id, m.person_id, m.display_name, m.member_type, m.status, m.joined_at, m.notes,
            (SELECT MAX(a.occurred_at) FROM com_act a WHERE a.person_id = m.person_id AND a.retracted_at IS NULL) AS last_act_at,
            (SELECT c.in_council FROM com_council_decision c WHERE c.person_id = m.person_id ORDER BY c.decided_at DESC LIMIT 1) AS in_council
     FROM com_member m
     WHERE m.status <> 'REMOVED'
     ORDER BY last_act_at DESC NULLS LAST, m.display_name
     LIMIT 500`,
  ).all<{ person_id: string | null; in_council: number | null }>();

  const members = [];
  for (const row of rows.results ?? []) {
    let summary = "no recorded participation yet";
    if (row.person_id) summary = (await evidenceFor(ctx.env, row.person_id)).summary;
    members.push({ ...row, in_council: Number(row.in_council ?? 0) === 1, summary });
  }
  return json({ members });
}
