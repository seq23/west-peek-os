import { describe, expect, it } from "vitest";
import { BRAND_FLOW, FLOW_TEMPLATES, FOLLOW_UPS, fillTemplate, levelPicked } from "../src/shared/tlc/brandFlow";
import { TLC_DRIP_DAYS, TLC_SIGNATURE, dripEmail } from "../src/shared/tlc/learningClub";
import { samplesCoverEmail } from "../src/shared/tlc/samples";
import { BRAND_MUST_STAFF, CALL_ASK, MONEY_WORDS } from "../src/shared/tlc/brandReply";

/**
 * HER BRAND FLOW IS DATA THE CODE READS (owner, 26 Oct 2026; shared/tlc/brandFlow.ts, from her spec artifact v8).
 * A fake brand only: the real instance lives in production data.
 */
const FAKE = { hi: "Hi Sam,", brand: "Vector Co", topic: "Build Your Own AI Agent", segment: "Giving your agent a memory", arc: "a run that follows the arc of building an agent", level: "Presenting partner", times: "• Tuesday 10 Nov, 2:00pm", time: "Tuesday 10 Nov, 2:00pm" };

describe("the five steps and the call branch, as the code reads them", () => {
  it("five steps; money first at step 4; one follow-up, which is the drip's last email", () => {
    expect(BRAND_FLOW.map((s) => [s.n, s.money])).toEqual([[1, "No"], [2, "No"], [3, "No"], [4, "First time"], [5, "Yes"]]);
    expect(FOLLOW_UPS).toBe(1);
    expect(TLC_DRIP_DAYS.length).toBe(1 + FOLLOW_UPS);
  });

  it("every template fills with a brand's words, and keeps her rules: no call ask, we host, no money before step 4", () => {
    for (const name of Object.keys(FLOW_TEMPLATES) as Array<keyof typeof FLOW_TEMPLATES>) {
      const text = fillTemplate(name, FAKE);
      expect(text, name).not.toMatch(/\{\w+\}/);
      expect(text, name).not.toMatch(BRAND_MUST_STAFF);
      if (name === "followUp" || name === "cover") {
        expect(text, name).not.toMatch(MONEY_WORDS);
        expect(text, name).not.toMatch(CALL_ASK);
      }
    }
    // Step 4 names the levels and points to the one-pager for prices; the body itself carries no dollar figure.
    expect(fillTemplate("proposal", FAKE)).toContain("Prices for each are on the attached one-pager.");
    expect(fillTemplate("proposal", FAKE)).not.toMatch(/\$\d/);
    expect(fillTemplate("confirm", FAKE)).toContain("Attached are a one-page agreement and the invoice.");
    expect(() => fillTemplate("confirm", { hi: "Hi," })).toThrow(/needs \{brand\}/);
  });

  it("the drip's follow-up and the cover email ARE the templates", () => {
    expect(dripEmail({ step: 1, brand: "Vector Co", contactName: "Sam Lee", topic: "T", month: "2027-03", eventDate: "2027-03-18", why: null }).text)
      .toBe([fillTemplate("followUp", FAKE), "", ...TLC_SIGNATURE].join("\n"));
    expect(samplesCoverEmail({ brand: "Vector Co", contactName: "Sam Lee", topic: FAKE.topic, segmentTitle: FAKE.segment })).toBe(fillTemplate("cover", FAKE));
  });

  it("reads which level they picked, and only when they say they want it", () => {
    expect(levelPicked("Let's go with Presenting partner")).toBe("PRESENTING");
    expect(levelPicked("We'd like the Title partner level")).toBe("TITLE");
    expect(levelPicked("Partner works for us")).toBe("PARTNER");
    expect(levelPicked("We'd love to supply product in kind instead")).toBe("PRODUCT");
    expect(levelPicked("What does the Presenting partner include?")).toBeNull();
  });
});
