import { describe, expect, it } from "vitest";
import {
  BUDGET_KEYS,
  SPONSORSHIP_RULE,
  buildPacketPrompt,
  computeEconomics,
  estimateVenueCost,
  followingMonth,
  mergeBriefSponsors,
  monthKey,
  parsePacket,
  type PacketVenue,
  verifyPacket,
} from "../src/shared/events/roomPacket";

const SOURCES = [
  "https://www.gramercytavern.com/private-dining",
  "https://bluehillfarm.com/events",
];

function packetJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "The Zero-to-One Room",
    theme: "operator to founder",
    central_question: "What actually changes when an operator becomes a founder?",
    format: "DINNER",
    target_min: 25,
    target_max: 35,
    audience: "operators, first-time founders, startup lawyers",
    agenda_md: "## 6:30 arrivals",
    seed_questions: [
      "When is an idea worth leaving your job for?",
      "How do you test demand without publicly launching?",
      "How should you choose a cofounder?",
    ],
    guest_ideas: [{ description: "a founder 18 months post-departure", why: "lived the leap" }],
    venues: [
      {
        name: "Gramercy Tavern",
        city: "New York",
        address: "42 E 20th St",
        capacity: 40,
        price_low_usd: 6000,
        price_high_usd: 9000,
        price_note: "private dining minimum",
        booking_phone: "+1 212 477 0777",
        booking_email: null,
        booking_url: "https://www.gramercytavern.com/private-dining",
        source_url: "https://www.gramercytavern.com/private-dining",
      },
    ],
    sponsor_thesis: "Underwrite the moment operators become founders.",
    ...over,
  });
}

describe("parsing a packet", () => {
  it("reads a well-formed proposal", () => {
    const p = parsePacket(packetJson())!;
    expect(p.title).toBe("The Zero-to-One Room");
    expect(p.format).toBe("DINNER");
    expect(p.venues).toHaveLength(1);
    expect(p.seedQuestions).toHaveLength(3);
  });

  it("reads it out of a fenced block, which is how models actually answer", () => {
    expect(parsePacket("Here you go:\n```json\n" + packetJson() + "\n```")?.title)
      .toBe("The Zero-to-One Room");
  });

  it("drops a venue with no source rather than showing it with a caveat", () => {
    const raw = packetJson({
      venues: [
        { name: "Somewhere Lovely", price_low_usd: 5000, booking_phone: "+1 212 555 0100" },
        JSON.parse(packetJson()).venues[0],
      ],
    });
    const p = parsePacket(raw)!;
    expect(p.venues.map((v) => v.name)).toEqual(["Gramercy Tavern"]);
  });

  it("never accepts a person_id from the model", () => {
    // It cannot know our ids, so anything it offers attaches a real member to an invented reason.
    const raw = packetJson({
      guest_ideas: [{ description: "a technical cofounder", person_id: "per_ada", why: "seems right" }],
    });
    expect(parsePacket(raw)!.guestIdeas[0]!.personId).toBeNull();
  });

  it("falls back to DINNER for a format that is not in the schema", () => {
    expect(parsePacket(packetJson({ format: "BANQUET" }))!.format).toBe("DINNER");
  });

  it("returns null for unparseable output instead of a half-built packet", () => {
    expect(parsePacket("I could not find any venues, sorry.")).toBeNull();
    expect(parsePacket(packetJson({ title: "" }))).toBeNull();
  });
});

