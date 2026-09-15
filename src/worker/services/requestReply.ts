import type { Env } from "../env";
import { appendEvent } from "../events";
import { sendViaResend } from "../effects/resendClient";
import { aiOutboundSwitches } from "../../shared/policy/aiOutbound";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";

/**
 * A request that came in by email is answered by email.
 *
 * Operator, 14 Sep 2026: "make sure e2e that sequoia@ and scooter@ can email os@joinwestpeek.com
 * for requests and they will be routed to the right employee … completed e2e and we will be
 * notified when its done." Until now the only notice was inside the OS: a partner who had emailed
 * a request learned it was done by opening Work. The request came from an inbox; the answer goes
 * back to the same inbox.
 *
 * WHY THIS IS NOT THE BYPASS `inboundEmail.ts` WARNS ABOUT. That file declined an auto-reply because
 * every `email.send` is an external effect behind a human-approved receipt, and an automatic send
 * on the path that accepts outside instructions would be a bypass around that gate. This reply is
 * bounded on every axis that gate protects:
 *
 *   · THE DESTINATION IS NEVER CHOSEN BY CONTENT. It is the AUTHENTICATED address the request came
 *     from (`work_card.requested_by_email`, set only by `openAssignmentCard` after DKIM/DMARC passed),
 *     and it is checked here against `ASSIGNING_PARTNERS` — the two partners — before anything is
 *     sent. An address that is not one of the two is refused whatever the column says.
 *   · THE SWITCH IS THE DEPLOYMENT'S. `WP_OS_AI_EMAIL_PARTNERS` governs "may an employee email the
 *     partners" and was turned on for exactly this, in the diff that added this file.
 *   · THE TRANSPORT DEFUSES TRIGGERS, so a finding that quotes "#wpdealflow" cannot re-enter the
 *     mailbox as a new instruction.
 *
 * Nothing here can reach a founder, an LP, or anyone outside the firm.
 */
export async function replyToRequester(
  env: Env,
  card: { id: string; title: string; requested_by_email?: string | null; firm_scope: string },
  outcome: "DONE" | "BLOCKED",
  who: string,
  detail: string,
): Promise<{ sent: boolean; to: string | null; reason: string }> {
  const to = (card.requested_by_email ?? "").trim().toLowerCase();
  if (!to) return { sent: false, to: null, reason: "the card was not asked for by email" };
  if (!ASSIGNING_PARTNERS.includes(to)) {
    return { sent: false, to, reason: `${to} is not one of the two partner addresses; a reply goes nowhere else` };
  }
  if (!aiOutboundSwitches(env).toPartners) {
    return { sent: false, to, reason: "employees cannot email the partners: WP_OS_AI_EMAIL_PARTNERS is off" };
  }

  const subject = outcome === "DONE" ? `Done: ${card.title.slice(0, 80)}` : `Blocked: ${card.title.slice(0, 80)}`;
  const text = [
    outcome === "DONE" ? `${who} finished what you asked for.` : `${who} is blocked on what you asked for and needs you.`,
    "",
    detail.slice(0, 4000),
    "",
    `The card, with everything that was done on it: https://os.joinwestpeek.com/#/work (card ${card.id})`,
    "",
    "— West Peek OS. Reply to this address and nothing happens; write to os@joinwestpeek.com to ask for something else.",
  ].join("\n");

  let result: { sent: boolean; detail: string; provider_message_id: string | null };
  try {
    result = await sendViaResend(env, { to, subject, text });
  } catch (err) {
    result = { sent: false, detail: err instanceof Error ? err.message : String(err), provider_message_id: null };
  }
  await appendEvent(env, {
    eventType: result.sent ? "work_card.replied_by_email" : "work_card.reply_not_sent",
    actorType: "system",
    actorId: "work_sweep",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { to, outcome, subject, detail: result.detail, provider_message_id: result.provider_message_id },
  });
  return { sent: result.sent, to, reason: result.detail };
}

/**
 * An employee emails a partner a finished deliverable (15 Sep 2026).
 *
 * Operator, on Rooms: "when i request a room they should email me and scooter with the deliverable
 * as well. b/c we requested the room we should get an email with the finished deliverable." And on
 * Walker's monthly work for Scooter's agency: "send him an email 1x per month of potential customer
 * ideas". Same bounds as the reply above, lifted out so every deliverable that leaves by email takes
 * the one door: the destination is checked against the two partner addresses, the switch is the
 * deployment's, the transport defuses triggers, and the send is recorded as an event either way.
 * Nothing here can reach anyone outside the firm.
 */
export async function emailPartnerDeliverable(
  env: Env,
  input: {
    to: string;
    subject: string;
    text: string;
    /** What the email is about, for the event spine. */
    objectType: string;
    objectId: string;
    firmScope: string;
    actorId?: string;
  },
): Promise<{ sent: boolean; to: string; reason: string }> {
  const to = input.to.trim().toLowerCase();
  if (!ASSIGNING_PARTNERS.includes(to)) {
    return { sent: false, to, reason: `${to} is not one of the two partner addresses; a deliverable goes nowhere else` };
  }
  if (!aiOutboundSwitches(env).toPartners) {
    return { sent: false, to, reason: "employees cannot email the partners: WP_OS_AI_EMAIL_PARTNERS is off" };
  }
  let result: { sent: boolean; detail: string; provider_message_id: string | null };
  try {
    result = await sendViaResend(env, { to, subject: input.subject.slice(0, 200), text: input.text.slice(0, 60_000) });
  } catch (err) {
    result = { sent: false, detail: err instanceof Error ? err.message : String(err), provider_message_id: null };
  }
  await appendEvent(env, {
    eventType: result.sent ? "deliverable.emailed_to_partner" : "deliverable.email_not_sent",
    actorType: "system",
    actorId: input.actorId ?? "work_sweep",
    objectType: input.objectType,
    objectId: input.objectId,
    firmScope: input.firmScope,
    payload: { to, subject: input.subject, detail: result.detail, provider_message_id: result.provider_message_id },
  });
  return { sent: result.sent, to, reason: result.detail };
}
