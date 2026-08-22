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
  /** "gmail" means it went through a partner's own account and is in their Sent folder. */
  provider: "resend" | "cloudflare" | "gmail";
  /** Null when the transport does not issue one. Better a gap than a fabricated identifier. */
  provider_message_id: string | null;
  detail: string;
}

/**
 * Neutralise trigger hashtags in outbound mail.
 *
 * THE LOOP THIS PREVENTS, found while checking whether the two mailbox rules could collide.
 * Network OS's Gmail sync runs the query `{#wpnetwork #wpdealflow …}` with no `in:inbox`
 * restriction — it matches any mail carrying a trigger, including Sent. So the first digest this
 * app emails a partner saying "3 new companies via #wpdealflow this week" is ingested by Network
 * OS as a submission, which syncs back here, which appears in the next digest.
 *
 * The operator's own read was that nothing needs to change as long as a message is not sent to
 * os@joinwestpeek.com AND a westpeek.ventures address at once. That is right about ADDRESSING and
 * this is the part it does not cover: the collision is not who it was sent to, it is that the app
 * writes the trigger word at all.
 *
 * A ZERO-WIDTH JOINER after the hash, so it reads identically to a human and matches nothing. The
 * alternative — refusing to send a message containing a trigger — would block the firm from ever
 * writing about its own intake in an email, which is a worse cure than the disease.
 *
 * NETWORK OS'S DEDUPE DOES NOT MAKE THIS UNNECESSARY, and it is worth saying why, because the
 * dedupe is real: `findDuplicateContact` matches on lowercased email first, then name plus company.
 * So a PERSON who arrives twice does land once. Three things survive that:
 *
 *   1. Dedupe protects the contact record, not the queue. Every loop iteration still files an
 *      intake row and a sync cycle, so a weekly digest quoting a trigger produces a fresh item to
 *      dismiss every week, forever, while collapsing to one contact.
 *   2. A digest is not a submission. Ingesting the firm's own reporting as intake is wrong data
 *      rather than duplicate data, and dedupe has no opinion about wrong.
 *   3. `#wpdealflow` in a digest is not a person at all. It classifies as deal flow, which lands in
 *      THIS app's funnel — a different system, with a different dedupe, on a different record type.
 */
const TRIGGER_WORDS = /#(wpnetwork|wpdealflow|wpdeck|addtowestpeek|westpeeknetwork|dealflow)\b/gi;

export function defuseTriggers(text: string): string {
  return text.replace(TRIGGER_WORDS, (m) => `#‍${m.slice(1)}`);
}

/** True when a message would be re-ingested by Network OS if sent as written. */
export function wouldLoop(text: string): boolean {
  TRIGGER_WORDS.lastIndex = 0;
  return TRIGGER_WORDS.test(text);
}