describe("verification against what the search actually returned", () => {
  it("drops a venue whose source the search never returned", () => {
    // The exact failure mode: a real-looking citation the model made up. Worse than no citation,
    // because a reader sees a URL and assumes someone checked.
    const p = parsePacket(
      packetJson({
        venues: [
          {
            ...JSON.parse(packetJson()).venues[0],
            name: "The Invented Room",
            source_url: "https://theinventedroom.com/private-events",
          },
        ],
      }),
    )!;

    const { packet, flags } = verifyPacket(p, SOURCES);
    expect(packet.venues).toHaveLength(0);
    expect(flags.map((f) => f.code)).toContain("invented_url");
    expect(flags.find((f) => f.code === "invented_url")?.detail).toMatch(/The Invented Room/);
  });

  it("keeps a venue the search did return, ignoring trailing-slash and case noise", () => {
    const p = parsePacket(
      packetJson({
        venues: [
          { ...JSON.parse(packetJson()).venues[0], source_url: "https://WWW.GramercyTavern.com/private-dining/" },
        ],
      }),
    )!;
    expect(verifyPacket(p, SOURCES).packet.venues).toHaveLength(1);
  });

  it("says so loudly when nothing survived, so a thin packet is not mistaken for a thin market", () => {
    const p = parsePacket(packetJson({ venues: [] }))!;
    const { flags } = verifyPacket(p, SOURCES);
    expect(flags.map((f) => f.code)).toContain("no_venues");
  });

  it("flags contact details as unverified rather than dropping a usable number", () => {
    const p = parsePacket(
      packetJson({
        venues: [{ ...JSON.parse(packetJson()).venues[0], booking_url: null }],
      }),
    )!;
    const { packet, flags } = verifyPacket(p, SOURCES);
    expect(packet.venues).toHaveLength(1);
    expect(flags.find((f) => f.code === "contact_without_source")?.detail).toMatch(/UNVERIFIED/);
  });

  it("does not drop everything when no search ran", () => {
    // An empty allow-list means live search was unavailable, not that every venue is invented.
    const p = parsePacket(packetJson())!;
    expect(verifyPacket(p, []).packet.venues).toHaveLength(1);
  });

  it("flags a room too thin or too big to be a conversation", () => {
    const p = parsePacket(packetJson({ target_min: 100, target_max: 400 }))!;
    expect(verifyPacket(p, SOURCES).flags.map((f) => f.code)).toContain("target_out_of_range");
  });

  it("flags a missing sponsor thesis, because a Room with no funding story is not proposable", () => {
    const p = parsePacket(packetJson({ sponsor_thesis: null }))!;
    expect(verifyPacket(p, SOURCES).flags.map((f) => f.code)).toContain("no_sponsor_thesis");
  });
});

