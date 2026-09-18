import { describe, expect, it } from "vitest";
import { answerLine, inWords, secondLine } from "../src/shared/home/answerLine";

/**
 * THE ONE LINE AT THE TOP OF HOME.
 *
 * Operator, 18 Sep 2026: "i can't keep up ... the headings have no visual weight". Home's largest
 * type was a greeting, and the answer to the question the page exists to answer — is anything
 * blocked on me — was spread across five places at five weights. Rank 0 is now the answer itself.
 *
 * These are grammar and arithmetic, and both are load-bearing. A page that says "two decisions"
 * when there are three is worse than a page that says nothing, and "1 of your team have something"
 * is the kind of line a partner reads every single morning and stops trusting.
 */

describe("the answer line", () => {
  it("states the zero case rather than rendering an empty section to say it", () => {
    expect(answerLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 0 })).toBe(
      "Nothing is waiting on your signature.",
    );
  });

  it("agrees the verb with one", () => {
    expect(answerLine({ decisions: 1, blockers: 0, fresh: 0, quiet: 0 })).toBe(
      "One decision is waiting on you.",
    );
  });

  it("is the mock's own line at two", () => {
    expect(answerLine({ decisions: 2, blockers: 0, fresh: 0, quiet: 0 })).toBe(
      "Two decisions are waiting on you.",
    );
  });

  /*
   * A BLOCKER IS NOT A SIGNATURE, and conflating them is how a partner learns to discount rank 0.
   * The quiet-day mock has one blocker (the calendar) and its headline still reads "Nothing is
   * waiting on your signature" — the blocker is reported on the second line, where it belongs.
   */
  it("does not count a blocker as a decision", () => {
    expect(answerLine({ decisions: 0, blockers: 3, fresh: 1, quiet: 9 })).toBe(
      "Nothing is waiting on your signature.",
    );
  });

  it("falls back to digits past nine rather than inventing long number words", () => {
    expect(answerLine({ decisions: 12, blockers: 0, fresh: 0, quiet: 0 })).toBe(
      "12 decisions are waiting on you.",
    );
    expect(inWords(9)).toBe("nine");
    expect(inWords(10)).toBe("10");
  });
});

describe("the second line", () => {
  it("reads as the quiet-day mock does", () => {
    expect(
      secondLine({
        decisions: 0,
        blockers: 1,
        firstBlocker: "your calendar is not connected",
        fresh: 1,
        quiet: 9,
      }),
    ).toBe(
      "One thing is unfinished — your calendar is not connected. One of your team has something new for you. Nine colleagues have nothing new.",
    );
  });

  it("drops a clause whose count is zero instead of printing a zero", () => {
    const line = secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 0 });
    expect(line).toBe("Nothing new from your team since you last looked.");
    expect(line).not.toMatch(/\b0\b|zero/i);
  });

  it("never doubles the full stop when the blocker headline already ends in one", () => {
    const line = secondLine({ decisions: 0, blockers: 1, firstBlocker: "Calendar is not connected.", fresh: 0, quiet: 0 });
    expect(line).toContain("Calendar is not connected.");
    expect(line).not.toContain("..");
  });

  it("says something honest when a blocker arrives without a headline", () => {
    expect(secondLine({ decisions: 0, blockers: 1, firstBlocker: null, fresh: 0, quiet: 0 })).toContain(
      "One thing is unfinished.",
    );
  });

  it("agrees has/have with the number of colleagues", () => {
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 1, quiet: 0 })).toContain("One of your team has");
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 2, quiet: 0 })).toContain("Two of your team have");
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 1 })).toContain("One colleague has nothing new.");
    expect(secondLine({ decisions: 0, blockers: 0, fresh: 0, quiet: 2 })).toContain("Two colleagues have nothing new.");
  });

  it("pluralises more than one unfinished thing without quoting any one of them", () => {
    expect(
      secondLine({ decisions: 0, blockers: 2, firstBlocker: "calendar is not connected", fresh: 0, quiet: 0 }),
    ).toContain("Two things are unfinished.");
  });
});
