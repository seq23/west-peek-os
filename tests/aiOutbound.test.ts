import { describe, expect, it } from "vitest";
import { aiOutboundSwitches, audienceOf, mayAiEmail } from "../src/shared/policy/aiOutbound";

/**
 * Whether an AI employee may send mail, and to whom.
 *
 * Operator, 21 Aug 2026: "no ai employee should be able to email anything to anyone right now, but
 * the plumbing and structure and scaffolding should be there for them to a) email the MPs and
 * b) one day later email the outside world with a separate flip switch for each."
 */

const PARTNERS = ["scooter@westpeek.ventures", "sequoia@westpeek.ventures"];
const OFF = { toPartners: false };
/** What `outsideEmailAllowed` says when the list has nothing on it, and when the item is on it. */
const DENY = { allowed: false, reason: "TLC brand sales is not on your Outside email list." };
const ALLOW = { allowed: true, reason: "TLC brand sales is on your Outside email list." };

describe("both switches are off unless somebody set them", () => {
  it("reads an unset environment as off", () => {
    expect(aiOutboundSwitches({})).toEqual(OFF);
  });

  it("treats anything other than exactly \"enabled\" as off", () => {
    // A typo, an empty string and "true" all mean the same thing, and that thing is no. The failure
    // mode of a missing config has to be silence, never a firm emailing people.
    for (const v of ["", "true", "yes", "Enabled", "1"]) {
      expect(aiOutboundSwitches({ WP_OS_AI_EMAIL_PARTNERS: v })).toEqual(OFF);
    }
    expect(aiOutboundSwitches({ WP_OS_AI_EMAIL_PARTNERS: "enabled" })).toEqual({ toPartners: true });
    // The retired all-or-nothing variable opens nothing, even set to "enabled": it is not read.
    expect(aiOutboundSwitches({ WP_OS_AI_EMAIL_EXTERNAL: "enabled" } as never)).toEqual(OFF);
  });
});

describe("the two switches are independent", () => {
  it("letting an employee email the partners does not let it email anybody else", () => {
    // The whole reason there are two: collapsing them would mean turning on the harmless one turns
    // on the one with no undo.
    const s = { toPartners: true };
    expect(mayAiEmail(s, "sequoia@westpeek.ventures", PARTNERS, DENY).allowed).toBe(true);
    expect(mayAiEmail(s, "founder@example.com", PARTNERS, DENY).allowed).toBe(false);
    // And the outside answer never leaks into the partner one, either way.
    expect(mayAiEmail(s, "sequoia@westpeek.ventures", PARTNERS, ALLOW).allowed).toBe(true);
  });

  it("and the reverse", () => {
    const s = { toPartners: false };
    expect(mayAiEmail(s, "sequoia@westpeek.ventures", PARTNERS, ALLOW).allowed).toBe(false);
    expect(mayAiEmail(s, "founder@example.com", PARTNERS, ALLOW).allowed).toBe(true);
    expect(mayAiEmail(s, "founder@example.com", PARTNERS, ALLOW).reason).toBe(ALLOW.reason);
  });
});

describe("anything not provably a partner is outside the firm", () => {
  it("classifies a lookalike address as external", () => {
    // A misclassified partner address costs a blocked email somebody unblocks. A misclassified
    // outside address costs the firm a message it did not mean to send.
    expect(audienceOf("sequoia@westpeek.ventures.co", PARTNERS)).toBe("EXTERNAL");
    expect(audienceOf("sequoia@notwestpeek.ventures", PARTNERS)).toBe("EXTERNAL");
    expect(audienceOf("SEQUOIA@WESTPEEK.VENTURES", PARTNERS)).toBe("PARTNERS");
  });

  it("refuses everything by default, and says why in her list's own words", () => {
    const outside = mayAiEmail(OFF, "founder@example.com", PARTNERS, DENY);
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toBe(DENY.reason);
    // A lookalike partner address is outside, so it asks the list, which says no.
    expect(mayAiEmail({ toPartners: true }, "sequoia@westpeek.ventures.co", PARTNERS, DENY).allowed).toBe(false);
    const partner = mayAiEmail(OFF, "scooter@westpeek.ventures", PARTNERS, ALLOW);
    expect(partner.allowed).toBe(false);
    expect(partner.reason).toContain("switch is off");
  });
});
