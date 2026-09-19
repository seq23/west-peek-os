import { describe, expect, it } from "vitest";
import { answerLine, firstSentence, inWords, needsHer, secondLine, waitingKinds } from "../src/shared/home/answerLine";

/**
 * THE ANSWER AND THE WAITING PILL ARE ONE NUMBER (design/HOME_DESIGN.md §3.1, 19 Sep 2026).
 *
 * STRICTER THAN THE PIN IT REPLACES. The old suite pinned "keyed on decisions alone" — the exact
 * contradiction the audit found: the masthead said "Nothing is waiting on your signature" over a
 * band whose pill said 1. The answer is now `needsHer` = decisions + blockers + previews, and the
 * detail names the kind, so "one thing" is never a mystery and a blocker is never mistaken for a
 * signature.
 */

describe("the answer line is one count", () => {
  it("states the zero case in words", () => {
    expect(answerLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 0 })).toBe("Nothing is waiting on you.");
    expect(needsHer({ decisions: 0, blockers: 0 })).toBe(0);
  });

  it("counts a blocker AND a preview as waiting — the contradiction the audit found is gone", () => {
    expect(answerLine({ decisions: 0, blockers: 1, fresh: 1, quiet: 9 })).toBe("One thing is waiting on you.");
    expect(answerLine({ decisions: 0, blockers: 0, previews: 1, fresh: 0, quiet: 0 })).toBe("One thing is waiting on you.");
    expect(answerLine({ decisions: 1, blockers: 1, previews: 1, fresh: 0, quiet: 0 })).toBe("Three things are waiting on you.");
    expect(needsHer({ decisions: 1, blockers: 1, previews: 1 })).toBe(3);
  });

  it("agrees the verb with one and falls back to digits past nine", () => {
    expect(answerLine({ decisions: 1, blockers: 0, fresh: 0, quiet: 0 })).toBe("One thing is waiting on you.");
    expect(answerLine({ decisions: 12, blockers: 0, fresh: 0, quiet: 0 })).toBe("12 things are waiting on you.");
    expect(inWords(9)).toBe("nine");
    expect(inWords(10)).toBe("10");
  });

  it("the pill and the answer can never disagree: for every mix the answer's number is needsHer", () => {
    for (const decisions of [0, 1, 2]) for (const blockers of [0, 1, 3]) for (const previews of [0, 1]) {
      const n = needsHer({ decisions, blockers, previews });
      const line = answerLine({ decisions, blockers, previews, fresh: 0, quiet: 0 });
      if (n === 0) expect(line).toBe("Nothing is waiting on you.");
      else expect(line.toLowerCase()).toContain(inWords(n));
    }
  });
});

describe("the detail names the kind", () => {
  it("says 'Not a signature' when nothing needs one, and names the one blocker verbatim", () => {
    expect(waitingKinds({ decisions: 0, blockers: 1, firstBlocker: "Scooter's brief failed and Willow has it.", fresh: 0, quiet: 0 })).toBe(
      "Not a signature — Scooter's brief failed and Willow has it.",
    );
  });

  it("lists previews first, then decisions, then blockers, and drops the 'Not a signature' prefix when something needs one", () => {
    expect(waitingKinds({ decisions: 2, blockers: 1, previews: 1, firstBlocker: "the calendar is not connected", fresh: 0, quiet: 0 })).toBe(
      "A preview to approve and send, two decisions on your signature and the calendar is not connected.",
    );
    expect(waitingKinds({ decisions: 0, blockers: 2, fresh: 0, quiet: 0 })).toBe("Not a signature — Two things unfinished.");
    expect(waitingKinds({ decisions: 0, blockers: 0, fresh: 3, quiet: 0 })).toBeNull();
  });

  it("reads as the design's primary board", () => {
    expect(
      secondLine({
        decisions: 0, blockers: 1, firstBlocker: "Scooter's brief failed and Willow has it", fresh: 1, quiet: 9,
        brief: "Today's brief failed — the last one is Thursday's",
      }),
    ).toBe("Not a signature — Scooter's brief failed and Willow has it. One arrived since you last looked. Today's brief failed — the last one is Thursday's.");
  });

  it("drops a clause whose count is zero instead of printing a zero, and never doubles a full stop", () => {
    const line = secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 0 });
    expect(line).toBe("Nothing arrived since you last looked.");
    expect(line).not.toMatch(/\b0\b|zero/i);
    const dotted = secondLine({ decisions: 0, blockers: 1, firstBlocker: "Calendar is not connected.", fresh: 0, quiet: 0, brief: "Today's brief arrived at 7:26 AM." });
    expect(dotted).not.toContain("..");
    expect(dotted).toContain("Today's brief arrived at 7:26 AM.");
  });

  it("carries ONE sentence of the brief's line — the band under it carries the rest", () => {
    expect(firstSentence("No brief today yet. None has been built yet.")).toBe("No brief today yet.");
    expect(firstSentence("Still building — writing. 3 minutes in; usually about 4 minutes. The slow end is 6.")).toBe("Still building — writing.");
    expect(firstSentence("No brief yet — attempt 2 of 3 failed: the model was cut off")).toBe("No brief yet — attempt 2 of 3 failed: the model was cut off");
    const line = secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 0, brief: "No brief today yet. None has been built yet." });
    expect(line).toBe("Nothing arrived since you last looked. No brief today yet.");
    expect(line).not.toContain("None has been built");
  });

  it("agrees arrived with the number, and keeps the quiet clause only when there is no brief clause", () => {
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 1, quiet: 0 })).toContain("One arrived since you last looked.");
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 2, quiet: 0 })).toContain("Two arrived since you last looked.");
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 2 })).toContain("Two colleagues have nothing new.");
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 2, brief: "No brief today yet" })).not.toContain("colleagues");
  });
});
