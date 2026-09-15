import { personaPrompt } from "../registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";
/**
 * The Room packet — Parker's monthly proposal (docs/COMMUNITY.md).
 *
 * THE BAR. The operator's requirement is that a packet arrives with the ideal location, pricing,
 * booking phone numbers and emails, guest ideas and topics laid out "so all the humans have to do
 * is execute". That is a high bar, and it is the bar that makes the sourcing rules below
 * non-negotiable rather than fussy.
 *
 * THE FAILURE THIS MODULE EXISTS TO PREVENT. Ask a model for a restaurant's private-dining number
 * and it will give you one. It will be correctly formatted, plausible for the city, and wrong. The
 * first time a Managing Partner dials a dead line, the packet stops being a thing anyone opens —
 * and unlike a wrong figure on a market map, nobody discovers this at a desk. They discover it
 * while trying to book a room for thirty people.
 *
 * So the discipline is the one already used for market mapping and daily intelligence, applied
 * harder:
 *
 *   1. A venue with no source URL is DROPPED, not shown with a caveat.
 *   2. A source URL the live search did not actually return is an INVENTED URL and the venue is
 *      dropped. A citation the model made up is worse than no citation, because it looks checked.
 *   3. Everything that survives is UNVERIFIED until a person has called. The packet says so.
 *
 * Pure and I/O-free, so all of it is testable without a network or a model.
 */

export const PACKET_PROMPT_VERSION = "room-packet/2";

/**
 * What the partner typed when she asked for a Room herself (15 Sep 2026).
 *
 * Operator: "basically the 'ask parker for a room' flow needs to change where i can input what im
 * thinking and he use my initial suggestions… i like that he can think of a room on demand but i
 * need to be able to do that OR ask for a specific type of room." Two doors, one packet queue: a
 * packet records which door it came through (`origin`) and carries this brief so the page can show
 * what was asked for next to what Parker made of it.
 */
export interface RoomBrief {
  /** Audience or theme, free text. "top Black lawyers on the rise". */
  audience: string;
  /** YYYY-MM. */
  month: string;
  city: string | null;
  /** Sponsor prospects she named. Used FIRST; each becomes an evt_sponsor_prospect row. */
  sponsorProspects: string[];
  notes: string | null;
}

export type PacketOrigin = "PARKER" | "PARTNER_BRIEF";

/**
 * A sponsor prospect as Parker proposes it. `sourceUrl` is kept only if the live search actually
 * returned it — the same rule as venues, applied to the money.
 */
export interface SponsorProspectIdea {
  orgName: string;
  /** Must be one of evt_sponsor_prospect.category's CHECK values; anything else becomes OTHER. */
  category: SponsorCategory;
  askUsd: number;
  /** Why this organisation fits THIS room. */
  whyFit: string | null;
  /** The one-line pitch angle to open with. */
  pitch: string | null;
  sourceUrl: string | null;
  /** True when the partner named them in her brief rather than Parker finding them. */
  fromBrief: boolean;
}

/** Must stay in step with the `category` CHECK in migration 0044. */
export const SPONSOR_CATEGORIES = [
  "CLOUD", "FINTECH_SPEND", "EQUITY_CAPTABLE", "LEGAL", "PAYROLL_HR", "BANKING", "HOSPITALITY", "RECRUITING", "OTHER",
] as const;
export type SponsorCategory = (typeof SPONSOR_CATEGORIES)[number];

/**
 * THE SPONSORSHIP RULE, in the operator's words (15 Sep 2026): "$10,000 to us per sponsor; aim for
 * up to $40K in sponsorships per room — ideally 4 sponsors or whichever number makes sense based
 * on the logistics." Parker states how many sponsors the format honestly carries; the money is
 * that count times the per-sponsor figure, never a tier table.
 */
export const SPONSORSHIP_RULE = {
  perSponsorUsd: 10_000,
  idealSponsors: 4,
  maxSponsors: 4,
  roomTargetUsd: 40_000,
} as const;

/** Must stay in step with the `format` CHECK in migration 0044. */
export const ROOM_FORMATS = [
  "DINNER", "SALON", "WORKSHOP", "ROUNDTABLE", "DEEP_WORK", "EXCURSION", "VIRTUAL", "HYBRID",
] as const;

export type RoomFormat = (typeof ROOM_FORMATS)[number];

export interface PacketVenue {
  name: string;
  city: string | null;
  address: string | null;
  capacity: number | null;
  priceLowUsd: number | null;
  priceHighUsd: number | null;
  priceNote: string | null;
  bookingPhone: string | null;
  bookingEmail: string | null;
  bookingUrl: string | null;
  /** Required. Where every fact above came from. */
  sourceUrl: string;
  /**
   * An educated estimate of what this venue costs for this Room, ALWAYS present. Operator: "no
   * venue is truly $0 and best guesses using comps should be used." Where the cited page states a
   * price, the estimate is that price; otherwise it is a comparable, and `estimateBasis` says which.
   */
  estimateLowUsd: number;
  estimateHighUsd: number;
  estimateBasis: string;
}

