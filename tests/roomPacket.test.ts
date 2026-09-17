import { describe, expect, it } from "vitest";
import {
  BUDGET_KEYS,
  SPONSORSHIP_TARGET,
  audienceTerms,
  buildConceptsPrompt,
  buildPacketPrompt,
  buildSponsorDiscoveryPrompt,
  buildSponsorResearchPrompt,
  computeEconomics,
  defaultStructure,
  estimateVenueCost,
  followingMonth,
  inviteVerdict,
  mergeBriefSponsors,
  monthKey,
  pageCarriesName,
  parseConcepts,
  parsePacket,
  parseSponsorCandidates,
  parseSponsorResearch,
  sameOrg,
  venueSearchBrief,
  verifyPacket,
  type PacketVenue,
  type SponsorResearch,
} from "../src/shared/events/roomPacket";
import { packetFilename, parkerIntroduction, renderPacketHtml, type PacketView } from "../src/shared/events/roomPacketPdf";

/**
 * The Room packet as a CHAIN (15 Sep 2026). The operator's verdict on the one-prompt packet was
 * "sub par", and the standard she showed was research and judgement in sequence: the sponsor's
 * real programme and the people who run it, three concepts compared, a venue with a reason, a run
 * of show to the minute, a budget with its basis, a structure priced to cost + the firm's keep,
 * and the cold email. Everything here is pure: prompts, parsers, verifiers, the economics, the
 * PDF's HTML. No model, no network.
 */

const SOURCES = [
  "https://www.gramercytavern.com/private-dining",
  "https://bluehillfarm.com/events",
];

const HARVEY: SponsorResearch = {
  orgName: "Harvey",
  category: "LEGAL",
  hasSponsorshipHistory: true,
  evidence: [{ url: "https://www.harvey.ai/blog/harvey-us-open", note: "official AI partner of the 2025 US Open" }],
  contact: { name: "Mali Robertson", title: "Director of Brand Partnerships", sourceUrl: "https://www.harvey.ai/team" },
  strategicLanguage: ["the AI platform for elite law firms", "we partner with the institutions that shape the profession"],
  summary: "Sponsors tennis, three NBA/WNBA teams, PSG and Lavender Law.",
  fromBrief: true,
};

function packetJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "The Scaled Boardroom",
    theme: "Black lawyers and the founders who need them",
    central_question: "What does the next decade of Black legal leadership need from its peers?",
    format: "DINNER",
    target_min: 30,
    target_max: 40,
    audience: "senior associates and new partners, in-house counsel, and the founders who hire them",
    agenda_md: "## 6:30 arrivals",
    run_of_show: [
      { time: "6:30 PM", minutes: 30, what: "Arrival, cocktails", who: "Sequoia Taylor (host)" },
      { time: "7:00 PM", minutes: 5, what: "Welcome, why this room", who: "Sequoia Taylor" },
      { time: "7:05 PM", minutes: 6, what: "The sponsor's executive on where legal AI is going", who: "Harvey — 6 minutes" },
      { time: "7:15 PM", minutes: 60, what: "Seated dinner; the question at every table, Chatham House rule", who: "moderator" },
      { time: "8:15 PM", minutes: 20, what: "Signature moment: the three-line brief each guest writes for their younger self", who: "moderator" },
      { time: "9:15 PM", minutes: 30, what: "Nightcap; the takeaway leaves with every guest", who: "Parker" },
    ],
    seed_questions: [
      "Who sponsored you, and what did it cost them?",
      "Which client did you turn down, and why?",
      "When did you know you would make partner?",
    ],
    guest_ideas: [{ description: "a newly made partner at an AmLaw 50 firm", why: "lived it this year" }],
    venues: [
      {
        name: "Gramercy Tavern", city: "New York", address: "42 E 20th St", capacity: 40, why_here: "the room says serious", room_minimum_usd: 5500,
        price_low_usd: 6000, price_high_usd: 9000, price_note: "private dining minimum",
        booking_phone: "+1 212 477 0777", booking_email: null, booking_url: "https://www.gramercytavern.com/private-dining",
        source_url: "https://www.gramercytavern.com/private-dining", estimate_low_usd: 6000, estimate_high_usd: 9000, estimate_basis: "the published minimum",
        is_fallback: false,
      },
      {
        name: "Blue Hill", city: "New York", capacity: 36, source_url: "https://bluehillfarm.com/events", is_fallback: true, estimate_low_usd: 7000, estimate_high_usd: 9000, estimate_basis: "comp",
      },
    ],
    budget: [{ key: "food_beverage", low_usd: 10000, high_usd: 10000, basis: "$250/head × 40 incl. tax and 22% service" }],
    sponsorship: {
      slots: [{ tier: "TITLE", count: 1, ask_usd: 20000, gets: "six minutes, the credit, the recap" }, { tier: "SUPPORTING", count: 2, ask_usd: 10000, gets: "a seat, the credit" }],
      exclusive_usd: 45000, exclusive_gets: "the whole room", rationale: "forty seats carry three logos, not six",
    },
    sponsor_thesis: "Underwrite the room where the next generation of counsel meets each other.",
    sponsor_prospects: [
      { org_name: "Harvey", category: "LEGAL", tier: "PRESENTING", ask_usd: 20000, rank: 1, fit_argument: "'the AI platform for elite law firms' — this is that room", pitch: "Be in the room", evidence_url: "https://www.harvey.ai/blog/harvey-us-open", evidence_note: "US Open", contact_name: "Mali Robertson", contact_title: "Director of Brand Partnerships", contact_source_url: "https://www.harvey.ai/team" },
      { org_name: "J.P. Morgan Private Bank", category: "BANKING", tier: "SUPPORTING", ask_usd: 10000, rank: 2, fit_argument: "courts partners and GCs", pitch: "…", evidence_url: "https://example.com/made-up", contact_name: "Somebody Invented", contact_title: "VP" },
    ],
    pitch_email: { to: "Mali Robertson, Director of Brand Partnerships, Harvey", subject: "A room of the lawyers Harvey is built for", body: "Mali —\n\nWest Peek Ventures is hosting…" },
    risks: ["A single legal sponsor reads as an endorsement"],
    commitment_md: "About $25k of spend, Parker's time, Harvey approached in West Peek's name.",
    pushback: "",
    concept_choice_md: "The boardroom wins because a senior crowd wants a serious table.",
    ...over,
  });
}

