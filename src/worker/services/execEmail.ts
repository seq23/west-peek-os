import type { Env } from "../env";
import { appendEvent } from "../events";
import { sendViaResend } from "../effects/resendClient";
import { isCloudflareEmailEnabled, sendViaCloudflare } from "../effects/cloudflareEmailClient";
import type { EmailSendResult } from "../effects/emailTransport";
import { aiOutboundSwitches } from "../../shared/policy/aiOutbound";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../../shared/intake/emailTriggers";
import { lintExecEmail, renderExecEmail, type ExecEmailInput } from "../../shared/email/execEmail";
import { recordThreadDelivery, startThread } from "./emailThread";
import { threadReference } from "../../shared/email/thread";
import { EmployeeSenderError, employeeSenderHeader } from "../../shared/registry/employeeMail";

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
 *   5. REPLIES GO TO THE INTAKE MAILBOX. Reply-To is os@joinwestpeek.com, so a reply becomes a
 *      routed request like any other, whatever employee address shows as "From" — which is also
 *      why the footer names os@joinwestpeek.com by address rather than inviting a reply to
 *      whichever employee sent it: employee mailboxes carry no inbound MX and would hard-bounce
 *      a reply typed to them directly (22 Sep 2026).
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
  /**
   * The `work_card.kind` this note is about, when it is about one.
   *
   * WHY THE KIND AND NOT ONLY THE CARD. A weekly duty opens a NEW card every week and closes it the
   * same day, so a reply that arrives on Thursday is answering a card that is already DONE. Carrying
   * the kind is what lets the reply steer the WORK — next Monday's run and the one after — rather
   * than a row nothing will read again. See migration 0180.
   */
  cardKind?: string | null;
  /**
   * 21 Sep 2026: an earlier note's thread token. The new message carries it in `References` beside
   * its own, and `In-Reply-To` names it, so a mail client shows one conversation — the RECEIVED
   * that retires a mistaken "blocked" note lands under that note, not beside it.
   */
  replyOnThread?: string | null;
}

export interface PartnerEmailOutcome {
  sent: boolean;
  to: string;
  reason: string;
  subject: string;
  /** The conversation a reply to this message will be matched to. Null on the copy-to-self path. */
  threadToken?: string | null;
}

/**
 * WHOSE NAME IS ON IT — the one place any employee's outbound mail resolves its `From` (22 Sep 2026).
 *
 * THE DEFECT THIS CLOSES, seen in production the same day. One card, one employee, TWO sender
 * addresses on TWO domains. Porter's intake notice left as `os@westpeek.ventures` and his
 * finished-work email left as `Porter · West Peek <porter@joinwestpeek.com>` — the same
 * conversation, split across the firm's LP-facing identity and the employee's own, which fragments
 * the thread in the partner's mail client and reads as two correspondents.
 *
 * THE CAUSE WAS AN OMISSION, NOT A WRONG VALUE, which is why `validate:employee-sender` was green
 * throughout: that scan catches a HARDCODED employee address, and there was none. `transport()`
 * simply never set `from` at all, so every message through this door fell through to
 * `sendViaResend`'s `env.WP_OS_EMAIL_FROM` fallback — the FIRM's address. Only
 * `previewApproval.sendApproved` named a sender, so the one lane that went through her preview was
 * the one lane that signed correctly. "Runs but inert" with a plausible-looking result.
 *
 * SO THE SENDER IS RESOLVED HERE AND NOWHERE ELSE, from the roster, through
 * `employeeSenderHeader` — the same function `sendApproved` and `effects/executor.ts` already ask.
 * It THROWS for a name that is not on the roster and that throw is kept: a caller that cannot name
 * an employee has a bug, and a silent fall-back to the firm's address is precisely how this one
 * stayed invisible for a week.
 */
function senderFor(employee: string): { from: string } | { refusal: string } {
  try {
    return { from: employeeSenderHeader(employee) };
  } catch (err) {
    const why = err instanceof EmployeeSenderError ? err.message : err instanceof Error ? err.message : String(err);
    return { refusal: `not sent — no sender could be resolved for "${employee}": ${why}` };
  }
}

async function transport(
  env: Env,
  message: { to: string | readonly string[]; subject: string; text: string; html: string; from: string; headers?: Record<string, string> },
): Promise<EmailSendResult> {
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
  // BEFORE THE THREAD IS MINTED. An unresolvable sender must not leave an `email_thread` row behind
  // pointing at a conversation that never happened — a reply matched to it would steer real work.
  const sender = senderFor(input.email.employee);
  if ("refusal" in sender) {
    await record(env, actor, events.notSent, { to, subject: rendered.subject, detail: sender.refusal, provider_message_id: null });
    return { sent: false, to, reason: sender.refusal, subject: rendered.subject };
  }

  /*
   * THE THREAD THIS NOTE STARTS — 7 · REPLIES.
   *
   * Every employee-to-partner note now carries a token in its `References` header, and a partner's
   * reply carries it back. That is what lets "not this one" be matched to the search it is about
   * without a code in the subject (which RFC 2047 eats) and without `provider_message_id` (which is
   * not the Message-ID a reply points at — see shared/email/thread.ts, confirmed against both
   * transports' documentation).
   *
   * MINTED BEFORE THE SEND, because a reply can arrive within seconds of one.
   */
  const thread = await startThread(env, {
    objectType: input.objectType,
    objectId: input.objectId,
    cardKind: input.cardKind ?? null,
    employee: input.email.employee,
    to,
    subject: rendered.subject,
    firmScope: input.firmScope,
  });

  let result: EmailSendResult;
  try {
    const headers = input.replyOnThread
      ? { References: `${threadReference(input.replyOnThread)} ${thread.headers.References}`, "In-Reply-To": threadReference(input.replyOnThread) }
      : thread.headers;
    result = await transport(env, { to, subject: rendered.subject, text: rendered.text, html: rendered.html, from: sender.from, headers });
  } catch (err) {
    result = { sent: false, provider: "resend", detail: err instanceof Error ? err.message : String(err), provider_message_id: null };
  }
  if (result.sent) await recordThreadDelivery(env, thread.token, result);
  await record(env, actor, result.sent ? events.sent : events.notSent, {
    to, subject: rendered.subject, detail: result.detail, provider_message_id: result.provider_message_id,
    thread_token: thread.token,
  });
  return { sent: result.sent, to, reason: result.detail, subject: rendered.subject, threadToken: thread.token };
}