export interface GuestIdea {
  /** A description of the kind of person, or a named person if one is in the graph. */
  description: string;
  /** Set only when this resolves to a real record. Never invented. */
  personId: string | null;
  why: string | null;
}

/** One line of the budget, as a senior event designer would lay it out. */
export interface BudgetLine {
  key: BudgetKey;
  label: string;
  lowUsd: number;
  highUsd: number;
  /** Where the number comes from — a comp, a per-head rate, a published minimum, a rule of thumb. */
  basis: string;
}

export const BUDGET_KEYS = [
  "venue", "food_beverage", "av_production", "entertainment_programming", "speakers_hosts",
  "design_print_decor", "photo_video", "staffing", "travel_accommodation", "insurance_permits", "contingency",
] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

export const BUDGET_LABELS: Readonly<Record<BudgetKey, string>> = {
  venue: "Venue hire or minimum",
  food_beverage: "Food and beverage",
  av_production: "AV and production",
  entertainment_programming: "Entertainment and programming",
  speakers_hosts: "Speaker or host fees and gifts",
  design_print_decor: "Design, print and decor",
  photo_video: "Photography and video",
  staffing: "Staffing on the night",
  travel_accommodation: "Travel and accommodation",
  insurance_permits: "Insurance and permits",
  contingency: "Contingency (10%)",
};

/** What is left at N sponsors, so a partner sees the Room at two sponsors and at four. */
export interface SponsorScenario {
  sponsors: number;
  sponsorshipUsd: number;
  netLowUsd: number;
  netHighUsd: number;
}

export interface RoomEconomics {
  venueLowUsd: number;
  venueHighUsd: number;
  foodPerHeadUsd: number;
  targetAttendees: number;
  /** The full budget, one line per category, each with its basis. */
  lines: BudgetLine[];
  scenarios: SponsorScenario[];
  /** How many sponsors the packet asks for, and what they bring at SPONSORSHIP_RULE.perSponsorUsd. */
  sponsorCount: number;
  sponsorTargetLowUsd: number;
  sponsorTargetHighUsd: number;
  estimatedCostLowUsd: number;
  estimatedCostHighUsd: number;
  /** Sponsor target minus cost. Negative is legal and worth seeing. */
  netLowUsd: number;
  netHighUsd: number;
}

export interface RoomPacket {
  title: string;
  theme: string;
  centralQuestion: string | null;
  format: RoomFormat;
  targetMin: number;
  targetMax: number;
  audience: string | null;
  agendaMd: string | null;
  seedQuestions: string[];
  guestIdeas: GuestIdea[];
  venues: PacketVenue[];
  sponsorThesis: string | null;
  economics: RoomEconomics | null;
  /** How many sponsors Parker says this format honestly supports (1..maxSponsors). */
  sponsorCount: number;
  sponsorProspects: SponsorProspectIdea[];
  /** What could go wrong, as Parker sees it. */
  risks: string[];
  /** What saying "keep" commits the firm to — spend, people, approaches made in its name. */
  commitmentMd: string | null;
  /** Parker's budget lines, as proposed; computeEconomics fills what is missing and totals it. */
  budgetLines: Array<{ key: BudgetKey; lowUsd: number; highUsd: number; basis: string }>;
}

export interface PacketFlag {
  code:
    | "venue_unsourced"
    | "invented_url"
    | "no_venues"
    | "no_seed_questions"
    | "no_sponsor_thesis"
    | "target_out_of_range"
    | "contact_without_source"
    | "no_sponsor_prospects";
  detail: string;
}

/**
 * The sponsor structure from the pilot: one presenting, one supporting, one in-kind. Kept for the
 * tier labels on the pipeline; the MONEY is SPONSORSHIP_RULE now — a flat per-sponsor figure the
 * operator set on 15 Sep 2026 — so nothing computes from these ranges any more.
 */
export const SPONSOR_TIER_TARGETS = {
  PRESENTING: { low: 20_000, high: 25_000 },
  SUPPORTING: { low: 7_500, high: 12_500 },
  IN_KIND: { low: 0, high: 0 },
} as const;

// ── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Build Parker's brief.
 *
 * The rules in here are duplicated by verifyPacket() below on purpose. A prompt is a request and a
 * verifier is a guarantee; asking a model not to invent a phone number reduces how often it does,
 * and checking afterwards is what makes it safe.
 */
