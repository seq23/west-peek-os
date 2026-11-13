import { describe, expect, it } from "vitest";
import { answerLine, inWords, needsHer, secondLine, waitingKinds } from "../src/shared/home/answerLine";

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

  it("drops a clause whose count is zero instead of printing a zero, and never doubles a full stop", () => {
    const line = secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 0 });
    expect(line).toBe("Nothing arrived since you last looked.");
    expect(line).not.toMatch(/\b0\b|zero/i);
    const dotted = secondLine({ decisions: 0, blockers: 1, firstBlocker: "Calendar is not connected.", fresh: 0, quiet: 0, brief: "Today's brief arrived at 7:26 AM." });
    expect(dotted).not.toContain("..");
    expect(dotted).toContain("Today's brief arrived at 7:26 AM.");
  });
});
