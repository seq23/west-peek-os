/**
 * What every outbound email transport agrees on.
 *
 * This lives apart from any one transport because there are now two — Cloudflare's binding and
 * Resend's API — and a shared contract owned by one of them would make the other a second-class
 * citizen of its own interface. Both implement this; the executor picks between them.
 *
 * `provider` is the discriminator, and it is on the RESULT rather than inferred at the call site
 * because it ends up on the audit trail. When somebody asks how a message left the building a year
 * from now, the receipt should say, not the reader reconstruct it from which switches were set.
 */

export interface EmailPayload {
  to: string;
  subject: string;
  /** Plain text. No HTML path yet: nothing in the product composes HTML mail. */
  text: string;
  from?: string;
}

export interface EmailSendResult {
  sent: boolean;
  provider: "resend" | "cloudflare";
  /** Null when the transport does not issue one. Better a gap than a fabricated identifier. */
  provider_message_id: string | null;
  detail: string;
}