describe("parsing a packet", () => {
  it("reads a well-formed proposal, with the run of show, the structure, the ranking and the pitch", () => {
    const p = parsePacket(packetJson())!;
    expect(p.title).toBe("The Scaled Boardroom");
    expect(p.venues).toHaveLength(2);
    expect(p.venues[0]!.whyHere).toBe("the room says serious");
    expect(p.venues[0]!.roomMinimumUsd).toBe(5500);
    expect(p.venues[1]!.isFallback).toBe(true);
    expect(p.runOfShow).toHaveLength(6);
    expect(p.runOfShow[2]!.who).toContain("6 minutes");
    expect(p.structure.slots.map((s) => [s.tier, s.count, s.askUsd])).toEqual([["PRESENTING", 1, 20000], ["SUPPORTING", 2, 10000]]);
    expect(p.structure.exclusiveUsd).toBe(45000);
    expect(p.sponsorCount).toBe(3);
    expect(p.sponsorProspects.map((s) => s.rank)).toEqual([1, 2]);
    expect(p.pitchEmail?.subject).toContain("Harvey");
    expect(p.conceptChoiceMd).toContain("serious table");
  });

  it("reads it out of a fenced block, which is how models actually answer", () => {
    const p = parsePacket("Here you go:\n```json\n" + packetJson() + "\n```\nLet me know.");
    expect(p?.title).toBe("The Scaled Boardroom");
  });

  it("drops a venue with no source rather than showing it with a caveat", () => {
    const p = parsePacket(packetJson({ venues: [{ name: "Somewhere", city: "NYC" }, { name: "Real", source_url: SOURCES[0] }] }))!;
    expect(p.venues.map((v) => v.name)).toEqual(["Real"]);
  });

  it("keeps ONE fallback, and none when there is only one venue", () => {
    const p = parsePacket(packetJson({ venues: [{ name: "A", source_url: SOURCES[0], is_fallback: true }, { name: "B", source_url: SOURCES[1], is_fallback: true }] }))!;
    expect(p.venues.map((v) => v.isFallback)).toEqual([true, false]);
    const one = parsePacket(packetJson({ venues: [{ name: "A", source_url: SOURCES[0], is_fallback: true }] }))!;
    expect(one.venues[0]!.isFallback).toBe(false);
  });

  it("never accepts a person_id from the model", () => {
    const p = parsePacket(packetJson({ guest_ideas: [{ description: "x", person_id: "per_123" }] }))!;
    expect(p.guestIdeas[0]!.personId).toBeNull();
  });

  it("falls back to the firm's default structure when the model wrote none", () => {
    const p = parsePacket(packetJson({ sponsorship: undefined }))!;
    expect(p.structure.slots).toEqual(defaultStructure().slots);
    expect(p.structure.rationale).toMatch(/default shape/);
  });

  it("caps the slots at the sanity ceiling — six logos is not a judgement", () => {
    const p = parsePacket(packetJson({ sponsorship: { slots: [{ tier: "SUPPORTING", count: 9, ask_usd: 5000, gets: "…" }] } }))!;
    expect(p.sponsorCount).toBeLessThanOrEqual(SPONSORSHIP_TARGET.maxSlots);
  });

  it("returns null for unparseable output instead of a half-built packet", () => {
    expect(parsePacket("I cannot help with that.")).toBeNull();
  });
});

describe("verification against what the searches and the research actually returned", () => {
  it("drops a venue whose source the search never returned, and keeps the fallback", () => {
    const { packet, flags } = verifyPacket(parsePacket(packetJson({ venues: [{ name: "Fake", source_url: "https://nope.example/x" }, { name: "Blue Hill", source_url: SOURCES[1] }] }))!, SOURCES);
    expect(packet.venues.map((v) => v.name)).toEqual(["Blue Hill"]);
    expect(flags.some((f) => f.code === "invented_url" && f.detail.includes("Fake"))).toBe(true);
  });

  it("keeps a sponsor's evidence only if the research verified it, and a contact only if it was read off a page", () => {
    const { packet, flags } = verifyPacket(parsePacket(packetJson())!, SOURCES, [HARVEY]);
    const harvey = packet.sponsorProspects.find((s) => s.orgName === "Harvey")!;
    expect(harvey.evidenceUrl).toBe("https://www.harvey.ai/blog/harvey-us-open");
    expect(harvey.contactName).toBe("Mali Robertson");
    expect(harvey.contactSourceUrl).toBe("https://www.harvey.ai/team");
    const jpm = packet.sponsorProspects.find((s) => s.orgName.startsWith("J.P."))!;
    // The made-up evidence and the invented contact both go; the prospect survives, flagged.
    expect(jpm.evidenceUrl).toBeNull();
    expect(jpm.contactName).toBeNull();
    expect(flags.some((f) => f.code === "sponsor_without_evidence" && f.detail.includes("J.P."))).toBe(true);
    expect(flags.some((f) => f.code === "contact_without_source" && f.detail.includes("J.P."))).toBe(true);
    // An unevidenced prospect ranks below every evidenced one.
    expect(packet.sponsorProspects.map((s) => s.rank)).toEqual([1, 2]);
    expect(packet.sponsorProspects[0]!.orgName).toBe("Harvey");
  });

  it("fills in the research's evidence and contact when the model left them blank", () => {
    const { packet } = verifyPacket(parsePacket(packetJson({ sponsor_prospects: [{ org_name: "Harvey AI", category: "LEGAL", rank: 1 }] }))!, SOURCES, [HARVEY]);
    expect(packet.sponsorProspects[0]!.evidenceUrl).toBe(HARVEY.evidence[0]!.url);
    expect(packet.sponsorProspects[0]!.contactTitle).toBe("Director of Brand Partnerships");
  });

  it("flags a run of show that is not to the minute", () => {
    const { flags } = verifyPacket(parsePacket(packetJson({ run_of_show: [{ time: "7 PM", what: "dinner" }] }))!, SOURCES);
    expect(flags.some((f) => f.code === "no_run_of_show")).toBe(true);
  });

  it("says so loudly when nothing survived, so a thin packet is not mistaken for a thin market", () => {
    const { flags } = verifyPacket(parsePacket(packetJson({ venues: [{ name: "Fake", source_url: "https://nope.example/x" }] }))!, SOURCES);
    expect(flags.some((f) => f.code === "no_venues")).toBe(true);
  });

  it("does not drop everything when no search ran", () => {
    const { packet } = verifyPacket(parsePacket(packetJson())!, []);
    expect(packet.venues).toHaveLength(2);
  });

  it("flags a room too thin or too big to be a conversation, and a missing sponsor thesis", () => {
    const { flags } = verifyPacket(parsePacket(packetJson({ target_min: 4, target_max: 120, sponsor_thesis: null }))!, SOURCES);
    expect(flags.some((f) => f.code === "target_out_of_range")).toBe(true);
    expect(flags.some((f) => f.code === "no_sponsor_thesis")).toBe(true);
  });
});

