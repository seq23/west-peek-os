import { describe, expect, it } from "vitest";
import { parseFireflies, turnLine } from "../src/shared/meetings/firefliesTranscript";

/**
 * Reading a Fireflies export (ADR-019).
 *
 * THE RULE THESE TESTS EXIST TO PROTECT: the parser never guesses who spoke. Close-out reads these
 * turns and assigns commitments out of them, so an invented attribution becomes a task assigned to
 * somebody who never agreed to it — which is a worse failure than losing the name.
 *
 * Nothing here asserts that any particular export format is Fireflies' current one. What is tested
 * is the behaviour on the shapes real exports take, and the behaviour on shapes it cannot read.
 */

describe("speaker-labelled exports", () => {
  it("reads a plain Name: line", () => {
    const out = parseFireflies("Deana Oliver: we can send the data room by Friday\nPierce: thank you");
    expect(out.turns).toHaveLength(2);
    expect(out.turns[0]).toMatchObject({ speaker: "Deana Oliver", text: "we can send the data room by Friday" });
    expect(out.unattributed).toBe(0);
  });

  it("keeps a timestamp verbatim and never computes one", () => {
    const leading = parseFireflies("[00:12] Deana Oliver: hello");
    expect(leading.turns[0]).toMatchObject({ speaker: "Deana Oliver", at: "00:12", text: "hello" });

    const trailing = parseFireflies("Deana Oliver (01:02:03): hello");
    expect(trailing.turns[0]!.at).toBe("01:02:03");

    // A timestamp on its own line belongs to whatever comes next.
    const bare = parseFireflies("00:45\nDeana Oliver: hello");
    expect(bare.turns).toHaveLength(1);
    expect(bare.turns[0]!.at).toBe("00:45");
  });

  it("joins a wrapped line onto the person who was already speaking", () => {
    // The ONLY place a line inherits a speaker, and it is safe because the export put it directly
    // underneath with nothing in between.
    const out = parseFireflies("Deana Oliver: we can send the data room\nby Friday at the latest");
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]!.text).toBe("we can send the data room by Friday at the latest");
  });
});

describe("it refuses to invent an attribution", () => {
  it("keeps an unlabelled opening paragraph and marks it unattributed", () => {
    const out = parseFireflies("we should talk about the hiring plan\nDeana Oliver: agreed");
    expect(out.turns).toHaveLength(2);
    expect(out.turns[0]!.speaker).toBeNull();
    expect(out.unattributed).toBe(1);
  });

  it("does not turn the first clause of a sentence into a person", () => {
    // "Note:" and "Action item:" are the ones that would poison every line beneath them.
    for (const line of [
      "Note: we should follow up on the second founder",
      "One thing worth saying here is that this is long, and it has: a colon in it",
    ]) {
      const out = parseFireflies(line);
      expect(out.turns[0]!.speaker, line).toBeNull();
    }
  });

  it("says so in words on the record rather than leaving the line bare", () => {
    const [turn] = parseFireflies("nobody knows who said this").turns;
    // The RULE: the line says the speaker is unknown, in words, and still carries what was said.
    // Pinned as a whole sentence, this broke every time the phrasing was tuned.
    expect(turnLine(turn!)).toMatch(/not named/i);
    expect(turnLine(turn!)).toContain("nobody knows who said this");
    expect(turnLine({ speaker: "Pierce", at: "00:10", text: "yes" })).toBe("Pierce [00:10]: yes");
  });
});

describe("Fireflies' own writing is kept apart from what was said", () => {
  it("puts the summary and the action items in their own field, never in the turns", () => {
    const out = parseFireflies(
      [
        "Fireflies.ai",
        "Duration: 32 minutes",
        "",
        "Summary",
        "They are raising a seed round and want a decision in two weeks.",
        "",
        "Action Items",
        "- West Peek to send the diligence question list",
        "",
        "Transcript",
        "Deana Oliver: we are raising four on sixteen",
        "Pierce: understood",
      ].join("\n"),
    );
    expect(out.turns).toHaveLength(2);
    expect(out.turns.map((t) => t.speaker)).toEqual(["Deana Oliver", "Pierce"]);
    expect(out.summary).toContain("raising a seed round");
    expect(out.summary).toContain("diligence question list");
    // Nobody in the room said the summary. It must never appear as testimony.
    expect(out.turns.some((t) => t.text.includes("raising a seed round"))).toBe(false);
  });

  it("ends the summary block at the first real speaker line even with no Transcript heading", () => {
    const out = parseFireflies("Overview\nA short call.\nDeana Oliver: hello");
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]!.speaker).toBe("Deana Oliver");
    expect(out.summary).toContain("A short call.");
  });

  it("drops the export's own page furniture rather than filing it as speech", () => {
    const out = parseFireflies("Transcribed by Fireflies.ai\nMeeting URL: https://example.test/x\nPierce: hello");
    expect(out.turns).toHaveLength(1);
  });
});

describe("nothing readable", () => {
  it("returns no turns and no summary for an empty export", () => {
    const out = parseFireflies("   \n\n  ");
    expect(out.turns).toEqual([]);
    expect(out.summary).toBeNull();
  });
});
