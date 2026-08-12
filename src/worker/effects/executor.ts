import type { Env } from "../env";
import { appendEvent } from "../events";
import { EFFECT_TYPE_ACTION_KEYS } from "../../shared/registry/actionTypes";
import { authorize, type Actor } from "../services/authorize";
import { consumeApprovalCard } from "../services/approvals";

/**
 * External-effect executor — the ONLY module in the system allowed to execute an
 * external effect (send, publish, external write). Enforced by the static scan in
 * scripts/validate/no-unauthorized-effects.mjs.
 *
 * Every execution:
 * 1. verifies the authorization receipt through authorize() (approved approval_card
 *    matching the effect action key AND this exact request object, decided by a
 *    human with the required role, not already consumed),
 * 2. performs the effect through a per-effect-type adapter — ALL adapters are LOCAL
 *    SIMULATIONS in the initial build (no real sends; simulated delivery detail is
 *    recorded),
 * 3. consumes the receipt (approved → executed) so it can never be replayed,
 * 4. appends an effect.executed event carrying the receipt id (D15).
 */

export interface ExternalEffectRequestRow {
  id: string;
  effect_type: string;
  destination: string;
  payload_json: string;
  authorization_receipt_id: string | null;
  state: string;
  requested_by_type: string;
  requested_by_id: string;
  approval_card_id: string | null;
  created_at: string;
  executed_at: string | null;
}

export class EffectError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export interface SimulatedDelivery {
  simulated: true;
  channel: string;
  destination: string;
  summary: string;
  delivered_at: string;
}

/**
 * Per-effect-type adapters. LOCAL SIMULATION ONLY — no network egress exists here;
 * the static scan rejects any outbound fetch outside localhost in worker code.
 */
const ADAPTERS: Readonly<Record<string, (request: ExternalEffectRequestRow) => SimulatedDelivery>> = {
  "email.send": (request) => ({
    simulated: true,
    channel: "email",
    destination: request.destination,
    summary: `Simulated email delivery to ${request.destination} (no message left the system)`,
    delivered_at: new Date().toISOString(),
  }),
  "message.send": (request) => ({
    simulated: true,
    channel: "message",
    destination: request.destination,
    summary: `Simulated message delivery to ${request.destination} (no message left the system)`,
    delivered_at: new Date().toISOString(),
  }),
  "webhook.post": (request) => ({
    simulated: true,
    channel: "webhook",
    destination: request.destination,
    summary: `Simulated webhook POST to ${request.destination} (no request left the system)`,
    delivered_at: new Date().toISOString(),
  }),
};

export function isKnownEffectType(effectType: string): boolean {
  return effectType in ADAPTERS && effectType in EFFECT_TYPE_ACTION_KEYS;
}

export interface EffectExecutionResult {
  request: ExternalEffectRequestRow;
  delivery: SimulatedDelivery;
  receipt_id: string;
}

/**
 * Execute an external effect. Refuses (throws EffectError) unless authorize()
 * returns ALLOW backed by a valid, unconsumed, object-matching approved receipt.
 */
export async function executeExternalEffect(
  env: Env,
  actor: Actor,
  requestId: string,
  receiptId: string | undefined,
): Promise<EffectExecutionResult> {
  const request = await env.WP_OS_DB.prepare("SELECT * FROM external_effect_request WHERE id = ?1")
    .bind(requestId)
    .first<ExternalEffectRequestRow>();
  if (!request) throw new EffectError(404, "not_found");
  if (request.state === "EXECUTED") {
    throw new EffectError(409, "already_executed", "external effect request is already EXECUTED");
  }
  if (request.state === "DENIED") {
    throw new EffectError(409, "denied", "external effect request is DENIED");
  }
  if (!isKnownEffectType(request.effect_type)) {
    throw new EffectError(409, "unknown_effect_type", request.effect_type);
  }

  const actionKey = EFFECT_TYPE_ACTION_KEYS[request.effect_type]!;
  const authz = await authorize(
    env,
    actor,
    actionKey,
    { objectType: "external_effect_request", objectId: request.id },
    { receiptId },
  );
  if (authz.decision !== "ALLOW") {
    throw new EffectError(
      409,
      "authorization_required",
      `external effect execution refused: ${authz.decision} (${authz.reason})`,
    );
  }

  const adapter = ADAPTERS[request.effect_type]!;
  let delivery: SimulatedDelivery;
  try {
    delivery = adapter(request);
  } catch (err) {
    await env.WP_OS_DB.prepare("UPDATE external_effect_request SET state = 'FAILED' WHERE id = ?1").bind(request.id).run();
    await appendEvent(env, {
      eventType: "effect.failed",
      actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
      actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      objectType: "external_effect_request",
      objectId: request.id,
      payload: { effect_type: request.effect_type, error: err instanceof Error ? err.message : String(err) },
    });
    throw new EffectError(500, "effect_failed", err instanceof Error ? err.message : String(err));
  }

  const executedAt = new Date().toISOString();
  await env.WP_OS_DB.prepare(
    `UPDATE external_effect_request
        SET state = 'EXECUTED', authorization_receipt_id = ?2, approval_card_id = ?2, executed_at = ?3
      WHERE id = ?1`,
  )
    .bind(request.id, receiptId!, executedAt)
    .run();

  // Consume the receipt: approved → executed. Replay is then impossible.
  await consumeApprovalCard(env, receiptId!, { actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system" });

  await appendEvent(env, {
    eventType: "effect.executed",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "external_effect_request",
    objectId: request.id,
    payload: { effect_type: request.effect_type, destination: request.destination, receipt_id: receiptId, delivery },
  });

  const updated = await env.WP_OS_DB.prepare("SELECT * FROM external_effect_request WHERE id = ?1")
    .bind(request.id)
    .first<ExternalEffectRequestRow>();
  return { request: updated!, delivery, receipt_id: receiptId! };
}