describe("economics", () => {
  const venue = (low: number, high: number): PacketVenue => ({
    name: `v${low}`, city: null, address: null, capacity: null,
    priceLowUsd: low, priceHighUsd: high, priceNote: null,
    bookingPhone: null, bookingEmail: null, bookingUrl: null,
    sourceUrl: "https://example.com/x",
    estimateLowUsd: low, estimateHighUsd: high, estimateBasis: "the price stated on the cited page",
  });

  it("spans the cheapest and the dearest venue estimate, and totals a full budget with contingency", () => {
    const e = computeEconomics({ venues: [venue(6000, 9000), venue(3000, 4000)], targetAttendees: 30 });
    expect(e.venueLowUsd).toBe(3000);
    expect(e.venueHighUsd).toBe(9000);
    // Every category is a line, each with a basis, and the total is the lines plus 10%.
    expect(e.lines.map((l) => l.key)).toEqual([...BUDGET_KEYS]);
    expect(e.lines.every((l) => l.basis.length > 0)).toBe(true);
    const sub = e.lines.filter((l) => l.key !== "contingency").reduce((t, l) => t + l.lowUsd, 0);
    expect(e.estimatedCostLowUsd).toBe(Math.round(sub * 1.1));
    expect(e.estimatedCostLowUsd).toBeGreaterThan(3000 + 3600);
  });

  it("uses Parker's own line where he wrote one, and says which lines are rules of thumb", () => {
    const e = computeEconomics({
      venues: [venue(6000, 9000)], targetAttendees: 30,
      budgetLines: [{ key: "photo_video", lowUsd: 1200, highUsd: 1200, basis: "quote from the photographer we used in May" }],
    });
    expect(e.lines.find((l) => l.key === "photo_video")).toMatchObject({ lowUsd: 1200, highUsd: 1200, basis: "quote from the photographer we used in May" });
    expect(e.lines.find((l) => l.key === "staffing")!.basis).toMatch(/rule of thumb/);
  });

  it("shows what is left at two sponsors and at four — the partner's real question", () => {
    const e = computeEconomics({ venues: [venue(6000, 9000)], targetAttendees: 30, sponsorCount: 3 });
    expect(e.scenarios.map((s) => s.sponsors)).toEqual([1, 2, 3, 4]);
    const four = e.scenarios.find((s) => s.sponsors === 4)!;
    expect(four.sponsorshipUsd).toBe(40_000);
    expect(four.netHighUsd).toBe(40_000 - e.estimatedCostLowUsd);
  });

  it("never prices a venue at $0: a page price, then Parker's comp, then the room-size rule of thumb", () => {
    const priced = estimateVenueCost({ priceLow: 6000, priceHigh: 9000, estLow: null, estHigh: null, basis: null, city: "New York", capacity: 40 });
    expect(priced).toEqual({ low: 6000, high: 9000, basis: "the price stated on the cited page" });
    const comped = estimateVenueCost({ priceLow: null, priceHigh: null, estLow: 4000, estHigh: 8000, basis: "gallery buy-out, weeknight", city: null, capacity: null });
    expect(comped).toEqual({ low: 4000, high: 8000, basis: "gallery buy-out, weeknight" });
    const blank = estimateVenueCost({ priceLow: null, priceHigh: null, estLow: null, estHigh: null, basis: null, city: "Austin", capacity: 30 });
    expect(blank.low).toBe(150 * 30);
    expect(blank.high).toBe(250 * 30);
    expect(blank.basis).toMatch(/rule of thumb: private room for 30 in Austin/);
    // And the parser applies it: a venue with no price on its page still carries an estimate.
    const p = parsePacket(packetJson({ venues: [{ name: "Somewhere", city: "Austin", capacity: 30, source_url: SOURCES[0] }] }))!;
    expect(p.venues[0]!.estimateLowUsd).toBe(4500);
    expect(p.venues[0]!.estimateBasis).toMatch(/no price on the cited page/);
  });

  it("reads Parker's budget lines and drops an unknown key or a repeated one", () => {
    const p = parsePacket(packetJson({ budget: [
      { key: "venue", low_usd: 5000, high_usd: 8000, basis: "quoted minimum" },
      { key: "venue", low_usd: 1, high_usd: 2, basis: "dup" },
      { key: "balloons", low_usd: 9, high_usd: 9 },
    ] }))!;
    expect(p.budgetLines).toEqual([{ key: "venue", lowUsd: 5000, highUsd: 8000, basis: "quoted minimum" }]);
  });

  it("prices sponsorship by the operator's rule: $10k a sponsor, up to four, $40k a Room", () => {
    // "$10,000 to us per sponsor; aim for up to $40K in sponsorships per room — ideally 4 sponsors
    // or whichever number makes sense based on the logistics." (15 Sep 2026)
    const e = computeEconomics({ venues: [venue(6000, 9000)], targetAttendees: 30 });
    expect(e.sponsorCount).toBe(SPONSORSHIP_RULE.idealSponsors);
    expect(e.sponsorTargetLowUsd).toBe(10_000);
    expect(e.sponsorTargetHighUsd).toBe(40_000);
  });

  it("carries the number of sponsors Parker says the format supports, clamped to the rule", () => {
    expect(computeEconomics({ venues: [], targetAttendees: 25, sponsorCount: 2 }).sponsorTargetHighUsd).toBe(20_000);
    expect(computeEconomics({ venues: [], targetAttendees: 25, sponsorCount: 9 }).sponsorCount).toBe(SPONSORSHIP_RULE.maxSponsors);
    expect(computeEconomics({ venues: [], targetAttendees: 25, sponsorCount: 0 }).sponsorCount).toBe(1);
  });

  it("shows a negative net rather than smoothing it", () => {
    const e = computeEconomics({ venues: [venue(40_000, 50_000)], targetAttendees: 35, sponsorCount: 1 });
    expect(e.netLowUsd).toBeLessThan(0);
  });

  it("handles a Room with no venue at all by costing the venue line on the rule of thumb", () => {
    const e = computeEconomics({ venues: [], targetAttendees: 25 });
    expect(e.venueLowUsd).toBe(0);
    expect(e.lines.find((l) => l.key === "venue")).toMatchObject({ lowUsd: 150 * 25, highUsd: 250 * 25 });
    expect(e.lines.find((l) => l.key === "venue")!.basis).toMatch(/no venue was priced/);
  });
});

