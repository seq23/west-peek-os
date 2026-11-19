import { describe, expect, it } from "vitest";
import { parseWebPropertyAsk, propertiesIn, WEB_PROPERTIES, type WebProperty } from "../src/shared/intake/webPropertyChange";

/** 19 Nov 2026 (wc_59ef2d40): "separate from Top Barz" named Top Barz, and the quote tool was filed under topbarz-voting. */
const TOPBARZ: WebProperty = { host: "voting.topbarz.xyz", repo: "topbarz-voting", site: ".", words: ["top barz", "topbarz", "the voting site"] } as WebProperty;
const REG = [...WEB_PROPERTIES, TOPBARZ];

describe("a property the partner says the request is NOT about names nothing", () => {
  it("Scooter's quote-tool reply on the Productions card builds Productions, not Top Barz", () => {
    const ask = parseWebPropertyAsk('Change westpeekproductions.com: "Hey Porter and Sequoia!"', "Hey Porter!\n\nOne combined update for the Productions dashboard, separate from Top Barz.\n\n1. Quote tool", REG, "UNRESOLVED");
    expect(ask?.target_repo).toBe("join-west-peek-main");
  });
  it.each([
    "This does not approve publishing the Top Barz voting site.",
    "Nothing to do with Top Barz.",
    "This is not for the voting site.",
    "Apart from topbarz, nothing changes.",
  ])("negated: %s", (text) => {
    expect(propertiesIn(text, REG).map((p) => p.repo)).not.toContain("topbarz-voting");
  });
  it.each(["New build for the Top Barz site: a holiday party version.", "Fix the voting site header.", "Top Barz needs a new page."])("still named: %s", (text) => {
    expect(propertiesIn(text, REG).map((p) => p.repo)).toContain("topbarz-voting");
  });
});
