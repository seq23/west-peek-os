import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { type MatchCandidate, pairKey, proposeMatches } from "../../shared/relationships/matching";

/**
 * Introductions West Peek proposes (P51, docs/COMMUNITY.md).
 *
 * WHERE THE SIGNAL COMES FROM. Two places, combined:
 *
 *   1. `rel_signal` — what a partner wrote down. "Ada is looking for a job." This is the one that
 *      makes the feature work in a month when no Mastermind ran, which is most months.
 *   2. `com_act` — questions asked and answers given at a gathering, which are needs and
 *      experience generated as a by-product of the community being used.
 *
 * The second is better data and the first is the one that actually exists, so both feed the same
 * matcher rather than one being a fallback for the other.
 *
 * EVERYTHING STALE IS EXCLUDED IN SQL, not filtered afterwards. A signal past its expiry should
 * never reach the matcher at all — the failure this prevents is proposing an introduction based on
 * a job hunt that ended a year ago, in front of the person it is about.
 */

export class MatchError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

/** How long a hand-written signal stays live without being renewed. */
export const DEFAULT_SIGNAL_DAYS = 120;

const signalSchema = z.object({
  person_id: z.string().min(3).max(80),
  kind: z.enum(["NEED", "OFFER"]),
  body: z.string().min(8).max(500),
  expires_in_days: z.number().int().min(1).max(730).optional(),
  event_id: z.string().max(80).nullish(),
});

/** Write down something known about a person, so a match can use it. */
export async function recordSignal(env: Env, actor: Actor, input: z.infer<typeof signalSchema>): Promise<{ id: string; expiresAt: string }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "match.manage", { objectType: "rel_signal", firmScope });
  if (authz.decision !== "ALLOW") throw new MatchError(403, "forbidden", authz.reason);

  const person = await env.WP_OS_DB.prepare("SELECT id FROM person WHERE id = ?1").bind(input.person_id).first();
  if (!person) throw new MatchError(404, "unknown_person", "a signal must attach to a real person record");

  const days = input.expires_in_days ?? DEFAULT_SIGNAL_DAYS;
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const id = `rsg_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO rel_signal (id, person_id, kind, body, source, event_id, expires_at, recorded_by, firm_scope)
     VALUES (?1,?2,?3,?4,'PARTNER_ENTRY',?5,?6,?7,?8)`,
  ).bind(id, input.person_id, input.kind, input.body, input.event_id ?? null, expiresAt,
         actor.firmUserId ?? actor.aiEmployeeId ?? "system", firmScope).run();

  await appendEvent(env, {
    eventType: "relationship.signal_recorded",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "rel_signal", objectId: id, firmScope,
    payload: { person_id: input.person_id, kind: input.kind },
  });
  return { id, expiresAt };
}

/** Retire a signal early — they took the job, they found the cofounder. */
export async function retireSignal(env: Env, actor: Actor, id: string): Promise<void> {
  const result = await env.WP_OS_DB.prepare(
    `UPDATE rel_signal SET retired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), retired_by = ?2
     WHERE id = ?1 AND retired_at IS NULL`,
  ).bind(id, actor.firmUserId ?? "system").run();
  if (!result.meta.changes) throw new MatchError(404, "not_found", "no such live signal");
}

/**
 * Assemble candidates from live signals and recorded acts.
 *
 * The expiry and retirement filters are in the SQL rather than in TypeScript so that every future
 * reader of this data inherits them. A stale signal is not a low-scoring signal; it is one that
 * should not be considered at all.
 */
