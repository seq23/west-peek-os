import type { Env } from "../env";
import { applyPreviewBoundary, attachmentsBytes, defuseTriggers, OUTBOUND_ATTACHMENTS_MAX_BYTES } from "./emailTransport";
import type { EmailPayload, EmailSendResult } from "./emailTransport";

/**
 * Resend transport for the `email.send` external effect (P33).
 *
 * WHY THIS EXISTS AND IS STILL SWITCHED OFF
 *
 * Five separate V1 commitments — functional inboxes (#36), email integration (#13), Walter's
 * follow-up routing (#29), LP outreach, event invitations — all assume an outbound channel that
 * has never existed. `email.send` has been a governed effect since 0003, correctly wrapped in
 * approval receipts, with a LOCAL SIMULATION where the transport should be. This module is the
 * transport.
 *
 * It is deliberately inert by default. The operator's direction on 17 Aug 2026 was "build the
 * plumbing for emails using the Resend api key... but for now everything can be push notification
 * only and internal". So `isEmailSendEnabled()` returns false unless BOTH a key and an explicit
 * `WP_OS_EMAIL_SEND` = "enabled" are present. Two independent switches, because a credential
 * appearing in the environment is not consent to start emailing people — and a key can arrive for
 * an unrelated reason (a migration, a shared secret store) without anyone deciding to go live.
 *
 * WHAT IT DOES NOT CHANGE: nothing here bypasses approval. executeExternalEffect() still requires
 * an approved, unconsumed, object-matching receipt decided by a human before any adapter runs.
 * This module is only reachable after that gate has already passed.
 *
 * `fetchImpl` is injected rather than closed over so tests exercise the real request-building path
 * without network access — the same pattern feedClient.ts uses.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export type { EmailPayload, EmailSendResult } from "./emailTransport";

/**
 * Both switches must be on. Order matters for the message: an operator who set the flag but has no
 * key should be told the key is missing, not that email is disabled.
 */
export function isEmailSendEnabled(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY) && env.WP_OS_EMAIL_SEND === "enabled";
}

/** Why sending is off, phrased for the person who has to fix it. */
export function emailSendBlockedReason(env: Env): string | null {
  if (!env.RESEND_API_KEY) return "No Resend API key is configured for this environment.";
  if (env.WP_OS_EMAIL_SEND !== "enabled") {
    return "Email sending is switched off. Set WP_OS_EMAIL_SEND=enabled to turn it on; until then approved emails are recorded, not sent.";
  }
  return null;
}

/** A recipient we will not send to. Keeps an obviously broken address from reaching the provider. */
export function isDeliverableAddress(to: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to.trim());
}

/**
 * Send one email through Resend.
 *
 * Throws on a non-2xx so the caller records the effect as FAILED rather than EXECUTED — an email
 * the provider rejected must never leave an "executed" receipt behind, because that receipt is
 * what the audit trail treats as proof the message went out.
 */
export async function sendViaResend(
  env: Env,
  request: EmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailSendResult> {
  /*
   * THE SEND BOUNDARY, FIRST — before the key is read, before a recipient is validated, before any
   * request exists. In preview mode this REPLACES the recipient list with Sequoia's address alone
   * and stamps the header; outside preview it returns the payload untouched. See
   * `applyPreviewBoundary` in emailTransport.ts for why the rule lives at the transport rather than
   * in each of the callers that can reach one.
   */
  const payload = applyPreviewBoundary(env, request);
  const blocked = emailSendBlockedReason(env);
  if (blocked) return { sent: false, provider: "resend", provider_message_id: null, detail: blocked };

  const recipients = [payload.to].flat();
  const bad = recipients.find((a) => !isDeliverableAddress(a));
  if (recipients.length === 0 || bad !== undefined) {
    throw new Error(`refusing to send: "${bad ?? ""}" is not a valid email address`);
  }

  const from = payload.from ?? env.WP_OS_EMAIL_FROM;
  if (!from) throw new Error("no sender address configured (WP_OS_EMAIL_FROM)");
  // THE CAP AT THE TRANSPORT (0253), so no composer can send a library. The composer links instead.
  if (attachmentsBytes(payload.attachments) > OUTBOUND_ATTACHMENTS_MAX_BYTES) {
    throw new Error(`refusing to send: attachments total ${attachmentsBytes(payload.attachments)} bytes, over the ${OUTBOUND_ATTACHMENTS_MAX_BYTES}-byte cap`);
  }

  // Applied at the transport, not the composer, so no future caller can forget it. See
  // defuseTriggers: Network OS's Gmail sync matches trigger words in ANY mail including Sent, so a
  // digest that writes "#wpdealflow" is ingested as a submission and loops back here.
  const subject = defuseTriggers(payload.subject);
  const text = defuseTriggers(payload.text);
  const html = payload.html ? defuseTriggers(payload.html) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipients,
        ...(payload.cc && payload.cc.length ? { cc: [...payload.cc] } : {}),
        subject,
        text,
        ...(html ? { html } : {}),
        ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
        // Custom headers, documented by Resend with `In-Reply-To` and `References` named. Never a
        // `Message-ID`: SES overrides it, so one set here would be a thread key that never arrives.
        ...(payload.headers && Object.keys(payload.headers).length > 0 ? { headers: payload.headers } : {}),
        // 0253: Resend takes `attachments: [{ filename, content (base64), content_type }]`.
        ...(payload.attachments && payload.attachments.length > 0
          ? { attachments: payload.attachments.map((a) => ({ filename: a.filename, content: a.content, ...(a.contentType ? { content_type: a.contentType } : {}) })) }
          : {}),
      }),
      signal: controller.signal,
    });

    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      // Deliberately does not echo the whole provider body: it can contain the message we tried to
      // send, and this string ends up in an event payload and an error surface.
      throw new Error(`resend rejected the send (HTTP ${res.status})`);
    }
    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(bodyText) as { id?: string }).id ?? null;
    } catch {
      messageId = null;
    }
    return {
      sent: true,
      provider: "resend",
      provider_message_id: messageId,
      // The FROM is on the receipt deliberately. Once a partner can send under their own name, the
      // question an audit asks is not only whether a message went out but whose name was on it.
      detail: `Delivered to ${recipients.join(", ")} as ${from} via Resend`,
    };
  } finally {
    clearTimeout(timer);
  }
}
