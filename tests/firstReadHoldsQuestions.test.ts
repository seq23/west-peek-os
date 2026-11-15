import { describe, expect, it } from "vitest";
import { questionsOf } from "../src/worker/services/partnerUnderstood";

describe("the first read's questions come from his typed email, not his voice notes", () => {
  it("keeps his typed questions and ignores transcript filler", () => {
    const written = "Hey Porter!\n\nWhat is the difference between a lead and a form request?\n\nBest,\nScooter\n\nVoice note (notes.m4a), his words transcribed:\nLike, who is buying? You know? You know what saying?";
    const q = questionsOf(written);
    expect(q).toEqual(["What is the difference between a lead and a form request?"]);
  });
});
