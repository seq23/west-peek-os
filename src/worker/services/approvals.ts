import { z } from "zod";
import { assessRisk, expiryHours, recommendApprover } from "../../shared/approvals/risk";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { notifyQuietly } from "./notifications";
import {
  actorFromIdentity,
  authorize,
  getActionType,
  getApprovalCard,
  requiredApproverRolesFor,
  type Actor,
  type ApprovalCardRow,
} from "./authorize";

/**
 * Approval cards (P3): the human-judgment substrate. AI prepares; humans decide.
 *
 * State machine (enforced HERE, not just documented):
 *   drafted → pending_review → approved | rejected | revise_requested
 *   revise_requested → pending_review   (resubmit after revision)
 *   approved → executed | blocked       (executed === consumed receipt; 'sent' is a
 *                                        comms-facing alias of executed, never stored)
 * Everything else is illegal and rejected with 409.
 *
 * Decision rules:
 * - Only HUMAN actors decide. AI/SYSTEM can request but can NEVER decide — an AI
 *   can never approve its own (or anyone's) work.
 * - The decider must hold at least one of the card's required approver roles.
 * - Required roles come from the reserved-action register (or MP default) at card
 *   creation; clients cannot supply or widen them.
 * - Every decision is appended to approval_decision (append-only by DB trigger);
 *   history is always visible via GET /api/approvals/:id.
 */

export const APPROVAL_STATES = [
  "drafted",
  "pending_review",
  "approved",
  "rejected",
  "revise_requested",
  "executed",
  "blocked",
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  drafted: ["pending_review"],
  pending_review: ["approved", "rejected", "revise_requested"],
  revise_requested: ["pending_review"],
  approved: ["executed", "blocked"],
  rejected: [],
  executed: [],
  blocked: [],
};

export class ApprovalError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function assertTransition(from: string, to: ApprovalState): void {
  const allowed = ALLOWED_TRANSITIONS[from as ApprovalState];
  if (!allowed || !allowed.includes(to)) {
    throw new ApprovalError(409, "illegal_transition", `approval card cannot transition ${from} → ${to}`);
  }
}

export interface RequestApprovalInput {
  action_key: string;
  object_type: string;
  object_id: string;
  title: string;
  summary?: string;
  payload?: unknown;
  firm_scope?: string;
  /** When true, the card is submitted for review immediately (drafted → pending_review). */
  submit?: boolean;
}

/**
 * Create an approval card. Any actor type may REQUEST (AI prepares; humans decide).
 * required_approver_roles_json is derived server-side from the register — never
 * from the caller.
 */
export async function requestApproval(env: Env, actor: Actor, input: RequestApprovalInput): Promise<ApprovalCardRow> {
  const action = await getActionType(env, input.action_key);
  if (!action) throw new ApprovalError(400, "unknown_action", `action_type '${input.action_key}' does not exist`);

  const firmScope = input.firm_scope ?? "west-peek";
  const authz = await authorize(env, actor, "approval.request", { objectType: "approval_card", firmScope });
  if (authz.decision === "DENY") throw new ApprovalError(403, "forbidden", authz.reason);

  const id = `apc_${crypto.randomUUID()}`;
  const requiredRoles = await requiredApproverRolesFor(env, input.action_key);
  const requestedById = actor.type === "HUMAN" ? actor.firmUserId! : (actor.aiEmployeeId ?? "system");

  // Risk is DERIVED from the action, never supplied by the requester (P47, canon §24.2). The
  // requester is frequently an AI employee with an interest in a fast approval; a self-declared
  // risk field would be worse than none.
  const risk = assessRisk(input.action_key);
  const expiresAt = new Date(Date.now() + expiryHours(risk.level) * 3_600_000).toISOString();

  await env.WP_OS_DB.prepare(
    `INSERT INTO approval_card
       (id, action_key, object_type, object_id, title, summary, payload_json,
        requested_by_type, requested_by_id, required_approver_roles_json, state, firm_scope,
        risk_level, impact_note, recommended_approver, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'drafted', ?11, ?12, ?13, ?14, ?15)`,
  )
    .bind(
      id,
      input.action_key,
      input.object_type,
      input.object_id,
      input.title,
      input.summary ?? null,
      JSON.stringify(input.payload ?? {}),
      actor.type,
      requestedById,
      JSON.stringify(requiredRoles),
      firmScope,
      risk.level,
      risk.reason,
      recommendApprover(input.action_key, requiredRoles),
      expiresAt,
    )
    .run();

  await appendEvent(env, {
    eventType: "approval.requested",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: requestedById,
    objectType: "approval_card",
    objectId: id,
    firmScope,
    payload: { action_key: input.action_key, object_type: input.object_type, object_id: input.object_id },
  });

  let card = (await getApprovalCard(env, id))!;
  if (input.submit) card = await submitApproval(env, actor, card.id);
  return card;
}

