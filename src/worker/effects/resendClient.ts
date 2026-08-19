import type { Env } from "../env";
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
  payload: EmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailSendResult> {
  const blocked = emailSendBlockedReason(env);
  if (blocked) return { sent: false, provider: "resend", provider_message_id: null, detail: blocked };

  if (!isDeliverableAddress(payload.to)) {
    throw new Error(`refusing to send: "${payload.to}" is not a valid email address`);
  }

  const from = payload.from ?? env.WP_OS_EMAIL_FROM;
  if (!from) throw new Error("no sender address configured (WP_OS_EMAIL_FROM)");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: [payload.to], subject: payload.subject, text: payload.text }),
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
      detail: `Delivered to ${payload.to} as ${from} via Resend`,
    };
  } finally {
    clearTimeout(timer);
  }
}