/**
 * ONE MESSAGE, ADDRESSED TO BOTH PARTNERS — the door for something they decide together.
 *
 * Operator, 17 Sep 2026: "One for Rooms, one for Workshops, each addressed to Sequoia and Scooter
 * together. Not one per angle, not one per person."
 *
 * WHY THIS IS NOT `sendPartnerEmail` TWICE, which is what it used to be. Two messages are two
 * conversations about one decision: a reply lands on one of them, and the other partner's copy
 * shows no sign that anything was answered. With a per-packet reply token in the mail (item 7),
 * that is worse than untidy — the second copy carries a code that has already been spent and
 * nothing in front of the reader says so.
 *
 * EVERY GATE IS THE SAME ONE. Destination-restricted to the two assigning partner addresses, the
 * employee switch, the format lint before any transport sees it, Reply-To, and one event per
 * attempt. This adds a recipient list; it does not add a way to reach anybody new.
 */
export async function sendPartnersEmail(
  env: Env,
  input: Omit<PartnerEmailInput, "to"> & { to: readonly string[] },
): Promise<PartnerEmailOutcome & { recipients: string[] }> {
  const to = input.to.map((a) => a.trim().toLowerCase());
  const rendered = renderExecEmail(input.email);
  const events = input.events ?? { sent: "deliverable.emailed_to_partner", notSent: "deliverable.email_not_sent" };
  const actor = { objectType: input.objectType, objectId: input.objectId, firmScope: input.firmScope, actorId: input.actorId ?? "work_sweep", actorType: "system" as const };
  const joined = to.join(", ");

  const stranger = to.find((a) => !ASSIGNING_PARTNERS.includes(a));
  if (to.length === 0 || stranger) {
    return { sent: false, to: joined, recipients: to, reason: `${stranger ?? "nobody"} is not one of the two partner addresses; an employee's email goes nowhere else`, subject: rendered.subject };
  }
  if (!aiOutboundSwitches(env).toPartners) {
    return { sent: false, to: joined, recipients: to, reason: "employees cannot email the partners: WP_OS_AI_EMAIL_PARTNERS is off", subject: rendered.subject };
  }
  const violations = lintExecEmail(rendered.subject, rendered.text, input.email.employee);
  if (violations.length > 0) {
    const reason = `not sent — the email does not meet the format: ${violations.join("; ")}`;
    await record(env, actor, events.notSent, { to, subject: rendered.subject, detail: reason, provider_message_id: null, violations });
    return { sent: false, to: joined, recipients: to, reason, subject: rendered.subject };
  }
  const sender = senderFor(input.email.employee);
  if ("refusal" in sender) {
    await record(env, actor, events.notSent, { to, subject: rendered.subject, detail: sender.refusal, provider_message_id: null });
    return { sent: false, to: joined, recipients: to, reason: sender.refusal, subject: rendered.subject };
  }

  let result: EmailSendResult;
  try {
    result = await transport(env, { to, subject: rendered.subject, text: rendered.text, html: rendered.html, from: sender.from });
  } catch (err) {
    result = { sent: false, provider: "resend", detail: err instanceof Error ? err.message : String(err), provider_message_id: null };
  }
  await record(env, actor, result.sent ? events.sent : events.notSent, {
    to, subject: rendered.subject, detail: result.detail, provider_message_id: result.provider_message_id,
  });
  return { sent: result.sent, to: joined, recipients: to, reason: result.detail, subject: rendered.subject };
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
  /*
   * THE EMPLOYEE SIGNS THIS ONE TOO. A partner pressing "email me a copy" is asking for the copy
   * of an employee's work; the message is that employee's words, so it carries that employee's
   * name — not the firm's generic address, which is what the missing `from` used to make it.
   */
  const sender = senderFor(input.email.employee);
  if ("refusal" in sender) {
    await record(env, actor, "deliverable.emailed", { to: input.recipient.id, sent: false, provider: null, detail: sender.refusal });
    return { sent: false, to, reason: sender.refusal, subject: rendered.subject };
  }
  let result: EmailSendResult;
  try {
    result = await transport(env, { to, subject: rendered.subject, text: rendered.text, html: rendered.html, from: sender.from });
  } catch (err) {
    result = { sent: false, provider: "resend", detail: err instanceof Error ? err.message : String(err), provider_message_id: null };
  }
  await record(env, actor, "deliverable.emailed", { to: input.recipient.id, sent: result.sent, provider: result.provider, detail: result.detail });
  return { sent: result.sent, to, reason: result.detail, subject: rendered.subject };
}
