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
  liveStandingGrant,
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
 * Two further moves exist and are deliberately NOT rows in that table — see
 * REOPENABLE_FROM and BLOCKABLE_FROM below for why:
 *   reopen:  approved | rejected | revise_requested → pending_review  (supersedes a decision)
 *   block:   drafted | pending_review | revise_requested | approved → blocked → back where it was
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

/**
 * States a decision can be TAKEN BACK from, and the two that are missing on purpose.
 *
 * WHY THIS IS NOT AN ENTRY IN ALLOWED_TRANSITIONS. Both submitApproval() and decideApproval() read
 * that table. Adding `rejected → pending_review` there would let the REQUESTER resubmit their way
 * past a rejection — press submit, card is pending again, try a different approver. Changing a
 * decision is an authority the DECIDER holds, not a door the person who wanted the yes can walk
 * back through, so it lives in its own guard with its own role check.
 *
 * `executed` is absent because it is the one state a reversal cannot honestly reach: the email is
 * sent, the transaction is booked, the receipt is consumed. Reopening it would record a lie about
 * what the firm can still choose. Undoing an executed action is a NEW request for a NEW action.
 *
 * `blocked` is absent because a blocked card has no standing decision to supersede — release the
 * block first and it returns to whatever was true before, which is then reopenable if it was a
 * decision.
 */
const REOPENABLE_FROM: readonly ApprovalState[] = ["approved", "rejected", "revise_requested"];

/**
 * States a card can be BLOCKED from — everything that has not already finished.
 *
 * A block says "nothing here proceeds until something else is resolved", which is true of a card
 * nobody has looked at yet and equally true of one already approved and waiting to run. It is NOT
 * true of `executed` (it already ran) or `rejected` (it is already stopped, and dressing a dead
 * card as a live blocker would put it back in front of a partner for no reason).
 *
 * Kept out of ALLOWED_TRANSITIONS for the same reason as above: consumeApprovalCard() reads that
 * table, and a widened `blocked` row would let an execution path consume a card the firm has
 * explicitly put on hold.
 */
