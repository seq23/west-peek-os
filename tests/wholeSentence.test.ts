import { describe, expect, it } from "vitest";
import { sentencesOf, stands, vetoOf } from "../src/shared/text/wholeSentence";
import { ownershipIntentIn } from "../src/shared/work/partnerOwnership";
import { readApprovalReply } from "../src/shared/work/approvalReply";
import { planFirstIn } from "../src/worker/services/webPropertyChange";
import { propertiesIn } from "../src/shared/intake/webPropertyChange";
import { ccAsksIn } from "../src/shared/work/ccPartners";
import { partnerBackIn } from "../src/shared/work/partnerBackBy";

/**
 * EVERY KEYWORD RULE JUDGES THE WHOLE SENTENCE ITS WORDS SIT IN (owner ruling, 19 Nov 2026). The keywords are the
 * logged last resort when no first read exists; even then a phrase never acts on its own. Each case below is a real
 * shape (negated, conditional, reported or quoted, asked) that the rule acted on before the shared judge, beside the
 * plain phrasing that must still act.
 */
const SEQUOIA = "sequoia@westpeek.ventures";
const FRI = new Date("2026-11-13T15:00:00.000Z");

describe("the splitter and the judge", () => {
  it("a sentence runs from the previous . ! ? ; or line break to the next; a host or an address is not a boundary", () => {
    expect(sentencesOf("Approved. Hand it to Scooter; thanks!\nDon't publish joinwestpeek.com yet? ok").map((s) => s.text)).toEqual([
      "Approved.",
      "Hand it to Scooter;",
      "thanks!",
      "Don't publish joinwestpeek.com yet?",
      "ok",
    ]);
  });

  it("negates, conditions, reports or asks; the phrase's own words never count against it", () => {
    expect(vetoOf("I don't think Scooter will take it from here")).toBe("NEGATES");
    expect(vetoOf("if this fails I'll take it back")).toBe("CONDITIONS");
    expect(vetoOf("he said hand it to Scooter")).toBe("REPORTS");
    expect(vetoOf('Keep "hand it to Scooter" as the button text', { from: 6, to: 24 })).toBe("REPORTS");
    expect(vetoOf("hand it to Scooter?")).toBe("ASKS");
    expect(vetoOf("don't land it", { from: 0, to: 10 })).toBeNull();
    expect(stands("Please hand it to Scooter.", /hand it to scooter/i)).toBe(true);
  });
});

describe("hand-off", () => {
  it.each([
    "I don't think Scooter will take it from here.",
    "If I'm out next week, Scooter will take it from here.",
    "He said Scooter will take it from here, but I'd rather keep it.",
    'The button should say "hand this to Scooter".',
    "Hand this to Scooter?",
  ])("does not hand off: %s", (said) => {
    expect(ownershipIntentIn(said, SEQUOIA)?.kind).not.toBe("HAND_OFF");
  });

  it("a negated or conditional sentence is not even a question", () => {
    expect(ownershipIntentIn("I don't think Scooter will take it from here.", SEQUOIA)).toBeNull();
    expect(ownershipIntentIn("If I'm out next week, Scooter will take it from here.", SEQUOIA)).toBeNull();
  });

  it("the plain phrasing still hands off, and a hand-off to someone who is not a partner is still named", () => {
    expect(ownershipIntentIn("Scooter will take it from here.", SEQUOIA)).toMatchObject({ kind: "HAND_OFF", to: { email: "scooter@westpeek.ventures" } });
    expect(ownershipIntentIn("Hand this to Bob.", SEQUOIA)).toMatchObject({ kind: "HAND_OFF", to: null, named: "Bob" });
    expect(ownershipIntentIn("If it slips, hand this to Bob.", SEQUOIA)).toBeNull();
  });
});

describe("take-back", () => {
  it.each(["if this fails I'll take it back", "Last time I said I'll take it back, and I did not.", "Should I take this back?"])("does not take back: %s", (said) => {
    expect(ownershipIntentIn(said, SEQUOIA)).toBeNull();
  });
  it("the plain phrasing still takes back", () => {
    expect(ownershipIntentIn("I'll take it back.", SEQUOIA)).toEqual({ kind: "TAKE_BACK" });
  });
});

describe("stop", () => {
  it.each(["Stop the build?", "Hold off if the client hasn't signed.", "Wait, I don't think that's right."])("is read for its intent, never a stop by keyword: %s", (said) => {
    expect(readApprovalReply(said).kind).toBe("ANSWERS");
  });
  it.each(["Don't land it yet.", "Hold off until Monday.", "stop", "not approved"])("still stops: %s", (said) => {
    expect(readApprovalReply(said).kind).toBe("REFUSED");
  });
});

describe("approval", () => {
  it.each(["Approved?", "If approved, publish it.", 'He wrote "approved" on the old card.'])("is not an approval: %s", (said) => {
    expect(readApprovalReply(said).kind).not.toBe("APPROVED");
  });
  it("the word alone still approves", () => {
    expect(readApprovalReply("Approved.").kind).toBe("APPROVED");
  });
});

describe("plan approval: does the plan wait for him?", () => {
  it.each(["You don't need to confirm the plan, just build it.", "Last time he said send me the plan first; this one is simple."])("does not wait: %s", (said) => {
    expect(planFirstIn(said)).toBe(false);
  });
  it.each(["Please confirm the plan before you build.", "Can you send me the plan first?"])("waits (a question still asks for the plan): %s", (said) => {
    expect(planFirstIn(said)).toBe(true);
  });
});

describe("property: which site", () => {
  it("a reported or quoted site is not the one asked about", () => {
    expect(propertiesIn("Last time we changed the community site the logo broke. Update the agency site.").map((p) => p.host)).toEqual(["westpeekproductions.com"]);
    expect(propertiesIn('Change the agency site footer to say "Join us on the community site".').map((p) => p.host)).toEqual(["westpeekproductions.com"]);
  });
  it("a request asked as a question, or a bug report that negates the problem, still names its site", () => {
    expect(propertiesIn("Can you update the community site?").map((p) => p.host)).toEqual(["joinwestpeek.com"]);
    expect(propertiesIn("The contact form is not working on joinwestpeek.com.").map((p) => p.host)).toEqual(["joinwestpeek.com"]);
  });
});

describe("cc", () => {
  it.each(["Don't cc Scooter on this.", "Should I cc Scooter?", "If he asks, cc Scooter."])("asks for no copy: %s", (said) => {
    expect(ccAsksIn(said)).toEqual([]);
  });
  it("the plain phrasing still copies", () => {
    expect(ccAsksIn("Please cc Scooter.")).toEqual(["scooter"]);
  });
});

describe("back on <day>", () => {
  it.each(["If I can, I'll get back to you Monday.", "Will I have it tomorrow? Not sure."])("is no promise: %s", (said) => {
    expect(partnerBackIn(said, FRI)).toBeNull();
  });
  it("the plain promise still counts", () => {
    expect(partnerBackIn("I'll get back to you tomorrow.", FRI)?.back_at).toBe("2026-11-15T14:00:00.000Z");
  });
});