describe("the partner's named sponsor is a seed, never lost", () => {
  it("keeps her name, ranked last with the honest finding, when the packet left it out", () => {
    const base = parsePacket(packetJson({ sponsor_prospects: [{ org_name: "Clio", category: "LEGAL", rank: 1, evidence_url: SOURCES[0] }] }))!;
    const noHistory: SponsorResearch = { ...HARVEY, orgName: "Harvey AI", hasSponsorshipHistory: false, evidence: [], contact: null };
    const merged = mergeBriefSponsors(base, { audience: "lawyers", month: "2026-10", city: null, sponsorProspects: ["Harvey AI (harvey.ai)"], notes: null }, [noHistory]);
    expect(merged.sponsorProspects.map((s) => s.orgName)).toEqual(["Clio", "Harvey AI (harvey.ai)"]);
    expect(merged.sponsorProspects[1]!.fromBrief).toBe(true);
    expect(merged.sponsorProspects[1]!.note).toMatch(/No sponsorship history/);
    expect(merged.sponsorProspects[1]!.rank).toBe(2);
  });

  it("recognises her prospect when Parker wrote it under a slightly different name", () => {
    const merged = mergeBriefSponsors(parsePacket(packetJson())!, { audience: "lawyers", month: "2026-10", city: null, sponsorProspects: ["Harvey AI (harvey.ai)"], notes: null });
    expect(merged.sponsorProspects.filter((s) => s.fromBrief).map((s) => s.orgName)).toEqual(["Harvey"]);
    expect(sameOrg("Harvey AI (harvey.ai)", "Harvey")).toBe(true);
    expect(sameOrg("Thomson Reuters", "Harvey")).toBe(false);
  });
});

describe("economics", () => {
  const venues: PacketVenue[] = [
    { name: "A", city: null, address: null, capacity: null, priceLowUsd: 5000, priceHighUsd: 7000, priceNote: null, bookingPhone: null, bookingEmail: null, bookingUrl: null, sourceUrl: SOURCES[0]!, estimateLowUsd: 5000, estimateHighUsd: 7000, estimateBasis: "published", whyHere: null, roomMinimumUsd: 5000, isFallback: false },
  ];
  const structure = parsePacket(packetJson())!.structure;

  it("totals a full budget with contingency and prices the structure against cost plus the firm's keep", () => {
    const e = computeEconomics({ venues, targetAttendees: 40, structure, budgetLines: [{ key: "food_beverage", lowUsd: 10000, highUsd: 10000, basis: "$250 × 40 incl. tax and service" }] });
    expect(e.lines.map((l) => l.key)).toEqual([...BUDGET_KEYS]);
    expect(e.lines.find((l) => l.key === "food_beverage")!.basis).toContain("$250");
    expect(e.lines.find((l) => l.key === "gifting")!.basis).toMatch(/rule of thumb/);
    expect(e.keepTargetUsd).toBe(SPONSORSHIP_TARGET.keepUsd);
    expect(e.requiredUsd).toBe(e.estimatedCostHighUsd + SPONSORSHIP_TARGET.keepUsd);
    expect(e.sponsorTargetHighUsd).toBe(40_000);
    expect(e.sponsorCount).toBe(3);
    expect(e.reachesKeep).toBe(e.sponsorTargetHighUsd >= e.requiredUsd);
  });

  it("sells the slots in order — title first — and shows what is left after each one lands", () => {
    const e = computeEconomics({ venues, targetAttendees: 40, structure });
    expect(e.scenarios.map((s) => [s.sponsors, s.sponsorshipUsd])).toEqual([[1, 20000], [2, 30000], [3, 40000]]);
    expect(e.scenarios[0]!.description).toBe("1 title");
    expect(e.scenarios[2]!.description).toBe("1 title + 2 supporting");
    expect(e.scenarios[2]!.netHighUsd).toBe(40000 - e.estimatedCostLowUsd);
    expect(e.exclusiveScenario?.sponsorshipUsd).toBe(45000);
  });

  it("is not clamped to four sponsors — the structure is the judgement, the ceiling is sanity", () => {
    const five = { slots: [{ tier: "PRESENTING" as const, count: 1, askUsd: 15000, gets: "" }, { tier: "SUPPORTING" as const, count: 4, askUsd: 7500, gets: "" }], exclusiveUsd: null, exclusiveGets: null, rationale: "a summit-sized room" };
    const e = computeEconomics({ venues, targetAttendees: 60, structure: five });
    expect(e.sponsorCount).toBe(5);
    expect(e.scenarios).toHaveLength(5);
  });

  it("says when the structure falls short of the keep rather than rounding", () => {
    const thin = { slots: [{ tier: "SUPPORTING" as const, count: 1, askUsd: 5000, gets: "" }], exclusiveUsd: null, exclusiveGets: null, rationale: "" };
    const e = computeEconomics({ venues, targetAttendees: 40, structure: thin });
    expect(e.reachesKeep).toBe(false);
    expect(e.netLowUsd).toBeLessThan(0);
  });

  it("never prices a venue at $0: a page price, then Parker's comp, then the room-size rule of thumb", () => {
    expect(estimateVenueCost({ priceLow: 4000, priceHigh: null, estLow: null, estHigh: null, basis: null, city: "New York", capacity: 30 })).toEqual({ low: 4000, high: 4000, basis: "the price stated on the cited page" });
    expect(estimateVenueCost({ priceLow: null, priceHigh: null, estLow: 3000, estHigh: 6000, basis: "gallery buy-out comp", city: null, capacity: null })).toEqual({ low: 3000, high: 6000, basis: "gallery buy-out comp" });
    const thumb = estimateVenueCost({ priceLow: null, priceHigh: null, estLow: null, estHigh: null, basis: null, city: "Atlanta", capacity: 30 });
    expect(thumb.low).toBeGreaterThan(0);
    expect(thumb.basis).toMatch(/rule of thumb/);
  });

  it("handles a Room with no venue at all by costing the venue line on the rule of thumb", () => {
    const e = computeEconomics({ venues: [], targetAttendees: 30, structure });
    expect(e.lines.find((l) => l.key === "venue")!.lowUsd).toBeGreaterThan(0);
  });
});

