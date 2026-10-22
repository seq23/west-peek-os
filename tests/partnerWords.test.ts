import { describe, expect, it } from "vitest";
import { PARTNER_WORDS_ON_CARD, STORED_MESSAGE_IN_PROMPT, statedCut } from "../src/worker/services/partnerWords";
import { readableMessage } from "../src/worker/services/dealIntake";

describe("a partner's words are never cut silently (22 Oct 2026)", () => {
  it("returns text short of the cap whole, and untouched", () => {
    expect(statedCut("all of it", 100, "x")).toBe("all of it");
  });

  it("says where it stopped, how long the whole was, and where the rest is", () => {
    const out = statedCut("a".repeat(50), 10, "the stored message");
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("[… cut here at 10 of 50 characters — the rest is in the stored message]");
  });

  it("readableMessage states its own cut rather than stopping mid-word", () => {
    const out = readableMessage(`Sequoia and Scooter: decide every deal. ${"word ".repeat(2000)}`, 4000);
    expect(out).toMatch(/cut here at 4,000 of [\d,]+ characters/);
  });

  it("the caps fit the longest real playbook (5,725 characters) with room", () => {
    expect(PARTNER_WORDS_ON_CARD).toBeGreaterThanOrEqual(2 * 5725);
    expect(STORED_MESSAGE_IN_PROMPT).toBeGreaterThanOrEqual(3 * 5725);
    // Under the 16,000-character description ceiling, with room for the stored-message line and hand-off notes.
    expect(PARTNER_WORDS_ON_CARD).toBeLessThan(16000 - 1000);
  });
});
