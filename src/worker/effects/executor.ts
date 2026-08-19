import type { Env } from "../env";
import { appendEvent } from "../events";
import { EFFECT_TYPE_ACTION_KEYS } from "../../shared/registry/actionTypes";
import { authorize, type Actor } from "../services/authorize";
import { consumeApprovalCard } from "../services/approvals";
import { fromAddressFor } from "../services/sendAs";
import { trySendAsPartner } from "../services/googleConnect";
import { emailSendBlockedReason, isEmailSendEnabled, sendViaResend } from "./resendClient";
import type { EmailSendResult } from "./emailTransport";
import {
  cloudflareEmailBlockedReason,
  isCloudflareEmailEnabled,
  sendViaCloudflare,
} from "./cloudflareEmailClient";

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
  /** false once a real transport carried it. Named `simulated` for compatibility with existing
      receipts and events, which already record this field. */
  simulated: boolean;
  channel: string;
  destination: string;
  summary: string;
  delivered_at: string;
  /** Provider message id when a real send happened. Null for a simulation. */
  provider_message_id?: string | null;
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
 * Perform the effect itself, AFTER authorization has already passed.
 *
 * Only `email.send` has a real transport, and now there are two of them. CLOUDFLARE IS TRIED FIRST
 * because it is a binding: nothing about it calls fetch(), so it needs no egress exemption and no
 * third-party credential, and it cannot be reached by code that was not given the binding. Resend
 * stays as the fallback and still works exactly as before — this is a preference, not a removal.
 *
 * EITHER WAY BOTH SWITCHES APPLY. A transport being available has never been consent to start
 * emailing people. When neither is on, the effect still succeeds as a recorded simulation, because
 * the approval was genuinely granted and swallowing it would lose the receipt. The summary says
 * which of the three happened, so nobody has to guess whether a message actually went out.
 */
async function performEffect(env: Env, request: ExternalEffectRequestRow): Promise<SimulatedDelivery> {
  const cloudflareReady = isCloudflareEmailEnabled(env);
  if (request.effect_type === "email.send" && (cloudflareReady || isEmailSendEnabled(env))) {
    const payload = JSON.parse(request.payload_json || "{}") as { subject?: string; text?: string; body?: string };
    // WHOSE NAME IS ON IT. A partner who has turned on "send as me" has their approved messages go
    // out under their own address instead of the firm's; everyone else, and every unattributed
    // request, stays as the firm. Resolved from the person who REQUESTED the effect rather than
    // whoever executed it — the request is the authorship, and the approval is a separate act.
    const requestedBy = request.requested_by_type === "HUMAN" ? request.requested_by_id : null;
    const from = (await fromAddressFor(env, requestedBy)) ?? undefined;

    const message = {
      to: request.destination,
      subject: payload.subject ?? "(no subject)",
      text: payload.text ?? payload.body ?? "",
      from,
    };
    // THROUGH THE PARTNER'S OWN GMAIL WHEN THEY HAVE GRANTED IT. Mail sent under a partner's address
    // via the firm transport is legitimate and arrives, but Gmail has never heard of it — so it is
    // absent from their Sent folder and a reply threads against nothing. Sent through Gmail it
    // simply IS their email.
    //
    // Only when they are sending as themselves AND granted gmail.send; anything else, including a
    // Gmail attempt that comes back refused, falls to the firm transport rather than not sending.
    let result: EmailSendResult | null = null;
    if (requestedBy && from && from !== env.WP_OS_EMAIL_FROM) {
      try {
        const gmailId = await trySendAsPartner(env, requestedBy, { ...message, from });
        if (gmailId) {
          result = {
            sent: true,
            provider: "gmail",
            provider_message_id: gmailId,
            detail: `Delivered to ${message.to} as ${from} through their own Gmail`,
          };
        }
      } catch {
        // Refused by Google — fall through to the firm transport rather than dropping the message.
        result = null;
      }
    }

    result ??= cloudflareReady
      ? await sendViaCloudflare(env, message)
      : await sendViaResend(env, message);
    return {
      simulated: !result.sent,
      channel: "email",
      destination: request.destination,
      summary: result.detail,
      delivered_at: new Date().toISOString(),
      provider_message_id: result.provider_message_id,
    };
  }

  if (request.effect_type === "email.send") {
    // Report the Cloudflare reason when a binding is present — that is the path the operator is
    // most likely mid-setup on. Otherwise the Resend reason, which is the older configured route.
    const why =
      (env.EMAIL ? cloudflareEmailBlockedReason(env) : null) ??
      emailSendBlockedReason(env) ??
      "email sending is not enabled";
    return {
      simulated: true,
      channel: "email",
      destination: request.destination,
      summary: `Approved and recorded, NOT sent — ${why}`,
      delivered_at: new Date().toISOString(),
      provider_message_id: null,
    };
  }

  return ADAPTERS[request.effect_type]!(request);
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

  let delivery: SimulatedDelivery;
  try {
    delivery = await performEffect(env, request);
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