describe("the sponsor discovery and research stages", () => {
  it("asks for who pays to be in front of the audience, by category, with the association sponsor lists as the answer key", () => {
    const prompt = buildSponsorDiscoveryPrompt({ brief: { audience: "top Black lawyers on the rise", month: "2026-10", city: "New York", sponsorProspects: ["Harvey AI"], notes: null }, city: "New York", month: "2026-10" });
    expect(prompt).toContain("PAY TO BE IN FRONT OF");
    expect(prompt).toMatch(/National Bar Association/);
    expect(prompt).toMatch(/Lavender Law/);
    expect(prompt).toMatch(/PRIVATE BANKS/);
    expect(prompt).toContain("Harvey AI");
    expect(prompt).toMatch(/do not assume it has any/);
    expect(prompt).toMatch(/No URL, no entry/);
  });

  it("keeps a candidate only with an evidence URL, once per organisation, hers first", () => {
    const out = parseSponsorCandidates(JSON.stringify({ results: [
      { org_name: "Clio", category: "LEGAL", evidence_url: "https://www.clio.com/sponsor", evidence_note: "sponsors the NBA convention" },
      { org_name: "Clio Inc", category: "LEGAL", evidence_url: "https://www.clio.com/other" },
      { org_name: "Nice Idea", category: "BANKING" },
      { org_name: "Harvey", category: "LEGAL", evidence_url: "https://www.harvey.ai/us-open" },
    ] }), { audience: "lawyers", month: "2026-10", city: null, sponsorProspects: ["Harvey AI (harvey.ai)"], notes: null });
    expect(out.map((c) => c.orgName)).toEqual(["Harvey", "Clio"]);
    expect(out[0]!.fromBrief).toBe(true);
  });

  it("asks the research for history, the people who run partnerships with the page that shows them, and their own words", () => {
    const prompt = buildSponsorResearchPrompt({ orgName: "Harvey", roomLine: "a Room", audience: "lawyers" });
    expect(prompt).toMatch(/SPONSORSHIP HISTORY/);
    expect(prompt).toMatch(/Director of Brand Partnerships/);
    expect(prompt).toMatch(/fetched and checked/);
    expect(prompt).toMatch(/STRATEGIC LANGUAGE/);
    expect(prompt).toMatch(/Never an email address/);
  });

  it("parses the research and keeps only entries with URLs", () => {
    const r = parseSponsorResearch(JSON.stringify({
      history: [{ url: "https://www.harvey.ai/us-open", note: "US Open" }, { note: "no url" }],
      contacts: [{ name: "Mali Robertson", title: "Director of Brand Partnerships", source_url: "https://www.harvey.ai/team" }, { name: "Nobody", title: "x" }],
      strategic_language: ["the AI platform for elite law firms", { phrase: "shape the profession", url: "https://www.harvey.ai/" }],
      summary: "Sponsors sport and the profession.",
      category: "LEGAL",
    }));
    expect(r.history).toHaveLength(1);
    expect(r.contacts).toHaveLength(1);
    expect(r.strategicLanguage.map((s) => s.phrase)).toEqual(["the AI platform for elite law firms", "shape the profession"]);
    expect(r.category).toBe("LEGAL");
  });

  it("a contact counts only when the fetched page carries the name", () => {
    expect(pageCarriesName("<h3>Mali <b>Robertson</b></h3> Director of Brand Partnerships", "Mali Robertson")).toBe(true);
    expect(pageCarriesName("<p>Mali J. Robertson leads partnerships</p>", "Mali Robertson")).toBe(false);
    expect(pageCarriesName("<p>Our team: Rachel Hepworth, CMO</p>", "Mali Robertson")).toBe(false);
    expect(pageCarriesName("", "Mali Robertson")).toBe(false);
  });
});

