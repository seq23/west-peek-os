import { describe, expect, it } from "vitest";
import { mergeHolds, questionsOf, sameHold } from "../src/worker/services/partnerUnderstood";

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
    expect(holds).toEqual(["Nothing goes live until I review the preview.", "Do not publish or go live with anything - I approve each step", "Do not build invoice or billing features yet"]);
    expect(holds.filter((h) => /goes live/i.test(h))).toHaveLength(1);
  });
  it("keeps a standing hold that only shares a word or two with the email's", () => {
    expect(sameHold("Do not email the client list", "no passwords or secret keys over email, in either direction")).toBe(false);
    expect(sameHold("Keep the Top Barz rows out of the pipeline", "Do not build invoice or billing features yet")).toBe(false);
    expect(mergeHolds([], standing)).toEqual(standing);
  });
});

describe("a question mark inside his quotation is not his question", () => {
  it("keeps a quoted form label out of his questions, and his own question in", () => {
    const q = questionsOf("Keep \"How did you hear about us?\"\n\nWhat can you get done today?");
    expect(q).toEqual(["What can you get done today?"]);
  });
});
