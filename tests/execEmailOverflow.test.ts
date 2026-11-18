import { describe, expect, it } from "vitest";
import { renderExecEmail } from "../src/shared/email/execEmail";

/*
 * wc_d4b961bc, 18 Nov 2026: Porter's GA4 preview listed 5 of Scooter's answered asks, said "… and 4 more, under
 * Details below", and the email had no Details. Every bullet of a cut section must reach the email.
 */
const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
const ASKS = NAMES.map((n) => `Done: cta_${n} wired`);
const base = { employee: "Porter", what: "Preview ready", tldr: "Preview ready.", sections: [{ label: "What you asked, answered", bullets: ASKS }, { label: "The card", bullets: ["on the card"] }] };

describe("a section cut short is written in full under the details (18 Nov 2026)", () => {
  it("every ask of a nine-ask section is in the text and the html, with no caller details", () => {
    const e = renderExecEmail(base);
    for (const n of NAMES) {
      expect(e.text, n).toContain(`cta_${n}`);
      expect(e.html, n).toContain(`cta_${n}`);
    }
  });
  it("a caller that already wrote the continuation is not repeated, and its own details stay", () => {
    const e = renderExecEmail({ ...base, details: "**What you asked, answered, continued**\n• Done: cta_foxtrot wired\n• x\n\nOther notes here" });
    expect(e.text.match(/cta_foxtrot/g)).toHaveLength(1);
    expect(e.text).toContain("Other notes here");
  });
  it("a short section adds no details", () => {
    const e = renderExecEmail({ ...base, sections: [{ label: "What you asked", bullets: ["one"] }, { label: "The card", bullets: ["two"] }] });
    expect(e.text).not.toContain("continued");
  });
});