describe("ideate, compare, commit", () => {
  it("asks for three ANGLES on the month's one topic, compared, and one chosen with the reason", () => {
    const prompt = buildConceptsPrompt({ month: "2026-10", city: "New York", topic: "Black lawyers", setBy: "PARTNERS", steer: "several distinct name ideas, catchy", ran: [{ month: "2026-09", topic: "Content creation", note: "somebody outside the firm ran it" }], brief: { audience: "top Black lawyers", month: "2026-10", city: "New York", sponsorProspects: ["Harvey AI"], notes: null }, recentThemes: ["operator to founder"], inviteCheck: { totalContacts: 4712, matchingCount: 12, matchedOn: ["lawyers and legal roles"], archetypes: [], namedFromRecords: [], verdict: "STARTING_LIST", note: "a starting list" }, sponsors: [HARVEY] });
    // ONE TOPIC, SEVERAL ANGLES: her own words reach the model, and the topic is not up for grabs.
    expect(prompt).toMatch(/THE TOPIC IS ONE SUBJECT AND IT IS ALREADY DECIDED: "Black lawyers"/);
    expect(prompt).toMatch(/Black lawyers is a topic\. Community is a topic\./);
    expect(prompt).toMatch(/A concept whose `angle_on` is anything/);
    expect(prompt).toMatch(/several distinct name ideas, catchy/);
    // ADJACENCY READS WHAT RAN, including a month somebody outside the firm hosted.
    expect(prompt).toMatch(/WHAT ACTUALLY RAN LAST MONTH/);
    expect(prompt).toMatch(/2026-09: Content creation \(somebody outside the firm ran it\)/);
    expect(prompt).toMatch(/THREE ANGLES/);
    expect(prompt).toMatch(/war room/);
    expect(prompt).toMatch(/Dinner is ALLOWED/);
    expect(prompt).toMatch(/CHOOSE ONE/);
    expect(prompt).toMatch(/PUSH BACK/);
    expect(prompt).toContain("12 of 4712 community contacts");
    expect(prompt).toContain("Mali Robertson");
    expect(prompt).toContain("operator to founder");
  });

  it("parses the concepts with exactly one winner, and the venue direction the search runs for", () => {
    const out = parseConcepts(JSON.stringify({ topic: "Black lawyers", concepts: [
      { title: "War Room", angle_on: "Black lawyers", angle_kind: "FORMAT", format: "WORKSHOP", premise: "…", tone: "electric", value_to_sponsor: "tool in hand", who_it_fits: "associates", cost_band: "$15–20K", signature_moment: "the live brief", venue_direction: "a law-school moot courtroom", chosen: true },
      { title: "Boardroom", angle_on: "Black lawyers", angle_kind: "VENUE", format: "DINNER", premise: "…", tone: "serious", value_to_sponsor: "six minutes", who_it_fits: "partners", cost_band: "$22–28K", signature_moment: "…", venue_direction: "a Black-chef-led private dining room in Manhattan", chosen: true },
      { title: "Speed-venturing", angle_on: "Black lawyers", angle_kind: "NAME", format: "SALON", premise: "…", tone: "brisk", value_to_sponsor: "…", who_it_fits: "founders", cost_band: "$10–14K", signature_moment: "…", venue_direction: "…" },
    ], choice_rationale: "the war room wins", pushback: "the list cannot fill it" }), "Black lawyers")!;
    expect(out.topic).toBe("Black lawyers");
    expect(out.concepts.every((c) => c.angleOn === "Black lawyers")).toBe(true);
    expect(out.concepts.filter((c) => c.chosen).map((c) => c.title)).toEqual(["War Room"]);
    expect(out.choiceRationale).toBe("the war room wins");
    expect(venueSearchBrief(out.concepts[0]!, null, 40)).toContain("moot courtroom");
    expect(venueSearchBrief(null, { audience: "lawyers", month: "2026-10", city: null, sponsorProspects: [], notes: null })).toMatch(/private room or unusual space/);
  });

  it("returns null when no concept came back", () => {
    expect(parseConcepts("nope", "Black lawyers")).toBeNull();
    expect(parseConcepts(JSON.stringify({ concepts: [] }), "Black lawyers")).toBeNull();
  });

  /**
   * THREE SUBJECTS ARE REJECTED, NOT FLAGGED. The stage fails and the sweep retries it; nothing
   * carrying three subjects is ever stored, which is what item 2 asked for.
   */
  it("rejects an answer whose angles each declare a different subject", () => {
    const threeSubjects = JSON.stringify({ topic: "Black lawyers", concepts: [
      { title: "A", angle_on: "Black lawyers", format: "SALON", premise: "…" },
      { title: "B", angle_on: "Women founders", format: "SALON", premise: "…" },
      { title: "C", angle_on: "AI in the back office", format: "SALON", premise: "…" },
    ] });
    expect(parseConcepts(threeSubjects, null)).toBeNull();
    expect(parseConcepts(threeSubjects, "Black lawyers")).toBeNull();
  });

  it("rejects an answer that replaces a topic the partners set, however unanimous it is", () => {
    const replaced = JSON.stringify({ topic: "Something better", concepts: [
      { title: "A", angle_on: "Something better", format: "SALON", premise: "…" },
      { title: "B", angle_on: "Something better", format: "SALON", premise: "…" },
    ] });
    expect(parseConcepts(replaced, "Black lawyers")).toBeNull();
    // The same answer for a month nobody set is fine: that is Parker choosing.
    expect(parseConcepts(replaced, null)!.topic).toBe("Something better");
  });
});

