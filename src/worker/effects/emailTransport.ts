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
  /**
   * One address, or SEVERAL when one message is addressed to more than one person.
   *
   * Several, added 17 Sep 2026 for Parker's monthly packets. Operator: "One for Rooms, one for
   * Workshops, each addressed to Sequoia and Scooter together… not one per person." Two separate
   * messages are two conversations about one decision — a reply on one is invisible on the other,
   * and the second partner cannot see that the first already answered. Both transports take a list
   * natively (Cloudflare's `EmailDestinations.to`, Resend's `to`), so this is a widening of the
   * type rather than a second send path.
   */
  to: string | readonly string[];
  subject: string;
  /** Plain text. Always present: the part every client renders and every log can read. */
  text: string;
  /**
   * An optional HTML part carrying the SAME content as `text`, laid out. Composed only by
   * `services/execEmail.ts`, the one place an employee's email to a partner is put together; a
   * transport never invents one.
   */
  html?: string;
  from?: string;
  /** Where a reply should go when it is not the sender — the intake mailbox, for an employee's mail. */
  replyTo?: string;
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
/*
 * This list is HAND-MAINTAINED and it is wider than `EMAIL_TRIGGERS`, which is why it cannot be
 * generated from it: `#addtowestpeek`, `#westpeeknetwork` and `#dealflow` are Network OS's aliases
 * and this app has never published them. The cost of that is real — a trigger added to the registry
 * must be added here too, and `#wpupdate` (item 12) was. A portfolio digest that quotes the tag
 * loops otherwise, and this time the loop would carry a company's own reported figures.
 */
const TRIGGER_WORDS = /#(wpnetwork|wpdealflow|wpdeck|wpupdate|addtowestpeek|westpeeknetwork|dealflow)\b/gi;

export function defuseTriggers(text: string): string {
  return text.replace(TRIGGER_WORDS, (m) => `#‍${m.slice(1)}`);
}

/** True when a message would be re-ingested by Network OS if sent as written. */
export function wouldLoop(text: string): boolean {
  TRIGGER_WORDS.lastIndex = 0;
  return TRIGGER_WORDS.test(text);
}
