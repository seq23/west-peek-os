import { describe, expect, it } from "vitest";
import { privateMaterialConstraint, privateMaterialSentence } from "../src/shared/intake/privateMaterial";

/**
 * #357 (13 Nov 2026): a partner's "keep this private" in a build request rides on the job as a standing constraint and
 * keeps it private-model-only (webPropertyChange.parkPhase). The phrasing below is a stand-in of the same shape, not
 * the partner's text.
 */
describe("a partner's privacy instruction is read off the request", () => {
  it("finds the sentence that asks for privacy, in the shapes partners write it", () => {
    const req = "We're ready to build the site. Start with the plan in the folder. The plan doc is for you two and me only, so please don't copy or forward it. The brand folder will fill in.";
    expect(privateMaterialSentence([req])).toBe("The plan doc is for you two and me only, so please don't copy or forward it.");
    expect(privateMaterialSentence(["Use the deck. Keep this private."])).toBe("Keep this private.");
    expect(privateMaterialSentence(["The pricing sheet is confidential."])).toBe("The pricing sheet is confidential.");
    expect(privateMaterialSentence([null, "Do not forward the numbers doc to anyone."])).toBe("Do not forward the numbers doc to anyone.");
  });

  it("NEGATIVE: an ordinary request carries no privacy rule", () => {
    for (const plain of [
      "Change the hero copy on westpeekproductions.com and add the new logo from the folder.",
      "Add a private beta sign-up form and a privacy policy page.",
      "Copy the footer from the main site and forward the contact form to Scooter.",
    ]) {
      expect(privateMaterialSentence([plain]), plain).toBeNull();
    }
  });

  it("the constraint quotes the partner and forbids every public surface", () => {
    const c = privateMaterialConstraint("Keep this private.");
    expect(c).toContain('"Keep this private."');
    for (const surface of ["repo", "commit", "PR", "preview", "email"]) expect(c).toContain(surface);
  });
});