describe("the packet prompt", () => {
  const base = { month: "2026-10", recentThemes: ["operator to founder"], venueCandidates: [{ name: "Gramercy Tavern", url: SOURCES[0]! }], city: "New York" };

  it("gives the model only the venues the search found, and tells it inventing wastes the slot", () => {
    const prompt = buildPacketPrompt(base);
    expect(prompt).toContain(SOURCES[0]);
    expect(prompt).toMatch(/copied EXACTLY/);
    expect(prompt).toMatch(/Null is a correct answer/);
    expect(prompt).toContain("operator to founder");
  });

  it("carries the chosen concept, the research and the invite check into the packet", () => {
    const prompt = buildPacketPrompt({ ...base, brief: { audience: "top Black lawyers", month: "2026-10", city: "New York", sponsorProspects: ["Harvey AI"], notes: null }, concepts: [{ title: "Boardroom", format: "DINNER", premise: "a serious table", tone: "", valueToSponsor: "", whoItFits: "", costBand: "$22K", signatureMoment: "the brief", venueDirection: "", chosen: true }], choiceRationale: "it wins", pushback: "widen the audience", sponsors: [HARVEY], inviteCheck: { totalContacts: 4712, matchingCount: 12, matchedOn: ["lawyers and legal roles"], archetypes: ["lawyer at Sullivan & Cromwell"], namedFromRecords: [], verdict: "STARTING_LIST", note: "a starting list" } });
    expect(prompt).toContain("THE CONCEPT YOU CHOSE");
    expect(prompt).toContain("Boardroom");
    expect(prompt).toContain("widen the audience");
    expect(prompt).toContain("sponsorship history: YES");
    expect(prompt).toContain("Mali Robertson");
    expect(prompt).toContain("the AI platform for elite law firms");
    expect(prompt).toContain("12 of 4712");
  });

  it("prices sponsorship from the keep, not from a per-sponsor law, and offers exclusivity", () => {
    const prompt = buildPacketPrompt(base);
    expect(prompt).toContain(`target $${SPONSORSHIP_TARGET.keepUsd.toLocaleString("en-US")} to West Peek`);
    expect(prompt).toMatch(/a target\s+with reasons, not a law/);
    expect(prompt).toMatch(/EXCLUSIVITY as an option/);
    expect(prompt).toMatch(/worth more than a fourth logo/);
    expect(prompt).not.toMatch(/up to\s+\$40,000/);
  });

  it("asks for the run of show to the minute with named roles, the sponsor's minutes, and the pitch in Sequoia's voice", () => {
    const prompt = buildPacketPrompt(base);
    expect(prompt).toMatch(/TO THE MINUTE/);
    expect(prompt).toMatch(/never more than 8 minutes/);
    expect(prompt).toMatch(/Chatham House/);
    expect(prompt).toMatch(/SEQUOIA TAYLOR's voice/);
    expect(prompt).toMatch(/nothing is sent/);
  });

  it("carries the memorable-experience mandate and refuses the default dinner", () => {
    const prompt = buildPacketPrompt(base);
    expect(prompt).toMatch(/Do NOT default to a seated dinner/);
    expect(prompt).toMatch(/signature moment/i);
  });

  it("says a sponsor thesis is never access to members", () => {
    expect(buildPacketPrompt(base)).toMatch(/Never access to members/);
  });

  it("handles a month where the search found nothing", () => {
    expect(buildPacketPrompt({ ...base, venueCandidates: [] })).toMatch(/none found/);
  });
});

describe("the invite-list reality check", () => {
  it("picks the vocabulary from the audience", () => {
    expect(audienceTerms("top Black lawyers on the rise").terms).toContain("attorney");
    expect(audienceTerms("founders who sold to PE").terms).toContain("founder");
    expect(audienceTerms("family offices").label).toMatch(/investors/);
    expect(audienceTerms("everyone").terms).toEqual([]);
  });

  it("the count is a starting list, never a veto: a thin match does not tell Parker to widen, co-host or push back", () => {
    // 16 Sep 2026: "only 6 of 4,712 contacts read as lawyers" became pushback on the October Room.
    // The community records under-read job functions and the partners' network is larger.
    for (const [matching, seats] of [[150, 40], [50, 40], [6, 40]] as const) {
      const v = inviteVerdict(matching, seats);
      expect(v.verdict).toBe("STARTING_LIST");
      expect(v.note).toMatch(/starting list, not a ceiling/);
      expect(v.note).toMatch(/do not widen the audience, decline, or push back/);
      expect(v.note).not.toMatch(/cannot fill/i);
    }
    const concepts = buildConceptsPrompt({ month: "2026-10", city: "New York", topic: "Black lawyers", setBy: "PARTNERS", steer: null, brief: { audience: "top Black lawyers", month: "2026-10", city: "New York", sponsorProspects: [], notes: null }, recentThemes: [], inviteCheck: { totalContacts: 4712, matchingCount: 6, matchedOn: ["lawyers and legal roles"], archetypes: [], namedFromRecords: [], verdict: "STARTING_LIST", note: inviteVerdict(6, 40).note }, sponsors: [] });
    expect(concepts).toMatch(/NOT a constraint on the Room/);
    expect(concepts).toMatch(/Never cite this count as a reason to widen the audience/);
  });
});

describe("the PDF", () => {
  const view: PacketView = {
    packetId: "rpk_1", title: "The Scaled Boardroom", theme: "Black lawyers and the founders who need them", centralQuestion: "What next?", month: "2026-10", format: "DINNER",
    targetMin: 30, targetMax: 40, audience: "senior associates", origin: "PARTNER_BRIEF",
    brief: { audience: "top Black lawyers", month: "2026-10", city: "New York", sponsorProspects: ["Harvey AI"], notes: null },
    pushback: "The list cannot fill it alone.",
    concepts: [
      { title: "Boardroom", format: "DINNER", premise: "a serious table", tone: "serious", valueToSponsor: "six minutes", whoItFits: "partners", costBand: "$25K", signatureMoment: "the brief", venueDirection: "…", chosen: true },
      { title: "War Room", format: "WORKSHOP", premise: "tool in hand", tone: "electric", valueToSponsor: "demo", whoItFits: "associates", costBand: "$18K", signatureMoment: "…", venueDirection: "…", chosen: false },
    ],
    conceptChoiceMd: "The boardroom wins.",
    runOfShow: [{ time: "6:30 PM", minutes: 30, what: "Arrival", who: "Sequoia Taylor (host)" }],
    agendaMd: null, seedQuestions: ["Who sponsored you?"], guestIdeas: [{ description: "a new partner", why: null }],
    venues: [{ name: "SAGA", city: "New York", address: "70 Pine St", capacity: 40, whyHere: "Charlie Mitchell, the first Black chef in NYC with a Michelin star", roomMinimumUsd: 5500, priceLowUsd: null, priceHighUsd: null, priceNote: null, estimateLowUsd: 9000, estimateHighUsd: 11000, estimateBasis: "comp", bookingPhone: null, bookingEmail: null, sourceUrl: "https://www.saga-nyc.com/private-events", isFallback: false }],
    sponsors: [{ rank: 1, orgName: "Harvey", category: "LEGAL", tier: "PRESENTING", askUsd: 20000, fitArgument: "their own words", pitch: "open", evidenceUrl: "https://www.harvey.ai/us-open", evidenceNote: "US Open", contactName: "Mali Robertson", contactTitle: "Director of Brand Partnerships", contactSourceUrl: "https://www.harvey.ai/team", note: null, fromBrief: true }],
    economics: computeEconomics({ venues: [], targetAttendees: 40, structure: defaultStructure() }),
    sponsorThesis: "the experience", risks: ["one"], commitmentMd: "spend",
    pitchEmail: { to: "Mali Robertson", subject: "A room", body: "Mali —\n\nHello." },
    inviteCheck: { totalContacts: 4712, matchingCount: 12, matchedOn: ["lawyers and legal roles"], archetypes: ["lawyer at a firm"], namedFromRecords: ["A Person"], verdict: "STARTING_LIST", note: "a starting list" },
    alsoLookedAt: ["Ghost Co"],
    generatedAt: "2026-09-15T12:00:00.000Z",
  };

  it("opens with Parker introducing himself, then the cover facts, every section, and the appendix", () => {
    const html = renderPacketHtml(view);
    for (const line of parkerIntroduction()) expect(html.replace(/&#39;/g, "'")).toContain(line.slice(0, 60));
    for (const heading of ["Three concepts, compared", "Run of show", "Who pays for it", "What it costs", "How the sponsorship is structured", "The pitch", "Appendix", "Can our own list fill it?", "Where I push back"]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("Mali Robertson");
    expect(html).toContain("harvey.ai/us-open");
    expect(html).toContain("Charlie Mitchell");
    expect(html).toContain("War Room"); // in the appendix
    expect(html).toContain("Also looked at, left out because the cited page did not answer when checked: Ghost Co");
    expect(html).toContain("<title>The Scaled Boardroom — Room packet</title>");
    // The family ground, ink and the canonical orange; nothing else.
    expect(html).toContain("#F7F2EA");
    expect(html).toContain("#F05A1A");
  });

  it("escapes what the model wrote", () => {
    const html = renderPacketHtml({ ...view, title: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("names the file for the month and the title", () => {
    expect(packetFilename(view)).toBe("west-peek-room-2026-10-the-scaled-boardroom.pdf");
  });
});

describe("monthKey", () => {
  it("buckets a date to the month the job checks", () => {
    expect(monthKey("2026-09-15T12:00:00Z")).toBe("2026-09");
  });
  it("proposes for the FOLLOWING month, so there is time to sell a sponsor", () => {
    expect(followingMonth("2026-09-15T12:00:00Z")).toBe("2026-10");
    expect(followingMonth("2026-12-03T12:00:00Z")).toBe("2027-01");
  });
});

describe("a contact is a person, and discovery names the sponsors, not the institutions (second production pass)", () => {
  it("drops a role offered as a contact — 'Partner Program Lead' is where a person looks, not somebody to write to", async () => {
    const { looksLikePersonName, parseSponsorResearch } = await import("../src/shared/events/roomPacket");
    expect(looksLikePersonName("Mali Robertson")).toBe(true);
    expect(looksLikePersonName("Rachel Hepworth")).toBe(true);
    expect(looksLikePersonName("Jean-Luc de la Cruz")).toBe(true);
    expect(looksLikePersonName("Partner Program Lead")).toBe(false);
    expect(looksLikePersonName("Head of Brand Partnerships")).toBe(false);
    expect(looksLikePersonName("Harvey Partnerships Team")).toBe(false);
    expect(looksLikePersonName("mali")).toBe(false);
    expect(looksLikePersonName("press@harvey.ai")).toBe(false);
    const r = parseSponsorResearch(JSON.stringify({ history: [], contacts: [{ name: "Partner Program Lead", title: "—", source_url: "https://www.harvey.ai/partners" }, { name: "Mali Robertson", title: "Director of Brand Partnerships", source_url: "https://www.harvey.ai/team" }], strategic_language: [], summary: "" }));
    expect(r.contacts.map((c) => c.name)).toEqual(["Mali Robertson"]);
  });

  it("tells discovery that the associations are the answer key and to return the companies on their sponsor pages, with a category floor", () => {
    const prompt = buildSponsorDiscoveryPrompt({ brief: { audience: "Black lawyers", month: "2026-10", city: "New York", sponsorProspects: [], notes: null }, city: "New York", month: "2026-10" });
    expect(prompt).toMatch(/NAME THE SPONSORS, NOT THE INSTITUTIONS/);
    expect(prompt).toMatch(/COMPANIES listed on them/);
    expect(prompt).toMatch(/one BANKING/);
    expect(prompt).toMatch(/no more than\s+two firms/);
  });
});

describe("the money, after the first production packet", () => {
  it("raises an exclusive priced below the cash slots, and says so", () => {
    const p = parsePacket(packetJson({ sponsorship: { slots: [{ tier: "TITLE", count: 1, ask_usd: 24000, gets: "" }, { tier: "SUPPORTING", count: 2, ask_usd: 12000, gets: "" }], exclusive_usd: 42000, rationale: "three slots" } }))!;
    expect(p.structure.exclusiveUsd).toBe(53000);
    expect(p.structure.rationale).toMatch(/Exclusive raised to \$53,000/);
  });

  it("counts in-kind as a cost offset, never as cash toward the keep", () => {
    const structure = { slots: [{ tier: "PRESENTING" as const, count: 1, askUsd: 24000, gets: "" }, { tier: "IN_KIND" as const, count: 1, askUsd: 4000, gets: "" }], exclusiveUsd: null, exclusiveGets: null, rationale: "" };
    const e = computeEconomics({ venues: [], targetAttendees: 35, structure, budgetLines: [] });
    expect(e.sponsorTargetHighUsd).toBe(24000);
    expect(e.scenarios[1]!.sponsorshipUsd).toBe(24000);
    expect(e.scenarios[1]!.description).toBe("1 title + 1 in-kind (offsets $4,000 of cost)");
    expect(e.scenarios[1]!.netHighUsd).toBe(24000 + 4000 - e.estimatedCostLowUsd);
  });

  it("tells the packet that the audience's institutions are co-hosts, not cash sponsors, and the pitch goes to a person", () => {
    const prompt = buildPacketPrompt({ month: "2026-10", recentThemes: [], venueCandidates: [], city: "New York" });
    expect(prompt).toMatch(/INSTITUTIONS ARE NOT CASH SPONSORS/);
    expect(prompt).toMatch(/holds the invite list/);
    expect(prompt).toMatch(/rank-1 CASH prospect's named contact/);
  });

  it("flows a long section onto the next sheet instead of leaving a blank one", () => {
    const html = renderPacketHtml({ packetId: "x", title: "T", theme: "t", centralQuestion: null, month: "2026-10", format: "SALON", targetMin: 30, targetMax: 40, audience: null, origin: "PARKER", brief: null, pushback: null, concepts: [], conceptChoiceMd: null, runOfShow: [], agendaMd: null, seedQuestions: [], guestIdeas: [], venues: [], sponsors: [], economics: null, sponsorThesis: null, risks: [], commitmentMd: null, pitchEmail: null, inviteCheck: null, alsoLookedAt: [], generatedAt: "2026-09-15T00:00:00Z" });
    expect(html).toMatch(/\.page\.cover\{min-height:11in\}/);
    expect(html).not.toMatch(/\.page\{[^}]*min-height:11in/);
    expect(html).toMatch(/break-inside:avoid/);
  });
});

describe("discovery, after the third production run", () => {
  const brief = { audience: "Black lawyers", month: "2026-10", city: "New York", sponsorProspects: ["Harvey AI"], notes: null };
  const list = (n: number, page: string, cat = "LEGAL") => Array.from({ length: n }, (_, i) => ({ org_name: `Org ${page.slice(-1)}${i}`, category: cat, evidence_url: page, evidence_note: `Listed as a sponsor on ${page}` }));

  it("caps what one sponsor page may contribute, and a 'not evidenced' note has no evidence", async () => {
    const { CANDIDATES_PER_PAGE, parseSponsorCandidates } = await import("../src/shared/events/roomPacket");
    const out = parseSponsorCandidates(JSON.stringify({ results: [
      ...list(9, "https://www.napaba.org/page/2026_SponsorList"),
      { org_name: "Major Lindsey & Africa", category: "RECRUITING", evidence_url: "https://www.napaba.org/page/2026_SponsorList", evidence_note: "Not evidenced in the gathered search results; no qualifying sponsor-page URL was returned" },
      { org_name: "Harvey", category: "LEGAL", evidence_url: "https://www.napaba.org/page/2026_SponsorList", evidence_note: "No sponsor-page evidence was returned for Harvey" },
    ] }), brief);
    expect(out.filter((c) => c.evidenceUrl.includes("napaba"))).toHaveLength(CANDIDATES_PER_PAGE);
    expect(out.some((c) => c.orgName.startsWith("Major"))).toBe(false);
    expect(out.some((c) => c.orgName === "Harvey")).toBe(false); // the seed comes back in DISCOVER with no evidence, researched on its own
  });

  it("merges a second pass without repeats and picks research round-robin by category, hers first", async () => {
    const { mergeCandidates, parseSponsorCandidates, pickForResearch } = await import("../src/shared/events/roomPacket");
    const first = parseSponsorCandidates(JSON.stringify({ results: [...list(4, "https://a.org/sponsors"), { org_name: "Harvey", category: "LEGAL", evidence_url: "https://www.harvey.ai/us-open", evidence_note: "US Open partner" }] }), brief);
    const second = parseSponsorCandidates(JSON.stringify({ results: [
      { org_name: "Org s0", category: "LEGAL", evidence_url: "https://b.org/sponsors", evidence_note: "listed" }, // repeat
      { org_name: "J.P. Morgan", category: "BANKING", evidence_url: "https://b.org/sponsors", evidence_note: "listed" },
      { org_name: "Lateral Link", category: "RECRUITING", evidence_url: "https://b.org/sponsors", evidence_note: "listed" },
      { org_name: "Macallan", category: "HOSPITALITY", evidence_url: "https://c.org/sponsors", evidence_note: "listed" },
    ] }), brief);
    const merged = mergeCandidates(first, second);
    expect(merged.map((c) => c.orgName)).toEqual(["Harvey", "Org s0", "Org s1", "Org s2", "Org s3", "J.P. Morgan", "Lateral Link", "Macallan"]);
    const picked = pickForResearch(merged, 6);
    expect(picked[0]!.orgName).toBe("Harvey");
    expect(new Set(picked.map((c) => c.category))).toEqual(new Set(["LEGAL", "BANKING", "RECRUITING", "HOSPITALITY"]));
    expect(picked).toHaveLength(6);
  });

  it("tells the second search what it already has and not to cite those hosts again", async () => {
    const { buildSponsorDiscoveryMorePrompt, parseSponsorCandidates } = await import("../src/shared/events/roomPacket");
    const already = parseSponsorCandidates(JSON.stringify({ results: list(3, "https://www.napaba.org/page/2026_SponsorList") }), brief);
    const prompt = buildSponsorDiscoveryMorePrompt({ brief, city: "New York", month: "2026-10", already });
    expect(prompt).toMatch(/SECOND PASS/);
    expect(prompt).toContain("do NOT cite these hosts again): www.napaba.org");
    expect(prompt).toMatch(/Lavender Law/);
    expect(prompt).toMatch(/BANKING, RECRUITING/);
  });
});

describe("venue intent, after the third production run", () => {
  it("makes the first-choice venue carry the audience's identity, in both prompts", () => {
    const concepts = buildConceptsPrompt({ month: "2026-10", city: "New York", topic: "Black lawyers", setBy: "PARTNERS", steer: null, brief: null, recentThemes: [], inviteCheck: null, sponsors: [] });
    expect(concepts).toMatch(/AUDIENCE IS DEFINED BY WHO THEY ARE/);
    expect(concepts).toMatch(/Schomburg Center/);
    const packet = buildPacketPrompt({ month: "2026-10", recentThemes: [], venueCandidates: [], city: "New York" });
    expect(packet).toMatch(/FIRST-CHOICE venue carries that identity/);
  });
});
