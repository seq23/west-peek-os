import type { Env } from "../env";
import { appendEvent } from "../events";
import { sendViaResend } from "../effects/resendClient";
import { isCloudflareEmailEnabled, sendViaCloudflare } from "../effects/cloudflareEmailClient";
import type { EmailSendResult } from "../effects/emailTransport";
import { aiOutboundSwitches } from "../../shared/policy/aiOutbound";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../../shared/intake/emailTriggers";
import { lintExecEmail, renderExecEmail, type ExecEmailInput } from "../../shared/email/execEmail";

/**
 * THE ONE DOOR an email to a partner leaves through (16 Sep 2026).
 *
 * Every email an employee sends a partner — the reply to a request, a finished deliverable,
 * Walker's monthly note, Parker's Room packet, the blog help, and the copy a partner asks Home to
 * send them — is composed as an `ExecEmailInput` (TL;DR, labelled sections, details, footer) and
 * sent from here. Nothing else in `src/worker/services/` may call a transport;
 * `scripts/validate/partner-email-boundary.mjs` fails the build if something does.
 *
 * WHAT IS ENFORCED HERE, IN ORDER:
 *   1. THE DESTINATION. `sendPartnerEmail` sends only to the two partner addresses, whatever a
 *      caller passes. `sendFirmUserCopy` sends only to a firm_user's registered address, and only
 *      because a person pressed the button for their own copy. Neither can reach anyone outside
 *      the firm — founders, LPs, journalists go through the approved external-effect path.
 *   2. THE SWITCH. An employee's mail needs `WP_OS_AI_EMAIL_PARTNERS` on; a partner's own copy
 *      does not, because it is not an employee deciding to write.
 *   3. THE FORMAT. The message is rendered by `renderExecEmail` and then checked by
 *      `lintExecEmail`. A message that fails the lint is NOT sent; the refusal is recorded with
 *      the violations so it is a diagnosable failure, not a quietly ugly email.
 *   4. THE TRANSPORT DEFUSES TRIGGERS, so a quoted "#wpdealflow" cannot re-enter the mailbox.
 *   5. REPLIES GO TO THE INTAKE MAILBOX. Reply-To is os@joinwestpeek.com, which is why the footer
 *      can honestly say "reply to this email" — a reply becomes a routed request like any other.
 *   6. IT IS ON THE RECORD either way: one event per attempt, sent or not.
 */

export interface PartnerEmailInput {
  to: string;
  email: ExecEmailInput;
  /** What the email is about, for the event spine. */
  objectType: string;
  objectId: string;
  firmScope: string;
  /** The employee (aie_*) or system actor sending it; defaults to the sweep. */
  actorId?: string;
  /** Event names, so a caller's existing tests and readers keep their vocabulary. */
  events?: { sent: string; notSent: string };
}

export interface PartnerEmailOutcome {
  sent: boolean;
  to: string;
  reason: string;
  subject: string;
}

async function transport(env: Env, message: { to: string; subject: string; text: string; html: string }): Promise<EmailSendResult> {
  const payload = { ...message, replyTo: INTAKE_MAILBOX };
  return isCloudflareEmailEnabled(env) ? await sendViaCloudflare(env, payload) : await sendViaResend(env, payload);
}

async function record(
  env: Env,
  input: { objectType: string; objectId: string; firmScope: string; actorId: string; actorType: "system" | "ai_employee" | "firm_user" },
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendEvent(env, {
    eventType,
    actorType: input.actorType,
    actorId: input.actorId,
    objectType: input.objectType,
    objectId: input.objectId,
    firmScope: input.firmScope,
    payload,
  });
}

/**
 * An employee emails a partner. The only way one does.
 */
export async function sendPartnerEmail(env: Env, input: PartnerEmailInput): Promise<PartnerEmailOutcome> {
  const to = input.to.trim().toLowerCase();
  const rendered = renderExecEmail(input.email);
  const events = input.events ?? { sent: "deliverable.emailed_to_partner", notSent: "deliverable.email_not_sent" };
  const actor = { objectType: input.objectType, objectId: input.objectId, firmScope: input.firmScope, actorId: input.actorId ?? "work_sweep", actorType: "system" as const };

  if (!ASSIGNING_PARTNERS.includes(to)) {
    return { sent: false, to, reason: `${to} is not one of the two partner addresses; an employee's email goes nowhere else`, subject: rendered.subject };
  }
  if (!aiOutboundSwitches(env).toPartners) {
    return { sent: false, to, reason: "employees cannot email the partners: WP_OS_AI_EMAIL_PARTNERS is off", subject: rendered.subject };
  }
  const violations = lintExecEmail(rendered.subject, rendered.text, input.email.employee);
  if (violations.length > 0) {
    const reason = `not sent — the email does not meet the format: ${violations.join("; ")}`;
    await record(env, actor, events.notSent, { to, subject: rendered.subject, detail: reason, provider_message_id: null, violations });
    return { sent: false, to, reason, subject: rendered.subject };
  }

  let result: EmailSendResult;
  try {
    result = await transport(env, { to, subject: rendered.subject, text: rendered.text, html: rendered.html });
  } catch (err) {
    result = { sent: false, provider: "resend", detail: err instanceof Error ? err.message : String(err), provider_message_id: null };
  }
  await record(env, actor, result.sent ? events.sent : events.notSent, {
    to, subject: rendered.subject, detail: result.detail, provider_message_id: result.provider_message_id,
  });
  return { sent: result.sent, to, reason: result.detail, subject: rendered.subject };
}

/**
 * A partner asks Home to email them a copy of something already prepared for them. Same layout,
 * same transport, no employee switch — a person pressed the button for their own inbox. The
 * recipient is a `firm_user` row the caller resolved; a typed address cannot reach this.
 */
export async function sendFirmUserCopy(
  env: Env,
  input: { recipient: { id: string; email: string }; email: ExecEmailInput; objectType: string; objectId: string; firmScope: string; byFirmUserId: string },
): Promise<PartnerEmailOutcome> {
  const rendered = renderExecEmail(input.email);
  const to = input.recipient.email.trim().toLowerCase();
  const actor = { objectType: input.objectType, objectId: input.objectId, firmScope: input.firmScope, actorId: input.byFirmUserId, actorType: "firm_user" as const };
  const violations = lintExecEmail(rendered.subject, rendered.text, input.email.employee);
  if (violations.length > 0) {
    const reason = `not sent — the email does not meet the format: ${violations.join("; ")}`;
    await record(env, actor, "deliverable.emailed", { to: input.recipient.id, sent: false, provider: null, detail: reason, violations });
    return { sent: false, to, reason, subject: rendered.subject };
  }
  let result: EmailSendResult;
  try {
    result = await transport(env, { to, subject: rendered.subject, text: rendered.text, html: rendered.html });
  } catch (err) {
    result = { sent: false, provider: "resend", detail: err instanceof Error ? err.message : String(err), provider_message_id: null };
  }
  await record(env, actor, "deliverable.emailed", { to: input.recipient.id, sent: result.sent, provider: result.provider, detail: result.detail });
  return { sent: result.sent, to, reason: result.detail, subject: rendered.subject };
}