/** drafted | revise_requested → pending_review. Only the requester may (re)submit. */
export async function submitApproval(env: Env, actor: Actor, cardId: string): Promise<ApprovalCardRow> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");
  const actorId = actor.type === "HUMAN" ? actor.firmUserId! : (actor.aiEmployeeId ?? "system");
  if (card.requested_by_id !== actorId) {
    throw new ApprovalError(403, "forbidden", "only the requester may submit this card");
  }
  assertTransition(card.state, "pending_review");
  await env.WP_OS_DB.prepare("UPDATE approval_card SET state = 'pending_review' WHERE id = ?1").bind(cardId).run();
  await appendEvent(env, {
    eventType: "approval.submitted",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId,
    objectType: "approval_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { action_key: card.action_key },
  });
  // P20: the people who can decide this need to know it is waiting. Failure to notify never
  // rolls back the submission.
  await notifyQuietly(env, {
    kind: "APPROVAL",
    severity: "WARNING",
    title: `Approval waiting: ${card.title}`,
    body: `${card.action_key} on ${card.object_type}/${card.object_id}`,
    objectType: "approval_card",
    objectId: cardId,
    dedupeKey: `approval:${cardId}`,
    firmScope: card.firm_scope,
  });
  return (await getApprovalCard(env, cardId))!;
}

export type ApprovalDecisionKind = "approved" | "rejected" | "revise_requested";

/**
 * Decide a pending card. HUMAN deciders only, holding a required approver role.
 * The decision is appended to approval_decision (append-only) and mirrored onto
 * the card (state, decided_by/at, decision_note).
 */
export async function decideApproval(
  env: Env,
  actor: Actor,
  cardId: string,
  decision: ApprovalDecisionKind,
  note?: string,
): Promise<ApprovalCardRow> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");

  // AI/SYSTEM can never decide — an AI can never approve its own (or any) work.
  if (actor.type !== "HUMAN") {
    throw new ApprovalError(403, "forbidden", "approval decisions are human-reserved");
  }
  const required = JSON.parse(card.required_approver_roles_json) as string[];
  if (!required.some((r) => actor.roles.includes(r))) {
    throw new ApprovalError(403, "forbidden", `decision requires one of: ${required.join(", ")}`);
  }
  assertTransition(card.state, decision);

  const decidedAt = new Date().toISOString();
  const decisionId = `apd_${crypto.randomUUID()}`;
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(
      `INSERT INTO approval_decision (id, approval_card_id, decision, decided_by, note)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(decisionId, cardId, decision, actor.firmUserId!, note ?? null),
    env.WP_OS_DB.prepare(
      `UPDATE approval_card
          SET state = ?2, decided_by = ?3, decided_at = ?4, decision_note = ?5
        WHERE id = ?1`,
    ).bind(cardId, decision, actor.firmUserId!, decidedAt, note ?? null),
  ]);

  await appendEvent(env, {
    eventType: "approval.decided",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "approval_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { decision, action_key: card.action_key, object_type: card.object_type, object_id: card.object_id },
  });
  return (await getApprovalCard(env, cardId))!;
}

/**
 * Consume an approved card (approved → executed). Called ONLY by execution paths
 * (merge, external-effect executor) after authorize() has verified the receipt.
 * Throws on any other state — a consumed card can never be replayed.
 */
export async function consumeApprovalCard(env: Env, cardId: string, consumer: { actorId: string }): Promise<void> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");
  assertTransition(card.state, "executed");
  await env.WP_OS_DB.prepare("UPDATE approval_card SET state = 'executed' WHERE id = ?1").bind(cardId).run();
  await appendEvent(env, {
    eventType: "approval.executed",
    actorType: "firm_user",
    actorId: consumer.actorId,
    objectType: "approval_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { action_key: card.action_key, object_type: card.object_type, object_id: card.object_id },
  });
}

/** approved → blocked (execution could not proceed; card is NOT consumed). */
export async function blockApprovalCard(env: Env, cardId: string, actorId: string, reason: string): Promise<void> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");
  assertTransition(card.state, "blocked");
  await env.WP_OS_DB.prepare("UPDATE approval_card SET state = 'blocked' WHERE id = ?1").bind(cardId).run();
  await appendEvent(env, {
    eventType: "approval.blocked",
    actorType: "firm_user",
    actorId,
    objectType: "approval_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { reason },
  });
}

// ── HTTP handlers ──

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApprovalError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const createApprovalSchema = z.object({
  action_key: z.string().trim().min(1),
  object_type: z.string().trim().min(1),
  object_id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().optional(),
  payload: z.unknown().optional(),
  submit: z.boolean().optional(),
});

const decideSchema = z.object({
  decision: z.enum(["approved", "rejected", "revise_requested"]),
  note: z.string().optional(),
});

export async function handleCreateApproval(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createApprovalSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const card = await requestApproval(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json(card, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListApprovals(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const state = url.searchParams.get("state");
  const scopePlaceholders = ctx.identity!.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  const scopes = scopePlaceholders.length > 0 ? scopePlaceholders : ["west-peek"];
  const scopeClause = `firm_scope IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ")})`;
  const rows = state
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM approval_card WHERE state = ?1 AND ${scopeClause} ORDER BY created_at DESC, id`,
      )
        .bind(state)
        .all<ApprovalCardRow>()
    : await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM approval_card WHERE ${scopeClause} ORDER BY created_at DESC, id`,
      ).all<ApprovalCardRow>();
  return json({ approvals: rows.results ?? [] });
}