export function buildPacketPrompt(input: {
  month: string;
  recentThemes: readonly string[];
  venueCandidates: readonly { name: string; url: string; description?: string | null }[];
  city: string;
  /**
   * The firm's own methods for events, from the skill library and anything the partners have
   * adopted since. Empty string when a machine has none, in which case the section is omitted
   * entirely rather than printed as an empty heading.
   *
   * WHY THIS IS A PARAMETER RATHER THAN AN IMPORT. This module is pure and shared; the written
   * half lives in the database and only the worker can read it. The caller composes both.
   */
  guidance?: string;
  /** The partner's own brief, when the Room was asked for rather than thought of. */
  brief?: RoomBrief | null;
}): string {
  // THE FIRM'S METHODS COME FIRST, because they say what a good proposal IS. Everything below is
  // how to format one. Parker was proposing events without ever being told docs/COMMUNITY.md
  // existed, which is how a generator came to implement one row of a four-row rhythm and report
  // the same sponsor target on every packet it ever produced.
  const methods = input.guidance && input.guidance.trim().length > 0 ? `\n${input.guidance}\n` : "";

  // HER BRIEF COMES BEFORE EVERYTHING ELSE about the Room, because it IS the Room. Parker's own
  // idea is the fallback for a month nobody asked about, not a competitor to what she asked for.
  const brief = input.brief
    ? [
        "THE PARTNER ASKED FOR THIS ROOM. Build exactly what she asked for; do not substitute your own theme.",
        `- Audience / theme, in her words: ${input.brief.audience}`,
        input.brief.city ? `- City: ${input.brief.city}` : null,
        input.brief.sponsorProspects.length
          ? `- Sponsor prospects she named — use these FIRST, each as its own prospect, before adding any of your own: ${input.brief.sponsorProspects.join("; ")}`
          : "- She named no sponsor prospects; propose them yourself.",
        input.brief.notes ? `- Her notes: ${input.brief.notes}` : null,
      ].filter(Boolean).join("\n")
    : "Nobody asked for a particular Room this month — propose the one you think the community needs now.";

  const avoid = input.recentThemes.length
    ? `\nRECENT THEMES — propose something different:\n${input.recentThemes.map((t) => `- ${t}`).join("\n")}`
    : "";

  const venues = input.venueCandidates.length
    ? input.venueCandidates
        .map((v) => `- ${v.name} — ${v.url}${v.description ? ` — ${v.description}` : ""}`)
        .join("\n")
    : "(none found — return an empty venues array rather than inventing any)";

  return [
    // Identity from the registry — "Event Planner" is a title nobody holds; the roster says Event
    // Marketing Coordinator. A title written into a prompt is a second roster, and this one had
    // drifted from the first.
    personaPrompt("Parker", AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker")?.role ?? "AI employee"),
    `Propose ONE Room for ${input.month}${input.brief?.city ? ` in ${input.city}` : ` — ${input.city} unless the audience argues for another city, and say why`}.`,
    methods,
    "",
    brief,
    "",
    "A Room is a curated experience built around a single important question, for 25–35 people:",
    "strong operators, first-time founders, startup lawyers, finance leaders, technical builders.",
    "Conversation is the product, not presentations. West Peek convenes; it does not lecture.",
    "",
    "THE MANDATE, from a Managing Partner: \"i need this employee to get creative and think of unique",
    "experiences and rooms that could make people remember west peek ventures… unique venues and runs",
    "of show that make for memorable experiences that keep people talking for months and years.\"",
    "- Do NOT default to a seated dinner in New York. Propose that only when the brief asks for it.",
    "- Formats to reach for: a working session in an unexpected place; a private tour then a salon;",
    "  a morning at a courtroom, lab, studio or kitchen; a screening with its maker in the room; a",
    "  small-group expedition; a build or demo night; a chef's table with a purpose; a long walk with",
    "  stops; a match-day box; an after-hours museum or archive; a rooftop at dawn; a rehearsal room.",
    "- Unusual venues over private dining rooms: the place should be part of the story.",
    "- The run of show has ONE signature moment people will describe to someone else, and a takeaway",
    "  (a thing, a list, an introduction) that leaves with every guest.",
    "- Vary the city when the audience allows, and say why this city now.",
    avoid,
    "",
    "VENUE CANDIDATES — the only venues you may use. Each line is a real search result:",
    venues,
    "",
    "RULES THAT ARE CHECKED AFTER YOU ANSWER:",
    "- Every venue MUST carry a source_url copied EXACTLY from the candidate list above.",
    "- Do NOT invent a venue, a phone number, an email or a URL. A venue you cannot source is",
    "  dropped from the packet, so inventing one wastes the slot rather than filling it.",
    "- Only give a phone or email if it appears at that source. Otherwise use null. Null is a",
    "  correct answer; a plausible wrong number is not.",
    "- Pricing as a range with a note on what the range covers. Null if the source does not say —",
    "  BUT every venue ALSO carries estimate_low_usd / estimate_high_usd / estimate_basis: an educated",
    "  guess at what it costs for THIS Room. No venue is $0. Where the page states a price, the",
    "  estimate is that price; otherwise use a comparable and name it (\"private dining room for 30 in",
    "  NYC, $150–250/head F&B minimum\", \"gallery buy-out, weeknight, $4–8K\").",
    "- budget: a full budget as a senior event designer and coordinator would lay it out, one line per",
    `  key from [${BUDGET_KEYS.join(", ")}], each with low_usd, high_usd and a basis (per-head rate ×`,
    "  headcount, a published minimum, a comp, a rule of thumb). Include every possible cost: food,",
    "  drink, AV, entertainment, speakers or hosts and their gifts, design and print, photography,",
    "  staffing, travel, insurance, and a 10% contingency. The system totals it and compares it with",
    "  sponsorship at one, two and four sponsors — so the numbers must be honest, not flattering.",
    "- 4–8 seed questions, phrased the way an operator would actually ask them.",
    "- Guest ideas describe KINDS of people — invitee archetypes — each with an example PROFILE",
    "  (\"a sixth-year litigation associate at an AmLaw 50 firm who just made partner\"), never a",
    "  named individual. Leave person_id null — you cannot know our records.",
    "- A sponsor thesis says what a sponsor is underwriting. Never access to members.",
    "",
    "SPONSORSHIP — the firm's rule, stated by a Managing Partner:",
    `- Each sponsor pays $${SPONSORSHIP_RULE.perSponsorUsd.toLocaleString("en-US")} to West Peek. Aim for up to`,
    `  $${SPONSORSHIP_RULE.roomTargetUsd.toLocaleString("en-US")} per Room — ideally ${SPONSORSHIP_RULE.idealSponsors} sponsors, or whichever number the`,
    "  logistics of THIS format honestly support. State that number as sponsor_count and say why in",
    "  sponsor_thesis. A seated dinner for 25 cannot carry four logos gracefully; say so if so.",
    "- Name each sponsor prospect: the organisation, its category, why it fits THIS room, the ask",
    `  ($${SPONSORSHIP_RULE.perSponsorUsd.toLocaleString("en-US")} unless you argue otherwise), and the one-line pitch angle to open with.`,
    "- Prospects the partner named come first and are never dropped. ONE CATEGORY, ONE SPONSOR: if",
    "  she named a legal-tech company, the other prospects come from OTHER categories (cloud, spend,",
    "  cap table, banking, recruiting, hospitality) — three legal sponsors in one room compete with",
    "  each other and none renews. The first run of this packet did exactly that; do not.",
    "- A prospect's source_url is kept only if it appears in the candidate list or your search;",
    "  otherwise leave it null. Never invent a contact name or email — those are found by a person.",
    "",
    "RISKS AND THE COMMITMENT:",
    "- risks: 3–5 things that could go wrong with this particular Room, each one line.",
    "- commitment_md: what saying \"keep\" commits the firm to — the spend, whose time, which",
    "  organisations get approached in West Peek's name, and by when. Plain, short, honest.",
    "",
    'Return ONLY JSON:',
    JSON.stringify(
      {
        title: "The … Room",
        theme: "short theme",
        central_question: "the one question the evening is organised around",
        format: "DINNER",
        target_min: 25,
        target_max: 35,
        audience: "who should be in the room",
        agenda_md: "markdown run of the evening",
        seed_questions: ["…"],
        guest_ideas: [{ description: "archetype — example profile", why: "…" }],
        venues: [
          {
            name: "…", city: "…", address: "…", capacity: 40,
            price_low_usd: 0, price_high_usd: 0, price_note: "…",
            booking_phone: null, booking_email: null, booking_url: null,
            source_url: "https://… (copied exactly from the candidate list)",
            estimate_low_usd: 0, estimate_high_usd: 0, estimate_basis: "the comp this rests on",
          },
        ],
        budget: [{ key: "venue", low_usd: 0, high_usd: 0, basis: "…" }],
        sponsor_thesis: "…",
        sponsor_count: 4,
        sponsor_prospects: [
          {
            org_name: "…", category: "LEGAL", ask_usd: 10000,
            why_fit: "…", pitch: "…", source_url: null,
          },
        ],
        risks: ["…"],
        commitment_md: "…",
      },
      null,
      1,
    ),
  ].join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normaliseUrl(url: string): string {
  return url.trim().replace(/[.,;)\]]+$/, "").replace(/\/+$/, "").toLowerCase();
}

