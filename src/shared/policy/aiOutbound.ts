/**
 * Whether an AI employee may send mail, and to whom.
 *
 * Operator, 21 Aug 2026: "no ai employee should be able to email anything to anyone right now, but
 * the plumbing and structure and scaffolding should be there for them to a) email the MPs and b) one
 * day later email the outside world, with a separate flip switch for each."
 *
 * TWO SWITCHES AND NOT ONE, because they are different decisions with different blast radii. An
 * employee emailing the partners is an internal convenience: the worst case is a partner reads
 * something wrong, in their own inbox, and says so. An employee emailing the outside world is the
 * firm speaking — to a founder, an LP, a co-investor — and there is no undo. Collapsing them into a
 * single "AI email" flag would mean turning on the harmless one turns on the other.
 *
 * BOTH DEFAULT OFF, and off means off in code rather than in a comment. An unset environment
 * variable reads as disabled: the failure mode of a missing config must be silence, never a firm
 * emailing people because nobody set a flag.
 *
 * THIS DOES NOT GOVERN HUMANS. A Managing Partner sending mail is unaffected — these switches are
 * about who may act unattended, and a person pressing send is attended by definition.
 *
 * IT IS NOT THE ONLY LOCK. `email.send` is an external effect and already requires an approved,
 * unconsumed receipt, and an AI can never approve anything including its own work. So an employee
 * cannot send today even with both switches on. That overlap is deliberate: this is the switch a
 * partner can see and reason about, and the receipt is the one that cannot be forgotten.
 */

export type AiEmailAudience = "PARTNERS" | "EXTERNAL";

export interface AiOutboundSwitches {
  toPartners: boolean;
  toExternal: boolean;
}

/**
 * Read the switches. Anything other than the exact string "enabled" is off — a typo, an empty
 * string and an unset variable all mean the same thing, and that thing is no.
 */
export function aiOutboundSwitches(env: {
  WP_OS_AI_EMAIL_PARTNERS?: string;
  WP_OS_AI_EMAIL_EXTERNAL?: string;
}): AiOutboundSwitches {
  return {
    toPartners: env.WP_OS_AI_EMAIL_PARTNERS === "enabled",
    toExternal: env.WP_OS_AI_EMAIL_EXTERNAL === "enabled",
  };
}

/**
 * Which audience an address belongs to.
 *
 * Anything not provably a partner is EXTERNAL. That asymmetry is the point: a misclassified partner
 * address costs a blocked email somebody can unblock, and a misclassified outside address costs the
 * firm a message it did not mean to send.
 */
export function audienceOf(address: string, partnerAddresses: readonly string[]): AiEmailAudience {
  const to = address.trim().toLowerCase();
  return partnerAddresses.some((p) => p.trim().toLowerCase() === to) ? "PARTNERS" : "EXTERNAL";
}

export interface AiOutboundDecision {
  allowed: boolean;
  audience: AiEmailAudience;
  /** Phrased for the partner reading it, not for a log. */
  reason: string;
}

export function mayAiEmail(
  switches: AiOutboundSwitches,
  address: string,
  partnerAddresses: readonly string[],
): AiOutboundDecision {
  const audience = audienceOf(address, partnerAddresses);
  if (audience === "PARTNERS") {
    return switches.toPartners
      ? { allowed: true, audience, reason: "Employees may email the partners." }
      : { allowed: false, audience, reason: "Employees cannot email the partners yet. That switch is off." };
  }
  return switches.toExternal
    ? { allowed: true, audience, reason: "Employees may email outside the firm." }
    : {
        allowed: false,
        audience,
        reason: "Employees cannot email anybody outside the firm. That switch is off, and it is the one with no undo.",
      };
}