export async function handleGetApproval(ctx: RouteContext): Promise<Response> {
  const card = await getApprovalCard(ctx.env, ctx.params.id!);
  if (!card) return json({ error: "not_found" }, { status: 404 });
  // Decision history is ALWAYS visible with the card.
  const decisions = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM approval_decision WHERE approval_card_id = ?1 ORDER BY created_at, id",
  )
    .bind(card.id)
    .all();
  return json({ ...card, decisions: decisions.results ?? [] });
}

export async function handleSubmitApproval(ctx: RouteContext): Promise<Response> {
  try {
    const card = await submitApproval(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!);
    return json(card);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleDecideApproval(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const card = await decideApproval(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.decision, parsed.data.note);
    return json(card);
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Approval Centre: evidence and comments (P47, canon §24.2) ────────────────
//
// An approval queue whose items cannot be evaluated in place trains the approver to click approve.
// These two additions are what let a decision be made on the card rather than after a hunt through
// four other pages.

/** GET /api/approvals/:id/context — evidence, comments, and whether the card has gone stale. */
export async function handleApprovalContext(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  if (!id) return json({ error: "invalid_input" }, { status: 400 });

  const card = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, action_key, title, summary, risk_level, impact_note, recommended_approver, expires_at, state, required_approver_roles_json FROM approval_card WHERE id = ?1",
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!card) return json({ error: "not_found" }, { status: 404 });

  const evidence = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, kind, ref_id, label, detail, created_at FROM approval_evidence WHERE approval_card_id = ?1 ORDER BY created_at",
  ).bind(id).all();
  const comments = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, author_type, author_id, body, created_at FROM approval_comment WHERE approval_card_id = ?1 ORDER BY created_at",
  ).bind(id).all();

  const { isStale } = await import("../../shared/approvals/risk");
  return json({
    card,
    evidence: evidence.results ?? [],
    comments: comments.results ?? [],
    // Advisory. A stale card is flagged for attention; it is never auto-decided, because silence
    // approving an external send is the system deciding something it has no authority to decide.
    stale: isStale(card.expires_at as string | null, new Date()),
  });
}

const evidenceSchema = z.object({
  kind: z.enum(["CLAIM", "DOCUMENT", "INTELLIGENCE_ITEM", "MEETING", "CONTRADICTION", "OTHER"]),
  label: z.string().min(1).max(300),
  ref_id: z.string().max(80).nullish(),
  detail: z.string().max(2000).nullish(),
});

/** POST /api/approvals/:id/evidence — attach what the decision should rest on. */
export async function handleAddApprovalEvidence(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  const parsed = evidenceSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!id || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO approval_evidence (id, approval_card_id, kind, ref_id, label, detail, added_by) VALUES (?1,?2,?3,?4,?5,?6,?7)",
  )
    .bind(`ape_${crypto.randomUUID()}`, id, parsed.data.kind, parsed.data.ref_id ?? null,
          parsed.data.label, parsed.data.detail ?? null, actor.firmUserId ?? "system")
    .run();
  return json({ added: true }, { status: 201 });
}

/** POST /api/approvals/:id/comments — ask before deciding, rather than rejecting for want of an answer. */
export async function handleAddApprovalComment(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  const body = (await ctx.request.json().catch(() => null)) as { body?: string } | null;
  if (!id || !body?.body?.trim()) return json({ error: "invalid_input" }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO approval_comment (id, approval_card_id, author_type, author_id, body) VALUES (?1,?2,?3,?4,?5)",
  )
    .bind(`apm_${crypto.randomUUID()}`, id, actor.type === "HUMAN" ? "HUMAN" : "AI",
          actor.firmUserId ?? actor.aiEmployeeId ?? "system", body.body.trim())
    .run();
  return json({ added: true }, { status: 201 });
}