const BLOCKABLE_FROM: readonly ApprovalState[] = ["drafted", "pending_review", "revise_requested", "approved"];

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

  /*
   * DELEGATED AHEAD OF TIME? Then the card does not wait (ADR-018).
   *
   * This is the operator's "don't ask me again", and the shape matters: the card is still created,
   * still carries its action and its requester, and still lands on the event spine — it simply does
   * not sit in the queue. A delegation that made the record disappear would be a delegation nobody
   * could audit afterwards, which is the difference between authority and a blind spot.
   *
   * A reserved action or an external effect can never reach here with a grant, because
   * `grantStandingAuthority` refuses to record one and `liveStandingGrant` only matches rows that
   * exist. The judgement stays with the partners.
   */
  const grant = await liveStandingGrant(env, card.action_key, {
    objectType: card.object_type,
    objectId: card.object_id ?? undefined,
  });
  if (grant) {
    /*
     * THE BOUND IS ENFORCED BY THE UPDATE ITSELF, not by the SELECT that found the grant.
     *
     * `liveStandingGrant` checks `uses < max_uses` in an earlier round trip; two submissions racing
     * between that read and this write would each see room and both spend, pushing a grant past its
     * own limit — the limit being the thing that bounds the damage of a grant that turns out to have
     * been a mistake.
     *
     * So the condition moves into the UPDATE and the result is checked. If it changed nothing, the
     * grant was spent by somebody else in between and this card takes the ordinary path rather than
     * being waved through on authority that no longer exists.
     */
    const spend = await env.WP_OS_DB.prepare(
      "UPDATE standing_authority SET uses = uses + 1 WHERE id = ?1 AND uses < max_uses AND revoked_at IS NULL",
    )
      .bind(grant.id)
      .run();
    if ((spend.meta?.changes ?? 0) === 0) {
      await env.WP_OS_DB.prepare("UPDATE approval_card SET state = 'pending_review' WHERE id = ?1").bind(cardId).run();
      return (await getApprovalCard(env, cardId))!;
    }
    await env.WP_OS_DB.prepare(
      `INSERT INTO standing_authority_use (id, authority_id, object_type, object_id, actor_type, actor_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(`sau_${crypto.randomUUID()}`, grant.id, card.object_type, card.object_id ?? null, actor.type, actorId)
      .run();
    /*
     * A DECISION ROW, AND A NAMED DECIDER — both were missing, and the card was unusable without them.
     *
     * This module's own docstring says EVERY decision is appended to `approval_decision`. A standing
     * approval wrote none, with three consequences: the card came back with `decisions: []`, so it
     * looked decided by nobody; `latestDecisionId()` returned null so a reopen superseded nothing;
     * and `verifyAuthorizationReceipt` requires `decided_by`, so the card was **approved and
     * permanently unexecutable, with nothing anywhere saying why.**
     *
     * The decider is the partner who GRANTED the authority, not the actor who happened to submit.
     * That is the honest attribution: she made this decision in advance, and the grant is named
     * beside it so the trail says which one and when.
     */
    const grantedBy = await env.WP_OS_DB.prepare("SELECT granted_by FROM standing_authority WHERE id = ?1")
      .bind(grant.id)
      .first<{ granted_by: string }>();
    const decidedBy = grantedBy?.granted_by ?? actorId;
    const note = `Approved by standing authority granted earlier (${grant.id}) — not reviewed again.`;

    await env.WP_OS_DB.prepare(
      `INSERT INTO approval_decision (id, approval_card_id, decision, decided_by, note)
       VALUES (?1, ?2, 'approved', ?3, ?4)`,
    )
      .bind(`apd_${crypto.randomUUID()}`, cardId, decidedBy, note)
      .run();

    await env.WP_OS_DB.prepare(
      `UPDATE approval_card
          SET state = 'approved', decided_by = ?2,
              decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              decision_note = ?3
        WHERE id = ?1`,
    )
      .bind(cardId, decidedBy, note)
      .run();
    await appendEvent(env, {
      eventType: "approval.auto_approved_by_standing",
      actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
      actorId,
      objectType: "approval_card",
      objectId: cardId,
      firmScope: card.firm_scope,
      payload: { action_key: card.action_key, standing_authority_id: grant.id, uses_left: grant.max_uses - grant.uses - 1 },
    });
    return (await getApprovalCard(env, cardId))!;
  }

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
/**
 * The authority test every act on a card in front of a partner has to pass: deciding it, changing
 * that decision afterwards, blocking it, and releasing the block.
 *
 * Blocking is in that list on purpose, and it is the arguable one. A block only ever STOPS things,
 * so a wider authority would be safe in one direction — but a person who can block anything can
 * hold the whole firm's decisions hostage without ever being able to resolve one, and there is no
 * queue in this product where that is a useful power to grant.
 */
function assertMayAct(card: ApprovalCardRow, actor: Actor, verb: string): void {
  // AI/SYSTEM can never decide — an AI can never approve its own (or any) work.
  if (actor.type !== "HUMAN") {
    throw new ApprovalError(403, "forbidden", `approval ${verb} is human-reserved`);
  }
  const required = JSON.parse(card.required_approver_roles_json) as string[];
  if (!required.some((r) => actor.roles.includes(r))) {
    throw new ApprovalError(403, "forbidden", `${verb} requires one of: ${required.join(", ")}`);
  }
}

/**
 * A reason somebody actually wrote, or a refusal that says why it was refused.
 *
 * Required here and optional on an ordinary decision, which is a deliberate asymmetry. The first
 * decision is explained by the card it sits on. A reversal is not: six months later "approved, then
 * rejected" with nothing between them is unreadable, and the fact that cannot be reconstructed
 * afterwards is precisely the one the reverser was holding at the time.
 */
function requireReason(value: string | undefined, whatFor: string): string {
  const reason = (value ?? "").trim();
  if (reason.length < 3) {
    throw new ApprovalError(400, "reason_required", `${whatFor} — say what changed, in a sentence. Nothing has been recorded.`);
  }
  return reason;
}

export async function decideApproval(
  env: Env,
  actor: Actor,
  cardId: string,
  decision: ApprovalDecisionKind,
  note?: string,
): Promise<ApprovalCardRow> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");

  assertMayAct(card, actor, "decision");
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

  // THE NOTIFICATION THAT ASKED FOR THIS DECISION IS NOW ANSWERED, so it stops asking.
  //
  // Submitting a card raises "Approval waiting"; nothing ever retired it. The result was an inbox
  // filling with unread requests for decisions that had already been made, each linking to a card
  // no longer in the queue — the operator's exact report was a notification about an approval that
  // is not in the approval queue at all. Read rather than deleted: what was asked and when is part
  // of the record, it simply stops being outstanding.
  //
  // Best-effort, and deliberately after the decision is committed. A notification that will not
  // update is not a reason to fail a decision that already happened.
  try {
    await env.WP_OS_DB.prepare(
      `UPDATE notification
          SET read_at = ?2
        WHERE object_type = 'approval_card' AND object_id = ?1 AND read_at IS NULL`,
    )
      .bind(cardId, decidedAt)
      .run();
  } catch {
    /* the decision stands regardless */
  }

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

// ── Changing a decision after it has been made (item 3) ──────────────────────────────────────
//
// THE CONSTRAINT SHAPES THE FEATURE. `approval_decision` refuses UPDATE and DELETE at the database
// layer, and that refusal is the reason an approval trail is worth anything: a partner cannot go
// back and make Tuesday say something else. So changing your mind cannot mean editing the decision.
// It means recording a NEW one that supersedes it — new actor, new timestamp, required reason — and
// the original stays exactly where it was, still visible on the card.
//
// A reopen is deliberately NOT a re-decision. It puts the card back to "waiting on you" and stops
// there, so the replacement verdict is made on the card, in front of whatever evidence and
// questions have accumulated since, by somebody holding the role. One press that flipped an
// approval straight to a rejection would be a decision taken without the card in front of you.

/** Whatever decision currently stands on this card, or null if none does. */
async function latestDecisionId(env: Env, cardId: string): Promise<string | null> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT id FROM approval_decision WHERE approval_card_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
  )
    .bind(cardId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Take back a decision already made. approved | rejected | revise_requested → pending_review.
 *
 * The refusals are as much of the feature as the success: a partner who cannot reopen something
 * needs to be told which of the four reasons applies, because "executed" and "you do not hold the
 * role" call for completely different next moves.
 */
export async function reopenApproval(env: Env, actor: Actor, cardId: string, reason: string): Promise<ApprovalCardRow> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");
  assertMayAct(card, actor, "changing a decision");

  if (card.state === "executed") {
    throw new ApprovalError(
      409,
      "already_carried_out",
      "This already happened, so there is no decision left to change. Undoing it is a new request for the action that undoes it.",
    );
  }
  if (card.state === "blocked") {
    throw new ApprovalError(409, "card_is_blocked", "This is blocked. Release the block first, then change the decision underneath it.");
  }
  if (!REOPENABLE_FROM.includes(card.state as ApprovalState)) {
    throw new ApprovalError(409, "nothing_decided", "Nothing has been decided on this yet, so there is nothing to change.");
  }
  const written = requireReason(reason, "Changing a decision needs a reason");

  const supersedes = await latestDecisionId(env, cardId);
  const decisionId = `apd_${crypto.randomUUID()}`;
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(
      `INSERT INTO approval_decision (id, approval_card_id, decision, decided_by, note, supersedes_decision_id)
       VALUES (?1, ?2, 'reopened', ?3, ?4, ?5)`,
    ).bind(decisionId, cardId, actor.firmUserId!, written, supersedes),
    // decided_by/decided_at/decision_note are cleared because they mirror the decision that
    // CURRENTLY STANDS, and after a reopen none does. The trail is not lost — it never lived here.
    // approval_decision holds it, this card reads it back, and those rows cannot be touched.
    env.WP_OS_DB.prepare(
      `UPDATE approval_card
          SET state = 'pending_review', decided_by = NULL, decided_at = NULL, decision_note = NULL
        WHERE id = ?1`,
    ).bind(cardId),
  ]);

  await appendEvent(env, {
    eventType: "approval.reopened",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "approval_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { previous_state: card.state, supersedes_decision_id: supersedes, reason: written, action_key: card.action_key },
  });

  // It is waiting on a person again, so the people who can decide it are told again — the same
  // reason submitting raises one. A card that quietly re-entered the queue is one nobody works.
  await notifyQuietly(env, {
    kind: "APPROVAL",
    severity: "WARNING",
    title: `Decision reopened: ${card.title}`,
    body: `${actor.firmUserId} took back the earlier decision — ${written}`,
    objectType: "approval_card",
    objectId: cardId,
    dedupeKey: `approval:${cardId}:reopened:${decisionId}`,
    firmScope: card.firm_scope,
  });
  return (await getApprovalCard(env, cardId))!;
}

// ── Blocking, which is not rejecting ─────────────────────────────────────────────────────────
//
// Reject is a verdict on the request: no, not this, and that is the end of it. Block is a statement
// about the firm: nothing here proceeds until something ELSE is resolved. The request may be
// perfectly good — it is the ground under it that is not ready.
//
// Two things follow, and they are what make this a different feature rather than a second word for
// the same one. A block must NAME what it is waiting on, because a hold that cannot say what would
// end it is a rejection with better manners and it rots in the queue with nobody able to tell
// whether it is still true. And a block must be RELEASABLE, returning the card to exactly where it
// stood — blocking pauses, it never decides. That is why `state_before` is recorded: a card that was
// approved and waiting to run is approved and waiting to run again, not sent back for a second yes.

export interface ApprovalBlockRow {
  id: string;
  approval_card_id: string;
  waiting_on: string;
  state_before: string;
  blocked_by: string;
  created_at: string;
  released_by: string | null;
  released_at: string | null;
  release_note: string | null;
}

/** The block currently standing on a card, or null. At most one can exist (unique index). */
export async function openBlockFor(env: Env, cardId: string): Promise<ApprovalBlockRow | null> {
  return env.WP_OS_DB.prepare(
    "SELECT * FROM approval_block WHERE approval_card_id = ?1 AND released_at IS NULL LIMIT 1",
  )
    .bind(cardId)
    .first<ApprovalBlockRow>();
}

/** Every block a card has ever carried, released ones included. */
export async function blocksFor(env: Env, cardId: string): Promise<ApprovalBlockRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT * FROM approval_block WHERE approval_card_id = ?1 ORDER BY created_at, id",
  )
    .bind(cardId)
    .all<ApprovalBlockRow>();
  return rows.results ?? [];
}

/** Put a card on hold until `waitingOn` is resolved. Anything unfinished can be blocked. */
export async function blockApproval(env: Env, actor: Actor, cardId: string, waitingOn: string): Promise<ApprovalBlockRow> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");
  assertMayAct(card, actor, "blocking");

  if (card.state === "blocked") {
    const standing = await openBlockFor(env, cardId);
    throw new ApprovalError(
      409,
      "already_blocked",
      standing ? `This is already blocked, waiting on: ${standing.waiting_on}` : "This is already blocked.",
    );
  }
  if (!BLOCKABLE_FROM.includes(card.state as ApprovalState)) {
    throw new ApprovalError(
      409,
      "nothing_to_block",
      card.state === "executed"
        ? "This already happened. Blocking it now would stop nothing."
        : "This was rejected, so nothing is going to proceed from it anyway.",
    );
  }
  const named = requireReason(waitingOn, "A block has to say what it is waiting on");

  const blockId = `apb_${crypto.randomUUID()}`;
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(
      `INSERT INTO approval_block (id, approval_card_id, waiting_on, state_before, blocked_by)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(blockId, cardId, named, card.state, actor.firmUserId!),
    // Written into the decision trail as well as its own table, so the card has ONE chronology a
    // partner can read top to bottom. A hold that only exists in a side table is a hold that
    // disappears from the story of how the decision was reached.
    env.WP_OS_DB.prepare(
      `INSERT INTO approval_decision (id, approval_card_id, decision, decided_by, note)
       VALUES (?1, ?2, 'blocked', ?3, ?4)`,
    ).bind(`apd_${crypto.randomUUID()}`, cardId, actor.firmUserId!, named),
    env.WP_OS_DB.prepare("UPDATE approval_card SET state = 'blocked' WHERE id = ?1").bind(cardId),
  ]);

  await appendEvent(env, {
    eventType: "approval.blocked",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "approval_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { waiting_on: named, state_before: card.state, action_key: card.action_key },
  });

  // A blocked card is not waiting on a decision, so the outstanding "approval waiting" prompt stops
  // asking for one. Read, never deleted: what was asked and when stays on the record.
  try {
    await env.WP_OS_DB.prepare(
      `UPDATE notification SET read_at = ?2
        WHERE object_type = 'approval_card' AND object_id = ?1 AND read_at IS NULL`,
    )
      .bind(cardId, new Date().toISOString())
      .run();
  } catch {
    /* the block stands regardless */
  }
  return (await openBlockFor(env, cardId))!;
}

