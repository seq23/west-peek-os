import { describe, expect, it } from "vitest";
import {
  buildPacketPrompt,
  computeEconomics,
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
  });

  it("spans the cheapest and the dearest sourced venue", () => {
    const e = computeEconomics({ venues: [venue(6000, 9000), venue(3000, 4000)], targetAttendees: 30 });
    expect(e.venueLowUsd).toBe(3000);
    expect(e.venueHighUsd).toBe(9000);
    // 30 × $120 food, plus venue.
    expect(e.estimatedCostLowUsd).toBe(3000 + 3600);
    expect(e.estimatedCostHighUsd).toBe(9000 + 3600);
  });

  it("targets the pilot's $30–45k with a presenting and a supporting partner", () => {
    const e = computeEconomics({ venues: [venue(6000, 9000)], targetAttendees: 30 });
    expect(e.sponsorTargetLowUsd).toBe(27_500);
    expect(e.sponsorTargetHighUsd).toBe(37_500);
  });

  it("shows a negative net rather than smoothing it", () => {
    const e = computeEconomics({ venues: [venue(40_000, 50_000)], targetAttendees: 35, tiers: ["SUPPORTING"] });
    expect(e.netLowUsd).toBeLessThan(0);
  });

  it("handles a Room with no priced venue without dividing by zero", () => {
    const e = computeEconomics({ venues: [], targetAttendees: 25 });
    expect(e.venueLowUsd).toBe(0);
    expect(e.estimatedCostHighUsd).toBe(3000);
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

  it("handles a month where the search found nothing", () => {
    const empty = buildPacketPrompt({ month: "2027-04", recentThemes: [], venueCandidates: [], city: "Austin" });
    expect(empty).toMatch(/return an empty venues array rather than inventing any/);
  });
});

describe("monthKey", () => {
  it("buckets a date to the month the job checks", () => {
    expect(monthKey("2027-03-11T18:00:00.000Z")).toBe("2027-03");
  });
});
