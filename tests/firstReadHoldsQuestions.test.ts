import { describe, expect, it } from "vitest";
import { holdForHim, mergeHolds, questionsOf, quoteHis, sameHold } from "../src/worker/services/partnerUnderstood";

describe("the first read's questions come from his typed email, not his voice notes", () => {
  it("keeps his typed questions and ignores transcript filler", () => {
    const written = "Hey Porter!\n\nWhat is the difference between a lead and a form request?\n\nBest,\nScooter\n\nVoice note (notes.m4a), his words transcribed:\nLike, who is buying? You know? You know what saying?";
    const q = questionsOf(written);
    expect(q).toEqual(["What is the difference between a lead and a form request?"]);
  });
});

describe("a standing hold the email already says is listed once, in the email's words", () => {
  const standing = ["Do not publish or go live with anything - I approve each step", "Do not build invoice or billing features yet", "nothing goes live until he reviews the preview (every build since 9 Oct)"];
  it("drops the brain's wording when the email carries the same hold, and keeps the rest", () => {
    const email = ["Nothing goes live until I review the preview."];
    const holds = mergeHolds(email, standing);
    expect(holds, "one go-live hold, in the email's words").toEqual(["Nothing goes live until I review the preview.", "Do not build invoice or billing features yet"]);
    expect(holds.filter((h) => /goes live/i.test(h))).toHaveLength(1);
  });
  it("keeps a standing hold that only shares a word or two with the email's", () => {
    expect(sameHold("Do not email the client list", "no passwords or secret keys over email, in either direction")).toBe(false);
    expect(sameHold("Keep the Top Barz rows out of the pipeline", "Do not build invoice or billing features yet")).toBe(false);
    expect(mergeHolds([], standing), "every standing hold stays, the second go-live wording collapsing into the first").toEqual([standing[0], standing[1]]);
  });
});

describe("a question mark inside his quotation is not his question", () => {
  it("keeps a quoted form label out of his questions, and his own question in", () => {
    const q = questionsOf("Keep \"How did you hear about us?\"\n\nWhat can you get done today?");
    expect(q).toEqual(["What can you get done today?"]);
  });
});

describe("the holds he reads back are in his voice, once each", () => {
  const brain = ["Do not publish or go live with anything - I approve each step", "Do not build invoice or billing features yet", "money figures are for him only", "his voice notes are \"thinking out loud\"; his email is the final word where they differ", "his Blueprint is never copied or forwarded (13 Nov)", "nothing goes live until he reviews the preview (every build since 9 Oct)", "she approves every send"];
  it("never shows him a note about him in the third person", () => {
    const shown = brain.map(holdForHim).filter((h): h is string => h !== null);
    for (const h of shown) expect(h, h).not.toMatch(/\b(he|him|his|she|her)\b/i);
    expect(shown).toContain("Money figures are for you only");
    expect(shown).toContain("Nothing goes live until you review the preview");
    expect(shown).toContain("Your Blueprint is never copied or forwarded");
    expect(shown).toContain("\"Do not build invoice or billing features yet\"");
    expect(shown.some((h) => /13 Nov|9 Oct/.test(h)), "the brain's dates are bookkeeping").toBe(false);
  });
  it("quotes his words once, even when they hold quotes of their own", () => {
    expect(quoteHis("Rename \"Who is buying\" to \"Organization type.\"")).toBe("\"Rename ‘Who is buying’ to ‘Organization type.’\"");
    expect(quoteHis("\"Do not build invoice or billing features yet\"")).toBe("\"Do not build invoice or billing features yet\"");
  });
  it("says 'nothing goes live' once, keeping the email's wording over the brain's", () => {
    const fromBrain = mergeHolds([], brain);
    expect(fromBrain.filter((h) => /go(es)? live/i.test(h))).toEqual(["Do not publish or go live with anything - I approve each step"]);
    const withEmail = mergeHolds(["Everything below stays in the preview for me to check first; nothing goes live."], brain);
    expect(withEmail.filter((h) => /go(es)? live/i.test(h))).toEqual(["Everything below stays in the preview for me to check first; nothing goes live."]);
    expect(withEmail).toContain("Do not build invoice or billing features yet");
  });
});