/** Release the block: whatever it was waiting on is resolved, and the card goes back where it was. */
export async function releaseApprovalBlock(env: Env, actor: Actor, cardId: string, resolution: string): Promise<ApprovalCardRow> {
  const card = await getApprovalCard(env, cardId);
  if (!card) throw new ApprovalError(404, "not_found");
  assertMayAct(card, actor, "releasing a block");

  const standing = await openBlockFor(env, cardId);
  if (!standing) throw new ApprovalError(409, "not_blocked", "Nothing is blocking this.");
  const written = requireReason(resolution, "Releasing a block needs to say what resolved it");

  const releasedAt = new Date().toISOString();
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(
      "UPDATE approval_block SET released_by = ?2, released_at = ?3, release_note = ?4 WHERE id = ?1",
    ).bind(standing.id, actor.firmUserId!, releasedAt, written),
    env.WP_OS_DB.prepare(
      `INSERT INTO approval_decision (id, approval_card_id, decision, decided_by, note)
       VALUES (?1, ?2, 'unblocked', ?3, ?4)`,
    ).bind(`apd_${crypto.randomUUID()}`, cardId, actor.firmUserId!, written),
    // Back to state_before, not forward to anything. See the note on `state_before`.
    env.WP_OS_DB.prepare("UPDATE approval_card SET state = ?2 WHERE id = ?1").bind(cardId, standing.state_before),
  ]);

  await appendEvent(env, {
    eventType: "approval.block_released",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "approval_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { waiting_on: standing.waiting_on, resolution: written, returned_to: standing.state_before },
  });

  if (standing.state_before === "pending_review") {
    await notifyQuietly(env, {
      kind: "APPROVAL",
      severity: "WARNING",
      title: `Unblocked and waiting again: ${card.title}`,
      body: `Was waiting on ${standing.waiting_on} — ${written}`,
      objectType: "approval_card",
      objectId: cardId,
      dedupeKey: `approval:${cardId}:released:${standing.id}`,
      firmScope: card.firm_scope,
    });
  }
  return (await getApprovalCard(env, cardId))!;
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

