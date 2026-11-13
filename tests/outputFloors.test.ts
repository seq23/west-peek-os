import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { SPONSOR_FLOOR, sponsorFloor } from "../src/worker/services/roomPacket";
import { WAY_IN_WEEKS, wayInListing, wayInWords } from "../src/shared/tlc/mustPitch";
import { whyIsMissing, writeWhyLine } from "../src/worker/services/meetingBrief";

/*
 * THE FLOORS OF THREE DELIVERABLES (owner, 13 Nov 2026), each read on the finished work and each proven on the run it
 * would have caught. Every organisation, brand and person here is made up. (The hire search and the monthly
 * Productions note have theirs in productionsHire.test.ts and productions.test.ts.)
 */

describe("Room sponsor research: at least five, each with a contact or a page, none from the last two packets", () => {
  const sponsor = (n: number, over: { contact?: boolean; evidence?: number } = {}) => ({
    orgName: `Made-up Sponsor ${n}`,
    contact: over.contact === false ? null : { name: `Person ${n}`, title: "Head of Partnerships", sourceUrl: `https://sponsor${n}.example/team` },
    evidence: Array.from({ length: over.evidence ?? 1 }, (_, i) => ({ url: `https://sponsor${n}.example/e${i}`, note: "sponsored a comparable event" })),
  });

  it("the December packet (six researched, three of them in earlier packets) misses; the November packet (six, six contacts) passes", () => {
    const december = [1, 2, 3, 4, 5, 6].map((n) => sponsor(n, { contact: n <= 4 }));
    const earlier = ["Made-up Sponsor 1 Inc.", "made-up sponsor 2", "Made-up Sponsor 3"];
    const out = sponsorFloor(december, earlier);
    expect(out).toMatchObject({ ok: false, good: 3 });
    expect(out.miss).toBe(`Sponsor research is thin this month: 3 of the ${SPONSOR_FLOOR} a packet needs came with a named contact or a page that answered, and 3 (Made-up Sponsor 1, Made-up Sponsor 2, Made-up Sponsor 3) were in the last two packets, after 6 were researched.`);
    expect(sponsorFloor([1, 2, 3, 4, 5, 6].map((n) => sponsor(n)), ["Somebody Else"])).toEqual({ ok: true, good: 6, miss: null });
  });

  it("a sponsor with neither a named contact nor a page does not count; a page alone does", () => {
    const five = [1, 2, 3, 4, 5].map((n) => sponsor(n, { contact: false }));
    expect(sponsorFloor(five).ok, "a page that answered is enough").toBe(true);
    expect(sponsorFloor([...five.slice(0, 4), sponsor(5, { contact: false, evidence: 0 })])).toMatchObject({ ok: false, good: 4 });
  });
});

describe("TLC: a brand that still needs a way in is said as new for three weeks, once more with what was tried, then not again", () => {
  const item = { brand: "Made-up Brand", months: ["2027-01", "2027-03"], pages: ["https://brand.example/partners", "https://brand.example/contact"] };

  it("weeks 1 to 3 read as before; week 4 says it once and stops; after that it is left out until something changes", () => {
    for (const days of [0, 6, 7, 14, 20]) expect(wayInListing(item, days)).toBe(wayInWords(item));
    const fourth = wayInListing(item, WAY_IN_WEEKS * 7);
    expect(fourth).toBe("Made-up Brand (Jan, Mar): still no public partnerships address after 3 weeks of checking (https://brand.example/partners, https://brand.example/contact). It will not be listed again until something changes; add a contact or an intro on the TLC page, or take the brand off the list.");
    expect(wayInListing(item, 27)).toBe(fourth);
    for (const days of [28, 35, 90]) expect(wayInListing(item, days), `${days} days`).toBeNull();
    // Something changed (a month, an address, a contact): the count starts again and it is listed as new.
    expect(wayInListing({ ...item, months: ["2027-01"] }, 0)).toBe(wayInWords({ ...item, months: ["2027-01"] }));
  });
});

describe("Wednesday prep: 'Why this meeting exists' is never an unexplained blank", () => {
  const ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: ["west-peek"] };
  const empty = { prepared_by: "Walker", record: { about: "COMPANY" as const, name: "Made-up Co", summary: null, stage: null, touches: [] }, find_out: [], last_time: { firm: [], counterparty: [] }, diligence: null };

  it("nothing on file: no model is asked, and the slot names what is missing and how to fix it", async () => {
    // The shape every prep since September had: a title, a name, and nothing that says why. No database is touched.
    const out = await writeWhyLine({} as Env, ACTOR, { id: "mtg_x", title: "Catch-up", meeting_type: "COMPANY", scheduled_at: null, privacy_label: "INTERNAL" } as never, empty as never);
    expect(out.ai_run_id).toBeNull();
    expect(out.why).toBeNull();
    expect(out.unavailable).toBe("Nothing on file says why this meeting exists. Made-up Co has no summary or stage on file, and there is no earlier meeting, open question or promise to bring. The invitation's own text is not kept, so add one line to the meeting and the next prep carries it.");
    expect(whyIsMissing({ ...empty, record: { ...empty.record, about: "NOBODY", name: null } })).toMatch(/^Nothing on file says why this meeting exists\. This meeting is not tied to a company or an LP/);
  });

  it("anything that could say why counts: a stage, a summary, an open question, a promise still owed", () => {
    expect(whyIsMissing({ ...empty, record: { ...empty.record, stage: "DILIGENCE" } })).toBeNull();
    expect(whyIsMissing({ ...empty, record: { ...empty.record, summary: "A made-up company that sells widgets." } })).toBeNull();
    expect(whyIsMissing({ ...empty, find_out: [{ text: "What is the churn?" }] as never })).toBeNull();
    expect(whyIsMissing({ ...empty, last_time: { firm: [{ text: "send the deck", standing: "OPEN" }] as never, counterparty: [] } })).toBeNull();
    // A promise already delivered is not a reason to meet.
    expect(whyIsMissing({ ...empty, last_time: { firm: [{ text: "send the deck", standing: "DELIVERED" }] as never, counterparty: [] } })).not.toBeNull();
  });
});
