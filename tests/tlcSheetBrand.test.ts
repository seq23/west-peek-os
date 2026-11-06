import { describe, expect, it } from "vitest";
import { renderBrandPitch, sponsorOf, type TlcClubView } from "../src/shared/tlc/pitch";
import { greetingFor } from "../src/shared/tlc/brandFlow";
import { approvalState, brandSendGate, PITCH_APPROVAL_HASH_SETTING } from "../src/shared/tlc/learningClub";

/**
 * THE PARTNER-LEVELS SHEET IS A WEST PEEK DOCUMENT (owner, 6 Nov 2026: "the entire page needs better branding
 * according to West Peek branding and typography"), and restyling it never undoes her approval of its words.
 */
const MAR: TlcClubView = { topic: "Build Your Own AI Agent", angle: "A hackathon-style evening. Mentors at every table.", month: "2027-03", eventDate: "2027-03-18", slot: "EVENING", whyNow: null, sources: [], categories: [], handsOn: null, takeHome: null, recap: null };

describe("the sheet carries West Peek's own type and mark", () => {
  it("Maax (both weights) and the WP monogram travel inside the page; the canonical orange; no network font", () => {
    const html = renderBrandPitch(MAR, sponsorOf({ brand: "Acme Vector", category: "Vector database" }));
    for (const weight of [400, 700]) {
      const b64 = new RegExp(`font-family:Maax;font-weight:${weight};font-style:normal;src:url\\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\\)`).exec(html)?.[1] ?? "";
      const bytes = Buffer.from(b64, "base64");
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2"); // a real WOFF2 font file
      expect(bytes.length).toBeGreaterThan(20_000);
    }
    expect(html).toMatch(/<header class="mast"><img src="data:image\/png;base64,[A-Za-z0-9+/=]{2000,}" alt="West Peek">/);
    expect(html).toContain("--accent:#F05A1A");
    expect(html).not.toMatch(/fonts\.googleapis|@import|<link /);
  });

  it("a sheet made for a brand says it is confidential and for whom; the generic sheet says no brand's name", () => {
    expect(renderBrandPitch(MAR, sponsorOf({ brand: "Acme Vector", category: "Vector database" }))).toContain("Prepared for Acme Vector. Confidential, for your team only.");
    expect(renderBrandPitch(MAR)).not.toMatch(/Prepared for|Acme/);
    expect(renderBrandPitch(MAR)).toContain("March 2027 (date flexible)");
  });
});

describe("her approval is of the words", () => {
  const words = "March 2027\nThe Learning Club\nBuild Your Own AI Agent";
  const settings = { [PITCH_APPROVAL_HASH_SETTING]: "old-hash", pitch_approved_text: words, playbook_approved_hash: "p", brand_send: "on" };
  it("a restyle with every word the same stays APPROVED; one changed word is CHANGED; never approved stays NOT_APPROVED", () => {
    expect(approvalState(settings, PITCH_APPROVAL_HASH_SETTING, "new-hash", words)).toBe("APPROVED");
    expect(approvalState(settings, PITCH_APPROVAL_HASH_SETTING, "new-hash", words.replace("Agent", "Agents"))).toBe("CHANGED");
    expect(approvalState(settings, PITCH_APPROVAL_HASH_SETTING, "new-hash")).toBe("CHANGED");
    expect(approvalState({}, PITCH_APPROVAL_HASH_SETTING, "new-hash", words)).toBe("NOT_APPROVED");
    expect(approvalState({ ...settings, pitch_approved_text: "" }, PITCH_APPROVAL_HASH_SETTING, "new-hash", "")).toBe("CHANGED");
  });
  it("the brand send gate stays open through a restyle and closes on a changed word", () => {
    const outside = { allowed: true, code: "OK", reason: "" };
    expect(brandSendGate(settings, outside, { pitch: "new-hash", playbook: "p", pitchWords: words }).open).toBe(true);
    expect(brandSendGate(settings, outside, { pitch: "new-hash", playbook: "p", pitchWords: `${words}!` }).reasons).toContain("the brand pitch changed after it was approved; approve it again");
  });
});

describe("the answer greets the person who asked", () => {
  const contact = { name: "Mike Example (Director)", email: "mike@brand.example" };
  it("our contact by first name when we answer them", () => {
    expect(greetingFor(contact, { to: "mike@brand.example", cc: [] })).toBe("Hi Mike,");
  });
  it("a colleague who asked: their own name from their From line, never our contact's", () => {
    const raw = "From: Kai Person <kai@brand.example>\nTo: us@firm.example\nCc: mike@brand.example\n\nHow much is this to do?";
    expect(greetingFor(contact, { to: "kai@brand.example", cc: ["mike@brand.example"] }, raw)).toBe("Hi Kai,");
  });
  it("no name shown: 'Hi all,' with others copied, 'Hi,' alone; never a name guessed from an address or our contact's", () => {
    expect(greetingFor(contact, { to: "kai@brand.example", cc: ["mike@brand.example"] })).toBe("Hi all,");
    expect(greetingFor(contact, { to: "kai@brand.example", cc: [] }, "From: kai@brand.example\n\nhi")).toBe("Hi,");
    // A display name that belongs to another address on the line is not theirs.
    expect(greetingFor(contact, { to: "kai@brand.example", cc: [] }, "From: Mike Example <mike@brand.example>\n\nhi")).toBe("Hi,");
  });
});
