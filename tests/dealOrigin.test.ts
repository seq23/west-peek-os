import { describe, expect, it } from "vitest";
import { emailDealOrigin, isAdminOrWebsiteSubject } from "../src/shared/intake/dealOrigin";
import { dealFromMessage } from "../src/worker/services/dealIntake";

/**
 * 26 Oct 2026: a website email became an investment opportunity, and warm intros were filed as cold
 * inbound. The classifier, fixed at source. Made-up companies throughout.
 */
describe("an admin or website email is never a deal", () => {
  it("refuses the subjects that were requests about the firm's own site or admin", () => {
    for (const s of ["Acme photo swap on westpeek.ventures", "Deck: Acme photo swap on westpeek.ventures", "Swap the photo on the site", "Update our bio on the website", "Invoice #4411 for October", "Website copy fix for the Rooms page"]) {
      expect(isAdminOrWebsiteSubject(s), s).toBe(true);
      expect(dealFromMessage(s, "", "scooter@westpeek.ventures", true), s).toBeNull();
    }
  });

  it("still reads a real deal, including a company that builds websites", () => {
    for (const s of ["#wpdealflow Sitecraft", "Fwd: Acme Websites | $2M seed round", "#wpdealflow Pagewise website builder"]) {
      expect(isAdminOrWebsiteSubject(s), s).toBe(false);
    }
    expect(dealFromMessage("#wpdealflow Sitecraft", "", "x@y.co", false)?.company).toBe("Sitecraft");
  });
});

describe("a person's warm intro is a community intro", () => {
  it("a deal a partner forwards reached that partner personally", () => {
    expect(emailDealOrigin({ from: "Scooter Taylor <scooter@westpeek.ventures>", text: "#wpdealflow" })).toBe("COMMUNITY_INTRO");
    expect(emailDealOrigin({ from: "sequoia@westpeek.ventures", text: "" })).toBe("COMMUNITY_INTRO");
  });

  it("a message that introduces a founder is a community intro; a cold note is inbound", () => {
    expect(emailDealOrigin({ from: "friend@example.com", text: "Introducing you to Jo, founder of Acme" })).toBe("COMMUNITY_INTRO");
    expect(emailDealOrigin({ from: "friend@example.com", text: "Wanted you two to meet" })).toBe("COMMUNITY_INTRO");
    expect(emailDealOrigin({ from: "founder@acme.co", text: "We are raising a seed round. Deck attached." })).toBe("INBOUND");
  });
});