export async function loadCandidates(env: Env, firmScope: string): Promise<MatchCandidate[]> {
  const signals = await env.WP_OS_DB.prepare(
    `SELECT s.person_id, s.kind, s.body, p.full_name
     FROM rel_signal s JOIN person p ON p.id = s.person_id
     WHERE s.firm_scope = ?1
       AND s.retired_at IS NULL
       AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).bind(firmScope).all<{ person_id: string; kind: string; body: string; full_name: string }>();

  // Questions asked are needs; answers given, and anything hosted or spoken on, are experience.
  const acts = await env.WP_OS_DB.prepare(
    `SELECT a.person_id, a.kind, a.note, p.full_name
     FROM com_act a JOIN person p ON p.id = a.person_id
     WHERE a.retracted_at IS NULL AND a.note IS NOT NULL
       AND a.kind IN ('ASKED_QUESTION','ANSWERED_QUESTION','HOSTED','SPOKE')
       AND a.occurred_at > date('now','-18 months')`,
  ).all<{ person_id: string; kind: string; note: string; full_name: string }>();

  const byPerson = new Map<string, MatchCandidate>();
  const ensure = (id: string, name: string): MatchCandidate => {
    let c = byPerson.get(id);
    if (!c) {
      c = { personId: id, displayName: name, needs: [], experience: [] };
      byPerson.set(id, c);
    }
    return c;
  };

  for (const s of signals.results ?? []) {
    const c = ensure(s.person_id, s.full_name);
    (s.kind === "NEED" ? c.needs : c.experience).push(s.body);
  }
  for (const a of acts.results ?? []) {
    const c = ensure(a.person_id, a.full_name);
    (a.kind === "ASKED_QUESTION" ? c.needs : c.experience).push(a.note);
  }
  return [...byPerson.values()];
}

export interface RunResult {
  created: number;
  considered: number;
  detail: string;
}

/** Propose introductions. Writes suggestions; sends nothing. */
export async function runMatching(env: Env, actor: Actor): Promise<RunResult> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "match.manage", { objectType: "rel_match_suggestion", firmScope });
  if (authz.decision !== "ALLOW") throw new MatchError(403, "forbidden", authz.reason);

  const candidates = await loadCandidates(env, firmScope);

  // Every pair ever proposed, in either order — including dismissed ones. A pair a partner already
  // killed must stay killed, or the same bad idea returns every month.
  const seen = await env.WP_OS_DB.prepare("SELECT person_a_id, person_b_id FROM rel_match_suggestion").all<{ person_a_id: string; person_b_id: string }>();
  const already = new Set((seen.results ?? []).map((r) => pairKey(r.person_a_id, r.person_b_id)));

  const matches = proposeMatches(candidates, already);

  for (const m of matches) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO rel_match_suggestion
         (id, person_a_id, person_b_id, rationale, need_signal, experience_signal, strength, firm_scope)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(`rms_${crypto.randomUUID()}`, m.personAId, m.personBId, m.rationale, m.needSignal,
           m.experienceSignal, m.strength, firmScope).run();
  }

  return {
    created: matches.length,
    considered: candidates.length,
    detail: matches.length === 0
      // A quiet month is the designed outcome, not a failure. Say so, or someone "fixes" it.
      ? `Nothing worth proposing from ${candidates.length} people. That is the normal result — this only speaks up when a match is obvious.`
      : `${matches.length} introduction(s) worth considering.`,
  };
}

/** A partner approves a suggestion. The introduction itself is still theirs to make. */
export async function decideMatch(
  env: Env,
  actor: Actor,
  id: string,
  decision: "APPROVE" | "DISMISS",
  reason?: string,
): Promise<void> {
  if (actor.type !== "HUMAN") {
    throw new MatchError(403, "human_required", "An introduction is made by a person. Nothing here sends one.");
  }
  const authz = await authorize(env, actor, "match.manage", { objectType: "rel_match_suggestion", objectId: id, firmScope: actor.firmScopes[0] ?? "west-peek" });
  if (authz.decision !== "ALLOW") throw new MatchError(403, "forbidden", authz.reason);

  const sql = decision === "APPROVE"
    ? `UPDATE rel_match_suggestion SET status = 'CONSENT_PENDING', approved_by = ?2,
         approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND status = 'PROPOSED'`
    : `UPDATE rel_match_suggestion SET status = 'DISMISSED', dismissed_reason = ?3 WHERE id = ?1 AND status = 'PROPOSED'`;

  const result = await env.WP_OS_DB.prepare(sql).bind(id, actor.firmUserId ?? "system", reason ?? null).run();
  if (!result.meta.changes) throw new MatchError(409, "illegal_state", "no such suggestion, or it has already been decided");
}

/**
 * Record that one side said yes.
 *
 * Double opt-in: asking both before connecting. A cold connection made in West Peek's name that
 * either side resents costs more than the introduction was worth.
 */
export async function recordConsent(env: Env, actor: Actor, id: string, side: "A" | "B"): Promise<{ status: string }> {
  if (actor.type !== "HUMAN") throw new MatchError(403, "human_required", "A person heard the answer; a person records it.");
  const column = side === "A" ? "consent_a" : "consent_b";
  await env.WP_OS_DB.prepare(`UPDATE rel_match_suggestion SET ${column} = 1 WHERE id = ?1`).bind(id).run();

  // Both sides in: the suggestion is ready for a person to actually write the introduction.
  await env.WP_OS_DB.prepare(
    `UPDATE rel_match_suggestion SET status = 'CONSENTED'
     WHERE id = ?1 AND consent_a = 1 AND consent_b = 1 AND status = 'CONSENT_PENDING'`,
  ).bind(id).run();

  const row = await env.WP_OS_DB.prepare("SELECT status FROM rel_match_suggestion WHERE id = ?1").bind(id).first<{ status: string }>();
  if (!row) throw new MatchError(404, "not_found", "no such suggestion");
  return row;
}

/** Mark the introduction as actually made, and record it as an act for both people. */
export async function markConnected(env: Env, actor: Actor, id: string): Promise<void> {
  if (actor.type !== "HUMAN") throw new MatchError(403, "human_required", "Only the person who made the introduction can record it.");
  const row = await env.WP_OS_DB.prepare(
    "SELECT person_a_id, person_b_id, status, firm_scope FROM rel_match_suggestion WHERE id = ?1",
  ).bind(id).first<{ person_a_id: string; person_b_id: string; status: string; firm_scope: string }>();
  if (!row) throw new MatchError(404, "not_found", "no such suggestion");
  if (row.status !== "CONSENTED") throw new MatchError(409, "illegal_state", "both sides consent before an introduction is made");

  await env.WP_OS_DB.prepare(
    "UPDATE rel_match_suggestion SET status = 'CONNECTED', connected_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(id).run();

  await appendEvent(env, {
    eventType: "relationship.introduced",
    actorType: "firm_user", actorId: actor.firmUserId ?? "system",
    objectType: "rel_match_suggestion", objectId: id, firmScope: row.firm_scope,
    payload: { a: row.person_a_id, b: row.person_b_id },
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof MatchError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleRecordSignal(ctx: RouteContext): Promise<Response> {
  const parsed = signalSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordSignal(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleRetireSignal(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    await retireSignal(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

export async function handleListSignals(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT s.id, s.person_id, p.full_name, s.kind, s.body, s.recorded_at, s.expires_at,
            CASE WHEN s.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END AS expired
     FROM rel_signal s JOIN person p ON p.id = s.person_id
     WHERE s.retired_at IS NULL
     ORDER BY expired, s.recorded_at DESC LIMIT 200`,
  ).all();
  return json({ signals: rows.results ?? [] });
}

