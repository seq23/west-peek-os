import { describe, expect, it } from "vitest";
import { BRAND_FLOW, FLOW_TEMPLATES, FOLLOW_UPS, fillTemplate, levelPicked, proposalLevelLines } from "../src/shared/tlc/brandFlow";
import { brandLevels, sponsorOf } from "../src/shared/tlc/pitch";
import { TLC_DRIP_DAYS, TLC_SIGNATURE, dripEmail } from "../src/shared/tlc/learningClub";
import { samplesCoverEmail } from "../src/shared/tlc/samples";
import { BRAND_MAILING_ADDRESS } from "../src/shared/tlc/brandFooter";
import { BRAND_MUST_STAFF, CALL_ASK, MONEY_WORDS } from "../src/shared/tlc/brandReply";

/**
 * HER BRAND FLOW IS DATA THE CODE READS (owner, 26 Oct 2026; shared/tlc/brandFlow.ts, from her spec artifact v8).
 * A fake brand only: the real instance lives in production data.
 */
const SPONSOR = sponsorOf({ brand: "Vector Co", category: "Vector database" });
const FAKE = { hi: "Hi Sam,", brand: "Vector Co", topic: "Build Your Own AI Agent", segment: "Giving your agent a memory", arc: "a run that follows the arc of building an agent", level: "Presenting partner", times: "• Tuesday 10 Nov, 2:00pm", time: "Tuesday 10 Nov, 2:00pm", levels: proposalLevelLines(brandLevels(SPONSOR, "Build Your Own AI Agent")) };

describe("the five steps and the call branch, as the code reads them", () => {
  it("five steps; money first at step 4; one follow-up, which is the drip's last email and carries the samples PDF", () => {
    expect(BRAND_FLOW.map((s) => [s.n, s.money])).toEqual([[1, "No"], [2, "No"], [3, "No"], [4, "First time"], [5, "Yes"]]);
    expect(BRAND_FLOW[1]!.attaches).toEqual(["the 3-page samples PDF"]);
    expect(BRAND_FLOW[1]!.email).toMatch(/day 12, the only automatic send/);
    expect(fillTemplate("followUp", FAKE)).toMatch(/I've attached a short 3-page PDF built around Vector Co/);
    expect(fillTemplate("followUp", FAKE).split("\n").slice(2)).toHaveLength(3);
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
    // Step 4 lists the same levels as that brand's sheet, each per event, lowest first; Lead is the one it would benefit most from.
    const proposal = fillTemplate("proposal", FAKE);
    for (const m of proposal.matchAll(/\$[\d,]+/g)) expect(proposal.slice(m.index! + m[0].length).startsWith(" per event"), m[0]).toBe(true);
    expect([...proposal.matchAll(/\$([\d,]+) per event/g)].map((m) => Number(m[1]!.replace(/,/g, "")))).toEqual([5_000, 10_000, 15_000]);
    expect(proposal).toContain("Lead is the level brands like Vector Co would benefit most from.");
    expect(proposal).toContain("A series of six: the same per-event price for each club, as a founding partner.");
    expect(proposal.match(/Presented by/g)).toHaveLength(1);
    expect(proposal).not.toMatch(/Title partner|in kind|Product partner|most brands choose/i);
    expect(fillTemplate("confirm", FAKE)).toContain("Attached are a one-page agreement and the invoice.");
    expect(() => fillTemplate("confirm", { hi: "Hi," })).toThrow(/needs \{brand\}/);
  });

  it("the drip's follow-up and the cover email ARE the templates", () => {
    expect(dripEmail({ step: 1, brand: "Vector Co", contactName: "Sam Lee", topic: "T", month: "2027-03", eventDate: "2027-03-18", why: null }).text)
      .toBe([fillTemplate("followUp", FAKE), "", ...TLC_SIGNATURE, "", BRAND_MAILING_ADDRESS].join("\n"));
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