describe("the prompt", () => {
  const prompt = buildPacketPrompt({
    month: "2027-03",
    recentThemes: ["AI Builders", "Capital Strategy"],
    venueCandidates: [{ name: "Gramercy Tavern", url: SOURCES[0]! }],
    city: "New York",
  });

  it("gives the model only the venues the search found", () => {
    expect(prompt).toContain("Gramercy Tavern");
    expect(prompt).toContain(SOURCES[0]);
  });

  it("tells it that inventing wastes the slot rather than filling it", () => {
    // Framing matters: "do not invent" alone still gets invented answers when the model would
    // rather return something than nothing.
    expect(prompt).toMatch(/dropped from the packet, so inventing one wastes the slot/);
  });

  it("steers away from themes already used", () => {
    expect(prompt).toContain("AI Builders");
    expect(prompt).toMatch(/propose something different/);
  });

  it("says null is a correct answer for a contact it cannot source", () => {
    expect(prompt).toMatch(/Null is a\n  correct answer/);
  });

  it("asks for a sponsor thesis that is never access to members", () => {
    expect(prompt).toMatch(/Never access to members/);
  });

  it("carries the memorable-experience mandate and refuses the default dinner", () => {
    // Operator, 15 Sep 2026: "not only suggest 'dinners in nyc'… unique venues and runs of show that
    // make for memorable experiences that keep people talking for months and years."
    expect(prompt).toContain("Do NOT default to a seated dinner in New York");
    expect(prompt).toMatch(/after-hours museum/);
    expect(prompt).toMatch(/ONE signature moment/);
    expect(prompt).toMatch(/No venue is \$0/);
    expect(prompt).toContain("budget: a full budget");
  });

  it("handles a month where the search found nothing", () => {
    const empty = buildPacketPrompt({ month: "2027-04", recentThemes: [], venueCandidates: [], city: "Austin" });
    expect(empty).toMatch(/return an empty venues array rather than inventing any/);
  });
});

describe("monthKey", () => {
  it("buckets a date to the month the job checks", () => {
    expect(monthKey("2027-03-11T18:00:00.000Z")).toBe("2027-03");
  });

  it("proposes for the FOLLOWING month, so there is time to sell a sponsor", () => {
    expect(followingMonth("2026-09-15T12:00:00.000Z")).toBe("2026-10");
    expect(followingMonth("2026-12-03T12:00:00.000Z")).toBe("2027-01");
  });
});