export async function handleRunMatching(ctx: RouteContext): Promise<Response> {
  try {
    return json(await runMatching(ctx.env, actorFromIdentity(ctx.identity!)));
  } catch (err) {
    return fail(err);
  }
}

export async function handleListMatches(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT m.id, m.person_a_id, m.person_b_id, m.rationale, m.need_signal, m.experience_signal,
            m.strength, m.status, m.consent_a, m.consent_b, m.approved_by, m.created_at,
            a.full_name AS person_a_name, b.full_name AS person_b_name
     FROM rel_match_suggestion m
     JOIN person a ON a.id = m.person_a_id
     JOIN person b ON b.id = m.person_b_id
     WHERE m.status <> 'EXPIRED'
     ORDER BY CASE m.status WHEN 'CONSENTED' THEN 0 WHEN 'CONSENT_PENDING' THEN 1
                            WHEN 'PROPOSED' THEN 2 WHEN 'CONNECTED' THEN 3 ELSE 4 END,
              m.strength DESC
     LIMIT 100`,
  ).all();
  return json({ matches: rows.results ?? [] });
}

const decideSchema = z.object({ decision: z.enum(["APPROVE", "DISMISS"]), reason: z.string().max(500).optional() });

export async function handleDecideMatch(ctx: RouteContext): Promise<Response> {
  const parsed = decideSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    await decideMatch(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, parsed.data.decision, parsed.data.reason);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

export async function handleMatchConsent(ctx: RouteContext): Promise<Response> {
  const body = await ctx.request.json().catch(() => null) as { side?: "A" | "B" } | null;
  if (!ctx.params.id || (body?.side !== "A" && body?.side !== "B")) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await recordConsent(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, body.side));
  } catch (err) {
    return fail(err);
  }
}

export async function handleMatchConnected(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    await markConnected(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

/**
 * People to attach a note to.
 *
 * Names and ids only. This feeds a picker, and a picker does not need email addresses — the less
 * that travels to the client, the less there is to leak from it.
 */
export async function handleListPeople(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, full_name FROM person ORDER BY full_name LIMIT 500",
  ).all();
  return json({ people: rows.results ?? [] });
}
