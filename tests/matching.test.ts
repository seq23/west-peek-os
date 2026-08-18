import { describe, expect, it } from "vitest";
import {
  MAX_SUGGESTIONS,
  MIN_STRENGTH,
  type MatchCandidate,
  overlap,
  pairKey,
  proposeMatches,
  readyToConnect,
  tokenise,
} from "../src/shared/relationships/matching";

const ada: MatchCandidate = {
  personId: "per_ada",
  displayName: "Ada Chen",
  needs: ["How should I make my first engineering hire without a technical cofounder?"],
  experience: [],
};

const dev: MatchCandidate = {
  personId: "per_dev",
  displayName: "Dev Patel",
  needs: [],
  experience: ["Made my first three engineering hires last year, including hiring without a technical cofounder"],
};

const unrelated: MatchCandidate = {
  personId: "per_mira",
  displayName: "Mira Okafor",
  needs: ["When is the right time to raise a Series A?"],
  experience: ["Ran healthcare regulatory strategy for a decade"],
};

describe("complementarity, not similarity", () => {
  it("matches a need to lived experience", () => {
    const [match] = proposeMatches([ada, dev]);
    expect(match?.personAId).toBe("per_ada");
    expect(match?.personBId).toBe("per_dev");
    expect(match?.strength).toBeGreaterThanOrEqual(MIN_STRENGTH);
  });

  it("does not match two people in the same field with nothing to offer each other", () => {
    // The classic bad suggestion: same industry, no complementarity.
    const twinA: MatchCandidate = { personId: "per_a", displayName: "A", needs: ["How do I price a fintech product?"], experience: [] };
    const twinB: MatchCandidate = { personId: "per_b", displayName: "B", needs: ["How do I price a fintech product?"], experience: [] };
    expect(proposeMatches([twinA, twinB])).toEqual([]);
  });

  it("proposes nothing rather than something weak", () => {
    // The correct failure mode for this feature is a quiet month.
    expect(proposeMatches([ada, unrelated])).toEqual([]);
  });

  it("writes a rationale a partner could paste into an email", () => {
    const [match] = proposeMatches([ada, dev]);
    expect(match?.rationale).toMatch(/^Ada asked about “/);
    expect(match?.rationale).toContain("Dev has been through it");
  });

  it("carries both signals so the reasoning is inspectable", () => {
    const [match] = proposeMatches([ada, dev]);
    expect(match?.needSignal).toMatch(/first engineering hire/);
    expect(match?.experienceSignal).toMatch(/three engineering hires/);
  });
});

describe("precision over volume", () => {
  it("never exceeds the cap however many good pairs exist", () => {
    const many: MatchCandidate[] = [];
    for (let i = 0; i < 12; i += 1) {
      many.push({ personId: `per_n${i}`, displayName: `Needer ${i}`, needs: ["How should I make my first engineering hire?"], experience: [] });
      many.push({ personId: `per_e${i}`, displayName: `Expert ${i}`, needs: [], experience: ["I made my first engineering hire and then three more"] });
    }
    expect(proposeMatches(many).length).toBe(MAX_SUGGESTIONS);
  });

  it("uses each person at most once per run", () => {
    // Three introductions all involving the same member is one introduction with extra steps.
    const many: MatchCandidate[] = [
      dev,
      { personId: "per_n1", displayName: "N One", needs: ["How should I make my first engineering hire?"], experience: [] },
      { personId: "per_n2", displayName: "N Two", needs: ["How should I make my first engineering hire?"], experience: [] },
      { personId: "per_n3", displayName: "N Three", needs: ["How should I make my first engineering hire?"], experience: [] },
    ];
    const out = proposeMatches(many);
    expect(out.length).toBe(1);
    const seen = out.flatMap((s) => [s.personAId, s.personBId]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("never re-proposes a pair, in either direction", () => {
    const seen = new Set([pairKey("per_dev", "per_ada")]);
    expect(proposeMatches([ada, dev], seen)).toEqual([]);
  });

  it("ignores a question too vague to carry a topic", () => {
    const vague: MatchCandidate = { personId: "per_v", displayName: "V", needs: ["Any advice?"], experience: [] };
    expect(proposeMatches([vague, dev])).toEqual([]);
  });

  it("never matches someone with themselves", () => {
    const both: MatchCandidate = {
      personId: "per_solo", displayName: "Solo",
      needs: ["How should I make my first engineering hire?"],
      experience: ["I made my first engineering hire last year"],
    };
    expect(proposeMatches([both])).toEqual([]);
  });
});

describe("scoring", () => {
  it("normalises by the need, so a detailed answer is not punished for being detailed", () => {
    const need = tokenise("choosing a cofounder");
    const short = tokenise("cofounder choice");
    const long = tokenise("choosing a cofounder is the hardest early decision and I have written about equity splits, vesting, and what to do when it goes wrong");
    expect(overlap(need, long)).toBeGreaterThanOrEqual(overlap(need, short));
  });

  it("stems so hiring matches hire and founders matches founder", () => {
    expect(tokenise("hiring founders")).toEqual(tokenise("hire founder"));
  });

  it("drops stopwords so two questions do not match on 'how do I'", () => {
    expect(tokenise("how do I what should we")).toEqual(new Set());
  });

  it("returns zero rather than dividing by zero on an empty side", () => {
    expect(overlap(new Set(), tokenise("anything"))).toBe(0);
    expect(overlap(tokenise("anything"), new Set())).toBe(0);
  });
});

describe("an introduction needs both people and a person", () => {
  it("waits for double opt-in and a human approval", () => {
    expect(readyToConnect({ consentA: true, consentB: true, approvedBy: "seq" })).toBe(true);
    expect(readyToConnect({ consentA: true, consentB: false, approvedBy: "seq" })).toBe(false);
    // Even with both consents, no machine sends an introduction in West Peek's name.
    expect(readyToConnect({ consentA: true, consentB: true, approvedBy: null })).toBe(false);
  });
});

describe("pairKey", () => {
  it("is order-independent, so A→B and B→A are one pair", () => {
    expect(pairKey("per_b", "per_a")).toBe(pairKey("per_a", "per_b"));
  });
});
