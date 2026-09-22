import { describe, it, expect } from "vitest";
import { CARD_KINDS, cardKind, startableByHand, handStartableKinds } from "../src/shared/work/cardKinds";

/**
 * THE ONE LIST OF WHAT A CARD CAN BE. `validate:card-kinds` holds the registry against the code
 * that writes and compares `work_card.kind`; this holds the helpers three surfaces will read.
 *
 * THE PLAIN CARD IS THE CASE THAT MATTERS MOST. A card with no kind is the ordinary one — "what
 * needs doing", handed to an employee — and it is always startable by hand. A helper that answered
 * "no" to it would take the Add-a-card button away from the only kind of card anybody writes.
 */
describe("the card-kind registry", () => {
  it("has kinds at all", () => {
    expect(CARD_KINDS.length).toBeGreaterThan(0);
  });

  it("says the plain no-kind card can always be started by hand", () => {
    expect(startableByHand(null)).toBe(true);
    expect(startableByHand(undefined)).toBe(true);
    expect(startableByHand("")).toBe(true);
    expect(cardKind(null)).toBeNull();
  });

  it("refuses a kind it does not know, rather than guessing it is fine", () => {
    expect(cardKind("INVOICE_CHASE")).toBeNull();
    expect(startableByHand("INVOICE_CHASE")).toBe(false);
  });

  it("refuses every job-opened kind by hand, because duplicateOf would swallow it", () => {
    for (const k of CARD_KINDS.filter((x) => x.door === "JOB")) {
      expect(startableByHand(k.key), k.key).toBe(false);
      expect(k.oneLine, k.key).toMatch(/job/i);
    }
  });

  it("offers exactly the kinds a person drives, and each of them names what it needs", () => {
    const offered = handStartableKinds();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.map((k) => k.key).sort()).toEqual(["ARTIFACT", "BLOG_HELP", "PARTNER_MESSAGE", "WEB_PROPERTY_CHANGE"]);
    for (const k of offered) {
      expect(k.door, k.key).not.toBe("JOB");
      expect(k.requires.length, k.key).toBeGreaterThan(0);
    }
  });
});