describe("a Room the partner asked for (15 Sep 2026)", () => {
  const brief = {
    audience: "top Black lawyers on the rise",
    month: "2026-10",
    city: "New York",
    sponsorProspects: ["Harvey AI (harvey.ai)"],
    notes: "keep it to one legal sponsor",
  };

  it("puts her brief in front of Parker before anything else about the Room", () => {
    const prompt = buildPacketPrompt({ month: "2026-10", recentThemes: [], venueCandidates: [], city: "New York", brief });
    expect(prompt).toContain("THE PARTNER ASKED FOR THIS ROOM");
    expect(prompt).toContain("top Black lawyers on the rise");
    expect(prompt).toMatch(/use these FIRST/);
    expect(prompt).toContain("Harvey AI (harvey.ai)");
    expect(prompt).toContain("keep it to one legal sponsor");
    // Her brief precedes the venue list: it is the Room, the venues are where it happens.
    expect(prompt.indexOf("THE PARTNER ASKED FOR THIS ROOM")).toBeLessThan(prompt.indexOf("VENUE CANDIDATES"));
  });

  it("states the sponsorship rule in the prompt, in dollars", () => {
    const prompt = buildPacketPrompt({ month: "2026-10", recentThemes: [], venueCandidates: [], city: "New York" });
    expect(prompt).toContain("$10,000");
    expect(prompt).toContain("$40,000");
    expect(prompt).toMatch(/sponsor_count/);
    expect(prompt).toMatch(/example PROFILE/);
    expect(prompt).toMatch(/commitment_md/);
  });

  it("reads sponsor prospects, risks, the commitment and the sponsor count", () => {
    const p = parsePacket(packetJson({
      sponsor_count: 3,
      sponsor_prospects: [
        { org_name: "Harvey", category: "LEGAL", ask_usd: 10000, why_fit: "legal AI for the exact audience", pitch: "Be in the room", source_url: "https://www.harvey.ai/" },
        { org_name: "Somebody", category: "NOT_A_CATEGORY" },
      ],
      risks: ["The date collides with a bar association dinner"],
      commitment_md: "Roughly $9k of venue and food, Parker's time for six weeks, and Harvey approached in West Peek's name.",
    }))!;
    expect(p.sponsorCount).toBe(3);
    expect(p.sponsorProspects).toHaveLength(2);
    expect(p.sponsorProspects[1]!.category).toBe("OTHER");
    expect(p.sponsorProspects[1]!.askUsd).toBe(SPONSORSHIP_RULE.perSponsorUsd);
    expect(p.risks).toEqual(["The date collides with a bar association dinner"]);
    expect(p.commitmentMd).toMatch(/Harvey approached/);
  });

  it("clamps a sponsor count the format cannot carry", () => {
    expect(parsePacket(packetJson({ sponsor_count: 7 }))!.sponsorCount).toBe(SPONSORSHIP_RULE.maxSponsors);
    expect(parsePacket(packetJson({ sponsor_count: 0 }))!.sponsorCount).toBe(1);
  });

  it("never loses a prospect she named, and puts hers first", () => {
    const parsed = parsePacket(packetJson({
      sponsor_prospects: [{ org_name: "Carta", category: "EQUITY_CAPTABLE", ask_usd: 10000 }],
    }))!;
    const merged = mergeBriefSponsors(parsed, brief);
    expect(merged.sponsorProspects.map((s) => s.orgName)).toEqual(["Harvey AI (harvey.ai)", "Carta"]);
    expect(merged.sponsorProspects[0]!.fromBrief).toBe(true);
    expect(merged.sponsorProspects[0]!.whyFit).toBeNull();
  });

  it("recognises her prospect when Parker wrote it under a slightly different name", () => {
    const parsed = parsePacket(packetJson({
      sponsor_prospects: [{ org_name: "Harvey", category: "LEGAL", ask_usd: 10000, why_fit: "fits" }],
    }))!;
    const merged = mergeBriefSponsors(parsed, brief);
    expect(merged.sponsorProspects).toHaveLength(1);
    expect(merged.sponsorProspects[0]!.fromBrief).toBe(true);
    expect(merged.sponsorProspects[0]!.whyFit).toBe("fits");
  });

  it("keeps a sponsor whose citation the search never returned, but strips the citation", () => {
    const parsed = parsePacket(packetJson({
      sponsor_prospects: [{ org_name: "Harvey", category: "LEGAL", source_url: "https://invented.example/harvey" }],
    }))!;
    const { packet, flags } = verifyPacket(parsed, SOURCES);
    expect(packet.sponsorProspects[0]!.sourceUrl).toBeNull();
    expect(flags.some((f) => f.code === "invented_url" && f.detail.includes("prospect kept"))).toBe(true);
  });

  it("flags a packet with nobody to approach for the money", () => {
    const { flags } = verifyPacket(parsePacket(packetJson())!, SOURCES);
    expect(flags.some((f) => f.code === "no_sponsor_prospects")).toBe(true);
  });
});