export function parsePacket(raw: string): RoomPacket | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let p: Record<string, unknown>;
  try {
    p = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const title = str(p.title);
  const theme = str(p.theme);
  if (!title || !theme) return null;

  const rawFormat = str(p.format)?.toUpperCase() ?? "DINNER";
  const format = (ROOM_FORMATS as readonly string[]).includes(rawFormat)
    ? (rawFormat as RoomFormat)
    : "DINNER";

  const venues: PacketVenue[] = [];
  for (const v of Array.isArray(p.venues) ? (p.venues as Record<string, unknown>[]) : []) {
    const name = str(v.name);
    const sourceUrl = str(v.source_url);
    // Enforced here as well as in the DB: a venue with no source never becomes a row.
    if (!name || !sourceUrl || !/^https?:\/\//i.test(sourceUrl)) continue;
    const priceLow = num(v.price_low_usd);
    const priceHigh = num(v.price_high_usd);
    const estLow = num(v.estimate_low_usd);
    const estHigh = num(v.estimate_high_usd);
    // NEVER $0. A published price is the estimate; a model estimate is kept with its basis; and a
    // venue with neither gets the room-size comp below, labelled as such, rather than a blank.
    const estimate = estimateVenueCost({ priceLow, priceHigh, estLow, estHigh, basis: str(v.estimate_basis), city: str(v.city), capacity: num(v.capacity) });
    venues.push({
      name,
      city: str(v.city),
      address: str(v.address),
      capacity: num(v.capacity),
      priceLowUsd: num(v.price_low_usd),
      priceHighUsd: num(v.price_high_usd),
      priceNote: str(v.price_note),
      bookingPhone: str(v.booking_phone),
      bookingEmail: str(v.booking_email),
      bookingUrl: str(v.booking_url),
      sourceUrl,
      estimateLowUsd: estimate.low,
      estimateHighUsd: estimate.high,
      estimateBasis: estimate.basis,
    });
  }

  const budgetLines: Array<{ key: BudgetKey; lowUsd: number; highUsd: number; basis: string }> = [];
  for (const b of Array.isArray(p.budget) ? (p.budget as Record<string, unknown>[]) : []) {
    const key = str(b.key)?.toLowerCase() as BudgetKey | undefined;
    if (!key || !(BUDGET_KEYS as readonly string[]).includes(key)) continue;
    const low = num(b.low_usd);
    const high = num(b.high_usd);
    if (low === null && high === null) continue;
    if (budgetLines.some((l) => l.key === key)) continue;
    budgetLines.push({ key, lowUsd: Math.max(0, low ?? high ?? 0), highUsd: Math.max(0, high ?? low ?? 0), basis: str(b.basis) ?? "Parker's estimate" });
  }

  const guestIdeas: GuestIdea[] = [];
  for (const g of Array.isArray(p.guest_ideas) ? (p.guest_ideas as Record<string, unknown>[]) : []) {
    const description = str(g.description);
    if (!description) continue;
    // person_id is never taken from the model. It cannot know our ids, so anything it offers is
    // either a hallucination or a guess that would attach a real member to a made-up reason.
    guestIdeas.push({ description, personId: null, why: str(g.why) });
  }

  const seedQuestions = (Array.isArray(p.seed_questions) ? p.seed_questions : [])
    .map((q) => str(q))
    .filter((q): q is string => q !== null);

  const targetMin = num(p.target_min) ?? 25;
  const targetMax = num(p.target_max) ?? 35;

  const sponsorProspects: SponsorProspectIdea[] = [];
  for (const sp of Array.isArray(p.sponsor_prospects) ? (p.sponsor_prospects as Record<string, unknown>[]) : []) {
    const orgName = str(sp.org_name);
    if (!orgName) continue;
    const rawCat = str(sp.category)?.toUpperCase() ?? "OTHER";
    const category = (SPONSOR_CATEGORIES as readonly string[]).includes(rawCat) ? (rawCat as SponsorCategory) : "OTHER";
    const sourceUrl = str(sp.source_url);
    sponsorProspects.push({
      orgName,
      category,
      askUsd: num(sp.ask_usd) ?? SPONSORSHIP_RULE.perSponsorUsd,
      whyFit: str(sp.why_fit),
      pitch: str(sp.pitch),
      sourceUrl: sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : null,
      fromBrief: false,
    });
  }

  const risks = (Array.isArray(p.risks) ? p.risks : [])
    .map((r) => str(r))
    .filter((r): r is string => r !== null);

  // Clamped to the rule: a model that says "six sponsors" has not read the room.
  const rawCount = num(p.sponsor_count);
  const sponsorCount = rawCount === null
    ? Math.min(Math.max(sponsorProspects.length, 1), SPONSORSHIP_RULE.maxSponsors)
    : Math.min(Math.max(Math.round(rawCount), 1), SPONSORSHIP_RULE.maxSponsors);

  return {
    title,
    theme,
    centralQuestion: str(p.central_question),
    format,
    targetMin,
    targetMax,
    audience: str(p.audience),
    agendaMd: str(p.agenda_md),
    seedQuestions,
    guestIdeas,
    venues,
    sponsorThesis: str(p.sponsor_thesis),
    economics: null,
    sponsorCount,
    sponsorProspects,
    risks,
    commitmentMd: str(p.commitment_md),
    budgetLines,
  };
}

/** The per-head comp used when neither a page nor Parker priced a venue. NYC-scale; stated as such. */
export const VENUE_COMP = { perHeadLowUsd: 150, perHeadHighUsd: 250, heads: 30 } as const;

/**
 * A venue's estimated cost, never zero. Published price first; Parker's estimate with its basis
 * second; the room-size comp last, labelled so a partner knows it is a rule of thumb.
 */
export function estimateVenueCost(input: {
  priceLow: number | null; priceHigh: number | null; estLow: number | null; estHigh: number | null;
  basis: string | null; city: string | null; capacity: number | null;
}): { low: number; high: number; basis: string } {
  const pub = (input.priceLow ?? 0) > 0 || (input.priceHigh ?? 0) > 0;
  if (pub) {
    const low = input.priceLow && input.priceLow > 0 ? input.priceLow : input.priceHigh!;
    const high = input.priceHigh && input.priceHigh > 0 ? input.priceHigh : input.priceLow!;
    return { low: Math.min(low, high), high: Math.max(low, high), basis: input.basis ?? "the price stated on the cited page" };
  }
  const est = (input.estLow ?? 0) > 0 || (input.estHigh ?? 0) > 0;
  if (est) {
    const low = input.estLow && input.estLow > 0 ? input.estLow : input.estHigh!;
    const high = input.estHigh && input.estHigh > 0 ? input.estHigh : input.estLow!;
    return { low: Math.min(low, high), high: Math.max(low, high), basis: input.basis ?? "Parker's estimate from comparable venues" };
  }
  const heads = Math.min(Math.max(input.capacity ?? VENUE_COMP.heads, 20), 40);
  return {
    low: VENUE_COMP.perHeadLowUsd * heads,
    high: VENUE_COMP.perHeadHighUsd * heads,
    basis: `rule of thumb: private room for ${heads} in ${input.city ?? "a major US city"} at $${VENUE_COMP.perHeadLowUsd}–${VENUE_COMP.perHeadHighUsd}/head F&B minimum — no price on the cited page`,
  };
}

/**
 * The partner's named prospects are used FIRST and never lost.
 *
 * The prompt says so; this makes it so. A prospect she typed that the model left out is added with
 * the standard ask and no pitch — the page then shows "Parker did not say why" beside it rather
 * than silently forgetting the one name she cared about. Matching is case-insensitive on the
 * organisation name, with a domain ("harvey.ai") matched against a name containing its stem.
 */
export function mergeBriefSponsors(packet: RoomPacket, brief: RoomBrief | null | undefined): RoomPacket {
  if (!brief || brief.sponsorProspects.length === 0) return packet;
  const norm = (v: string) => v.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[^a-z0-9]/g, "");
  const stemOf = (v: string) => norm(v).replace(/(com|ai|io|co|org|net)$/, "");
  const merged = packet.sponsorProspects.map((s) => ({ ...s }));
  for (const named of brief.sponsorProspects) {
    const key = stemOf(named);
    const hit = merged.find((s) => {
      const k = stemOf(s.orgName);
      return k === key || (key.length >= 4 && (k.includes(key) || key.includes(k)));
    });
    if (hit) {
      hit.fromBrief = true;
      continue;
    }
    merged.push({
      orgName: named,
      category: "OTHER",
      askUsd: SPONSORSHIP_RULE.perSponsorUsd,
      whyFit: null,
      pitch: null,
      sourceUrl: null,
      fromBrief: true,
    });
  }
  // Hers first, in the order she typed them.
  merged.sort((a, b) => Number(b.fromBrief) - Number(a.fromBrief));
  return { ...packet, sponsorProspects: merged, sponsorCount: Math.max(packet.sponsorCount, Math.min(merged.filter((m) => m.fromBrief).length, SPONSORSHIP_RULE.maxSponsors)) };
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Check a parsed packet against the sources it was given.
 *
 * Returns the packet with unsourced and invented-source venues removed, plus the flags explaining
 * what went and why. Flags are shown to a person — a packet that quietly arrives with two venues
 * instead of five looks thin, whereas one that says "three venues dropped: source not in search
 * results" tells you the search was the problem.
 */
export function verifyPacket(
  packet: RoomPacket,
  allowedUrls: readonly string[],
): { packet: RoomPacket; flags: PacketFlag[] } {
  const flags: PacketFlag[] = [];
  const allowed = new Set(allowedUrls.map(normaliseUrl));

  const kept: PacketVenue[] = [];
  for (const venue of packet.venues) {
    const source = normaliseUrl(venue.sourceUrl);
    // An empty allow-list means no live search ran; fall back to requiring a URL and nothing more,
    // rather than dropping everything and returning a packet with no venues at all.
    if (allowed.size > 0 && !allowed.has(source) && ![...allowed].some((a) => source.startsWith(a) || a.startsWith(source))) {
      flags.push({
        code: "invented_url",
        detail: `${venue.name}: source ${venue.sourceUrl} was not among the search results — dropped`,
      });
      continue;
    }
    kept.push(venue);
  }

  if (kept.length === 0) {
    flags.push({
      code: "no_venues",
      detail: "No venue survived sourcing. The Room is proposable but a person must find the space.",
    });
  }

  // A contact detail on a venue whose source is a directory listing is still unverified, and the
  // packet must not imply otherwise. This is a flag rather than a drop: a number worth calling with
  // a warning beats no number, so long as the warning travels with it.
  for (const venue of kept) {
    if ((venue.bookingPhone || venue.bookingEmail) && !venue.bookingUrl) {
      flags.push({
        code: "contact_without_source",
        detail: `${venue.name}: contact details are UNVERIFIED — confirm by phone before relying on them`,
      });
    }
  }

  // A sponsor's citation is held to the venue standard, but the prospect survives: a name is a
  // lead a person can check, a URL the search never returned is an invention and goes.
  const sponsorProspects = packet.sponsorProspects.map((sp) => {
    if (!sp.sourceUrl) return sp;
    const source = normaliseUrl(sp.sourceUrl);
    const known = allowed.size === 0 || allowed.has(source) || [...allowed].some((a) => source.startsWith(a) || a.startsWith(source));
    if (known) return sp;
    flags.push({ code: "invented_url", detail: `${sp.orgName}: source ${sp.sourceUrl} was not among the search results — citation removed, prospect kept` });
    return { ...sp, sourceUrl: null };
  });
  if (sponsorProspects.length === 0) {
    flags.push({ code: "no_sponsor_prospects", detail: "No sponsor prospect was named, so nobody can be approached for the money." });
  }

  if (packet.seedQuestions.length < 3) {
    flags.push({ code: "no_seed_questions", detail: "Fewer than three seed questions — the room will not start itself." });
  }
  if (!packet.sponsorThesis) {
    flags.push({ code: "no_sponsor_thesis", detail: "No sponsor thesis, so this Room has no funding story." });
  }
  if (packet.targetMin < 8 || packet.targetMax > 80 || packet.targetMin > packet.targetMax) {
    flags.push({
      code: "target_out_of_range",
      detail: `Target ${packet.targetMin}–${packet.targetMax} is outside what a Room can hold as a conversation.`,
    });
  }

  return { packet: { ...packet, venues: kept, sponsorProspects }, flags };
}

// ── Economics ────────────────────────────────────────────────────────────────

/**
 * Per-Room economics. Not firm accounting — the question is only whether this Room pays for itself.
 *
 * In-kind partners contribute zero cash by definition, so a Room underwritten in kind shows a
 * negative net and a zero venue cost. That is accurate and worth seeing rather than smoothing over.
 */
export function computeEconomics(input: {
  venues: readonly PacketVenue[];
  targetAttendees: number;
  foodPerHeadUsd?: number;
  /**
   * How many sponsors the packet asks for. The low case is one sponsor landing, the high case is
   * all of them at SPONSORSHIP_RULE.perSponsorUsd — the operator's rule, replacing the tier table
   * from the pilot (one presenting at $20–25k, one supporting at $7.5–12.5k) on 15 Sep 2026.
   */
  sponsorCount?: number;
  /** Parker's lines. Anything missing is filled from the rules of thumb below and labelled so. */
  budgetLines?: readonly { key: BudgetKey; lowUsd: number; highUsd: number; basis: string }[];
}): RoomEconomics {
  // Every venue carries an estimate now, so the venue line spans the cheapest to the dearest.
  const lows = input.venues.map((v) => v.estimateLowUsd);
  const highs = input.venues.map((v) => v.estimateHighUsd);
  const venueLowUsd = lows.length ? Math.min(...lows) : 0;
  const venueHighUsd = highs.length ? Math.max(...highs) : 0;

  const foodPerHeadUsd = input.foodPerHeadUsd ?? 120;
  const targetAttendees = input.targetAttendees;
  const n = Math.max(targetAttendees, 1);

  /*
   * THE FULL BUDGET, "from the POV of a senior event designer and coordinator". Parker's lines win
   * where he wrote them; each rule of thumb below fills a line he left out, and says so in its
   * basis, so a partner can tell an estimate from a guess. Venue is the sourced range when there is
   * one and a comp when there is none.
   */
  const given = new Map((input.budgetLines ?? []).map((l) => [l.key, l]));
  const defaults: Record<BudgetKey, { low: number; high: number; basis: string }> = {
    venue: venueLowUsd > 0
      ? { low: venueLowUsd, high: venueHighUsd, basis: "cheapest to dearest sourced venue estimate" }
      : { low: VENUE_COMP.perHeadLowUsd * n, high: VENUE_COMP.perHeadHighUsd * n, basis: `rule of thumb: $${VENUE_COMP.perHeadLowUsd}–${VENUE_COMP.perHeadHighUsd}/head private-room minimum × ${n} — no venue was priced` },
    food_beverage: { low: foodPerHeadUsd * n, high: Math.round(foodPerHeadUsd * 1.5) * n, basis: `$${foodPerHeadUsd}–${Math.round(foodPerHeadUsd * 1.5)}/head food and drink × ${n} (rule of thumb; often inside the venue minimum)` },
    av_production: { low: 800, high: 2500, basis: "rule of thumb: mics, a speaker and a screen for a room of this size" },
    entertainment_programming: { low: 0, high: 2500, basis: "rule of thumb: none, or one performer or facilitated segment" },
    speakers_hosts: { low: 500, high: 3000, basis: "rule of thumb: host gifts and one honorarium; most guests speak for free" },
    design_print_decor: { low: 400, high: 1500, basis: "rule of thumb: invitations, place cards, one printed piece, table decor" },
    photo_video: { low: 800, high: 2500, basis: "rule of thumb: one photographer for the evening; video at the top of the range" },
    staffing: { low: 500, high: 1500, basis: "rule of thumb: a coordinator and one runner on the night" },
    travel_accommodation: { low: 0, high: 1500, basis: "rule of thumb: none in the home city; one out-of-town host at the top" },
    insurance_permits: { low: 0, high: 600, basis: "rule of thumb: event insurance or a permit only if the venue requires it" },
    contingency: { low: 0, high: 0, basis: "10% of everything above" },
  };
  const lines: BudgetLine[] = [];
  for (const key of BUDGET_KEYS) {
    if (key === "contingency") continue;
    const g = given.get(key);
    const d = defaults[key];
    lines.push(g
      ? { key, label: BUDGET_LABELS[key], lowUsd: Math.min(g.lowUsd, g.highUsd), highUsd: Math.max(g.lowUsd, g.highUsd), basis: g.basis }
      : { key, label: BUDGET_LABELS[key], lowUsd: d.low, highUsd: d.high, basis: d.basis });
  }
  const subtotalLow = lines.reduce((t, l) => t + l.lowUsd, 0);
  const subtotalHigh = lines.reduce((t, l) => t + l.highUsd, 0);
  lines.push({ key: "contingency", label: BUDGET_LABELS.contingency, lowUsd: Math.round(subtotalLow * 0.1), highUsd: Math.round(subtotalHigh * 0.1), basis: "10% of everything above" });

  const estimatedCostLowUsd = Math.round(subtotalLow * 1.1);
  const estimatedCostHighUsd = Math.round(subtotalHigh * 1.1);

  const sponsorCount = Math.min(Math.max(input.sponsorCount ?? SPONSORSHIP_RULE.idealSponsors, 1), SPONSORSHIP_RULE.maxSponsors);
  const sponsorTargetLowUsd = SPONSORSHIP_RULE.perSponsorUsd;
  const sponsorTargetHighUsd = SPONSORSHIP_RULE.perSponsorUsd * sponsorCount;

  // What is left at one, two and four sponsors (and at the count Parker asked for): the partner's
  // question is not "does it pay" but "how many have to say yes before it does".
  const counts = Array.from(new Set([1, 2, sponsorCount, SPONSORSHIP_RULE.maxSponsors])).sort((a, b) => a - b);
  const scenarios: SponsorScenario[] = counts.map((c) => ({
    sponsors: c,
    sponsorshipUsd: SPONSORSHIP_RULE.perSponsorUsd * c,
    netLowUsd: SPONSORSHIP_RULE.perSponsorUsd * c - estimatedCostHighUsd,
    netHighUsd: SPONSORSHIP_RULE.perSponsorUsd * c - estimatedCostLowUsd,
  }));

  return {
    venueLowUsd,
    venueHighUsd,
    foodPerHeadUsd,
    targetAttendees,
    lines,
    scenarios,
    sponsorCount,
    sponsorTargetLowUsd,
    sponsorTargetHighUsd,
    estimatedCostLowUsd,
    estimatedCostHighUsd,
    // Worst case against best case: low revenue with high cost, high revenue with low cost.
    netLowUsd: sponsorTargetLowUsd - estimatedCostHighUsd,
    netHighUsd: sponsorTargetHighUsd - estimatedCostLowUsd,
  };
}

/** YYYY-MM for a date, so the monthly job can ask "did this month already get a proposal". */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * The month AFTER the one a date falls in. The monthly job proposes for this, not for the month it
 * runs in: a Room proposed on the 1st for the same month leaves no time to sell a sponsor, and both
 * packets proposed that way (2026-08, 2026-09) were declined.
 */
export function followingMonth(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}`;
}