// The reason is required at the edge as well as in the service. Parsing it away here would answer
// with a schema issue list; the service answers with a sentence, which is what the operator reads.
const reasonSchema = z.object({ reason: z.string().optional() });
const blockSchema = z.object({ waiting_on: z.string().optional() });

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
  // What a blocked card is waiting on travels with the card in the LIST, not only on the detail.
  // "Blocked" on its own is the least useful word in the queue: it tells a partner something has
  // stopped and nothing about whether they are the person who can start it again.
  /*
   * WHETHER A CARD CAN BE DELEGATED TRAVELS WITH IT (ADR-018), read from `action_type` rather than
   * decided in the client. A page that worked it out for itself would be a second copy of the rule,
   * and the one place it must never be wrong is the control that offers to stop asking.
   *
   * `work_card_id` is derived rather than stored: a card raised ABOUT a work card has that card as
   * its object, which is exactly what a "until this task is done" grant needs to attach to.
   */
  const select =
    `SELECT c.*,
            (SELECT b.waiting_on FROM approval_block b
              WHERE b.approval_card_id = c.id AND b.released_at IS NULL LIMIT 1) AS blocked_waiting_on,
            at.is_reserved AS is_reserved,
            at.is_external_effect AS is_external_effect,
            (at.is_reserved = 0 AND at.is_external_effect = 0) AS delegable,
            CASE WHEN c.object_type = 'work_card' THEN c.object_id END AS work_card_id
       FROM approval_card c
       LEFT JOIN action_type at ON at.key = c.action_key`;
  const rows = state
    ? await ctx.env.WP_OS_DB.prepare(`${select} WHERE c.state = ?1 AND ${scopeClause} ORDER BY c.created_at DESC, c.id`)
        .bind(state)
        .all<ApprovalCardRow>()
    : await ctx.env.WP_OS_DB.prepare(`${select} WHERE ${scopeClause} ORDER BY c.created_at DESC, c.id`).all<ApprovalCardRow>();
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
  // Blocks travel with the card for the same reason decisions do: a released block is part of how
  // the decision was reached, and a standing one is the answer to "why has nothing happened".
  const blocks = await blocksFor(ctx.env, card.id);
  return json({ ...card, decisions: decisions.results ?? [], blocks });
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

/** POST /api/approvals/:id/reopen — take back a decision by recording one that supersedes it. */
export async function handleReopenApproval(ctx: RouteContext): Promise<Response> {
  const parsed = reasonSchema.safeParse(await parseJsonBody(ctx.request));
  try {
    const card = await reopenApproval(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.success ? (parsed.data.reason ?? "") : "");
    return json(card);
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/approvals/:id/block — hold it until a named thing is resolved. */
export async function handleBlockApproval(ctx: RouteContext): Promise<Response> {
  const parsed = blockSchema.safeParse(await parseJsonBody(ctx.request));
  try {
    const block = await blockApproval(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.success ? (parsed.data.waiting_on ?? "") : "");
    return json(block, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/approvals/:id/release — the blocker is resolved; put the card back where it was. */
export async function handleReleaseApprovalBlock(ctx: RouteContext): Promise<Response> {
  const parsed = reasonSchema.safeParse(await parseJsonBody(ctx.request));
  try {
    const card = await releaseApprovalBlock(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.success ? (parsed.data.reason ?? "") : "");
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
