import type { Env } from "../env";
import type { EmailPayload, EmailSendResult } from "./emailTransport";

/**
 * Cloudflare Email Sending transport for the `email.send` external effect.
 *
 * WHY A SECOND TRANSPORT. The Resend path works and stays. This one exists because it removes the
 * two pieces of setup that were standing between this firm and outbound mail: there is no API key
 * to create, store and rotate, and no third party in the path — the domain is already on this
 * account, and sending is a Worker binding.
 *
 * IT IS A BINDING, NOT A FETCH, and that is the architectural difference rather than a detail.
 * `env.EMAIL.send()` never opens an HTTP connection from this code, so it needs no entry in
 * EGRESS_ALLOWED and cannot be reached by anything that has not been given the binding. The
 * authority scan treats it exactly as it treats the browser binding: not egress, because it is not
 * fetch.
 *
 * NOTHING HERE WEAKENS THE GATE. Both switches still apply — a transport being available is not
 * consent to start emailing people — and this module is only reachable after executeExternalEffect
 * has an approved, unconsumed, object-matching receipt decided by a human. What changed is which
 * pipe the message goes down, never who may send one.
 *
 * WHY THE FROM ADDRESS IS NOT FREE TEXT. Cloudflare will only send from a domain onboarded to Email
 * Sending on this account. An unonboarded sender does not bounce later — it is refused outright —
 * so the reason names the domain rather than reporting a generic failure a week after somebody
 * changed a config.
 */

/**
 * The platform's own binding type, from @cloudflare/workers-types. Aliased rather than re-declared
 * because a hand-written copy silently rots the moment the platform changes — and this file is the
 * only place in the system allowed to touch the binding, so the alias costs nothing.
 */
type SendEmailBinding = SendEmail;

/** The address mail goes out as. Configured, because it must match an onboarded domain. */
export function emailFromAddress(env: Env): string | null {
  const configured = env.WP_OS_EMAIL_FROM;
  return configured && configured.trim().length > 0 ? configured.trim() : null;
}

/**
 * Both switches, as with Resend, plus the binding itself.
 *
 * The binding replaces the API key as the first switch: it is the thing whose presence means "this
 * environment CAN send". WP_OS_EMAIL_SEND remains the second and is still a separate decision,
 * because a binding arriving in a config is not consent to start emailing people any more than a
 * credential appearing in an environment was.
 */
export function isCloudflareEmailEnabled(env: Env): boolean {
  const binding = env.EMAIL;
  return Boolean(binding) && Boolean(emailFromAddress(env)) && env.WP_OS_EMAIL_SEND === "enabled";
}

/** Why it is off, phrased for whoever has to fix it. */
export function cloudflareEmailBlockedReason(env: Env): string | null {
  const binding = env.EMAIL;
  if (!binding) {
    return "No email binding in this environment — add send_email to wrangler.toml and deploy.";
  }
  if (!emailFromAddress(env)) {
    return "No sending address configured. Set WP_OS_EMAIL_FROM to an address on a domain onboarded to Email Sending.";
  }
  if (env.WP_OS_EMAIL_SEND !== "enabled") {
    return "Email sending is switched off. Set WP_OS_EMAIL_SEND=enabled to turn it on; until then approved emails are recorded, not sent.";
  }
  return null;
}

/**
 * Send one email through Cloudflare.
 *
 * Throws on failure so the caller records the effect as FAILED rather than EXECUTED. An email the
 * platform rejected must never leave an "executed" receipt behind, because that receipt is what the
 * audit trail treats as proof the message went out.
 *
 * Plain text only, matching the Resend path: nothing in the product composes HTML mail yet, and a
 * text part is the one every client renders.
 */
export async function sendViaCloudflare(
  env: Env,
  payload: EmailPayload,
  binding?: SendEmailBinding,
): Promise<EmailSendResult> {
  const email = binding ?? env.EMAIL;
  const from = payload.from ?? emailFromAddress(env);

  if (!email) throw new Error("no email binding is available in this environment");
  if (!from) throw new Error("no sending address is configured");

  const result = await email.send({
    to: payload.to,
    from: { email: from, name: "West Peek Ventures" },
    subject: payload.subject,
    text: payload.text,
  });

  // The real message id, straight from the platform. It is what makes the receipt checkable against
  // Cloudflare's own delivery log rather than merely our claim that we sent something.
  const messageId = result?.messageId ?? null;

  return {
    sent: true,
    provider: "cloudflare",
    provider_message_id: messageId,
    detail: `Sent to ${payload.to} via Cloudflare from ${from}${messageId ? ` (${messageId})` : ""}.`,
  };
}
