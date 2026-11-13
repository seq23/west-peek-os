/**
 * THE FIRM'S OWN "(ignore)" TEST SEND OPENS NOTHING (6 Nov 2026, wc_aa2d2450… and wc_11f16477…).
 *
 * A session checking a new forms/Resend key sent "Form key check (ignore)" and "Forms key check (ignore)" from
 * hello@joinwestpeek.com — the firm's own sending address — to os@. The door saw a stranger with no tag and opened
 * two "Unclear email" cards for Porter; the first spent three attempts and four Mac seat runs deciding that a message
 * whose subject says "ignore" should be ignored.
 *
 * Narrow on purpose: ALL of (a) From on the firm's own sending domain, (b) DMARC-aligned and signed by that domain,
 * so nobody outside can forge their way into the drop, (c) not a partner, and (d) the subject explicitly marked
 * "(ignore)" / "[ignore]" / "(test)" / "[test]" at its start or end. The message is still kept and an
 * `inbound_email.self_test` event is written, so the arrival is visible; it simply asks no employee to think about it.
 *
 * "[probe]" IS THE SAME THING (13 Nov 2026, #360). The forms-mailer's daily signed form check arrives as
 * "[probe] New enquiry from …" from the same address, and opened an "Unclear email" card every day from 6 Nov (12
 * cards, each at least one Mac seat run). Its alarm does not read this inbox: it judges the two send calls' own
 * answers (join-west-peek-main, RUNBOOK "Lead delivery and alarms"), so dropping the card here costs it nothing.
 */
export const FIRM_SENDING_DOMAIN = "joinwestpeek.com";

const MARK = /(?:^\s*[([](?:ignore|test|probe)[)\]]|[([](?:ignore|test|probe)[)\]]\s*$)/i;

export function isFirmSelfTest(input: {
  from: string | null;
  subject: string;
  verdict: { passed: boolean; signing_domain: string | null };
  isPartner: boolean;
}): boolean {
  const from = (input.from ?? "").trim().toLowerCase();
  if (!from.endsWith(`@${FIRM_SENDING_DOMAIN}`)) return false;
  if (!input.verdict.passed || (input.verdict.signing_domain ?? "").toLowerCase() !== FIRM_SENDING_DOMAIN) return false;
  if (input.isPartner) return false;
  return MARK.test(input.subject);
}
