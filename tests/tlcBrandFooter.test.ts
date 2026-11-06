import { describe, expect, it } from "vitest";
import { BRAND_MAILING_ADDRESS, RETIRED_MAILING_ADDRESSES, brandEmailHtml, withBrandFooter, withoutBrandFooter } from "../src/shared/tlc/brandFooter";
import { approvedDayZeroEmail, dripEmail, monthWords, signedBrandEmail, TLC_PS_BY_STEP } from "../src/shared/tlc/learningClub";
import { ownerAngleFirstEmail } from "../src/shared/tlc/ownerInstruction";
import { fallbackReplyBody, THREE_THINGS_OFFER, type ReplyDraftInput } from "../src/shared/tlc/brandReply";
import { draftProblems } from "../src/worker/services/tlcBrandReply";
import { gmailRaw } from "../src/worker/effects/googleClient";

/**
 * Every brand email ends with our mailing address (owner, 1 Nov 2026): one constant, rendered by every builder, as
 * the email's last line, exactly once, under the signature and the P.S.
 */
describe("the mailing-address footer on every brand email (owner, 1 Nov 2026)", () => {
  it("replaces a footer filed before the 6 Nov address correction, so an approved draft goes out with one right footer", () => {
    const old = "3055 Lombard St #471024, San Francisco, CA 94147";
    expect(RETIRED_MAILING_ADDRESSES).toContain(old);
    const filed = `Hi Jo,\n\nWords.\n\nSequoia Taylor\nWest Peek Ventures\n\n${old}`;
    const out = withBrandFooter(filed);
    expect(out).toBe(`Hi Jo,\n\nWords.\n\nSequoia Taylor\nWest Peek Ventures\n\n${BRAND_MAILING_ADDRESS}`);
    expect(out).not.toContain(old);
    expect(withoutBrandFooter(filed)).toBe("Hi Jo,\n\nWords.\n\nSequoia Taylor\nWest Peek Ventures");
    expect(brandEmailHtml(filed)).not.toContain(old);
    expect(withBrandFooter(`${filed}\n\n${BRAND_MAILING_ADDRESS}`)).toBe(out);
  });


  it("is the last line, once, of every brand-email builder's output, and sits small and muted in the HTML part", () => {
    expect(BRAND_MAILING_ADDRESS).toBe("2055 Lombard St #471024, San Francisco, CA 94147");
    const drip = { brand: "Acme", contactName: "Jo Doe", topic: "Sleep", month: "2027-02", eventDate: "2027-02-11", why: null };
    const reply: ReplyDraftInput = { intent: "QUESTION", brand: "Acme", contactName: "Jo", topic: "Sleep", month: "2027-02", why: null, theirText: "Tell me more?", pitchUrl: null, callLink: null };
    const built: Array<[string, string]> = [
      ["drip email 1", dripEmail({ ...drip, step: 0 }).text],
      ["drip email 2", dripEmail({ ...drip, step: 1 }).text],
      ["her approved first email", approvedDayZeroEmail({ subject: "Acme", body: "Hi [Name],\n\nHello.\n\nSequoia Taylor\nWest Peek Ventures\nsequoia@westpeek.ventures" }, "Jo Doe").text],
      ["her angle first email", ownerAngleFirstEmail({ brand: "Acme", contactName: "Jo", topic: "Sleep", month: "2027-02", angleLine: null }).text],
      ["an answer to a brand", signedBrandEmail(fallbackReplyBody(reply, monthWords))],
      ["a redraft with its P.S.", signedBrandEmail("Hi,\n\nWords.", TLC_PS_BY_STEP[1]!)],
    ];
    for (const [what, text] of built) {
      expect(text.endsWith(`\n\n${BRAND_MAILING_ADDRESS}`), what).toBe(true);
      expect(text.split(BRAND_MAILING_ADDRESS).length - 1, what).toBe(1);
      expect(text.indexOf("Sequoia Taylor\nWest Peek Ventures"), what).toBeGreaterThan(-1);
      expect(text.indexOf("Sequoia Taylor\nWest Peek Ventures"), what).toBeLessThan(text.indexOf(BRAND_MAILING_ADDRESS));
      // Idempotent: a builder's output through the filing step again is unchanged.
      expect(withBrandFooter(text), what).toBe(text);
    }
    // The P.S. stays the line above the footer on email 1.
    expect(built[0]![1].endsWith(`${TLC_PS_BY_STEP[0]!}\n\n${BRAND_MAILING_ADDRESS}`)).toBe(true);

    const html = brandEmailHtml(built[0]![1]);
    expect(html).toMatch(/<p style="[^"]*font-size:11px[^"]*color:#9a9a9a[^"]*">2055 Lombard St #471024, San Francisco, CA 94147<\/p>\n<\/div>$/);
    expect(html.split(BRAND_MAILING_ADDRESS).length - 1).toBe(1);
    expect(html).toContain("Sequoia Taylor<br>West Peek Ventures");

    // Gmail is handed both parts: the plain text and its HTML alternative, each with the footer.
    const raw = gmailRaw({ to: "jo@acme.example", from: "sequoia@westpeek.ventures", subject: "Acme", text: built[0]![1], html });
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="wpos_alt_[0-9a-f]+"/);
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(raw.split(BRAND_MAILING_ADDRESS).length - 1).toBe(2);
  });
});

describe("a call they ask for is always a yes; Wynn never proposes one (owner, 1 Nov 2026)", () => {
  const base: ReplyDraftInput = { intent: "CALL", brand: "Acme", contactName: "Jo", topic: "Sleep", month: "2027-02", why: null, theirText: "Could we hop on a call next week?", pitchUrl: null, callLink: "https://cal.example/sequoia" };
  it("says yes to their call, with her calendar, whatever rules are loaded; otherwise the next step is the samples", () => {
    const yes = fallbackReplyBody(base, monthWords);
    expect(yes).toContain("Happy to talk. Here is my calendar, pick whatever suits you: https://cal.example/sequoia");
    expect(draftProblems(yes, "CALL")).toEqual([]);
    const question = fallbackReplyBody({ ...base, intent: "QUESTION", theirText: "Tell me more?" }, monthWords);
    expect(question).toContain(THREE_THINGS_OFFER);
    expect(question).not.toContain("cal.example");
    // A model draft that asks for a call the brand did not propose falls back to the template, with no rule row needed.
    expect(draftProblems("Hi,\n\nWould a quick call next week work?", "QUESTION")).toContain("asks for a call (her rule: the brand may propose one, Wynn never does)");
  });
});
