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

export const PACKET_PROMPT_VERSION = "room-packet/1";

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
}

export interface GuestIdea {
  /** A description of the kind of person, or a named person if one is in the graph. */
  description: string;
  /** Set only when this resolves to a real record. Never invented. */
  personId: string | null;
  why: string | null;
}

export interface RoomEconomics {
  venueLowUsd: number;
  venueHighUsd: number;
  foodPerHeadUsd: number;
  targetAttendees: number;
  /** What the tiers below are expected to bring in. */
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
}

export interface PacketFlag {
  code:
    | "venue_unsourced"
    | "invented_url"
    | "no_venues"
    | "no_seed_questions"
    | "no_sponsor_thesis"
    | "target_out_of_range"
    | "contact_without_source";
  detail: string;
}

/** The sponsor structure from the pilot: one presenting, one supporting, one in-kind. */
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
}): string {
  const avoid = input.recentThemes.length
    ? `\nRECENT THEMES — propose something different:\n${input.recentThemes.map((t) => `- ${t}`).join("\n")}`
    : "";

  const venues = input.venueCandidates.length
    ? input.venueCandidates
        .map((v) => `- ${v.name} — ${v.url}${v.description ? ` — ${v.description}` : ""}`)
        .join("\n")
    : "(none found — return an empty venues array rather than inventing any)";

  return [
    `You are Parker, West Peek Ventures' Event Planner. Propose ONE Room for ${input.month} in ${input.city}.`,
    "",
    "A Room is a curated experience — a dinner, salon, workshop or roundtable — built around a",
    "single important question. 25–35 people: strong operators, first-time founders, startup",
    "lawyers, finance leaders, technical builders. Conversation is the product, not presentations.",
    "West Peek convenes; it does not lecture.",
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
    "- Pricing as a range with a note on what the range covers. Null if the source does not say.",
    "- 4–8 seed questions, phrased the way an operator would actually ask them.",
    "- Guest ideas describe KINDS of people. Leave person_id null — you cannot know our records.",
    "- A sponsor thesis says what a sponsor is underwriting. Never access to members.",
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
        guest_ideas: [{ description: "…", why: "…" }],
        venues: [
          {
            name: "…", city: "…", address: "…", capacity: 40,
            price_low_usd: 0, price_high_usd: 0, price_note: "…",
            booking_phone: null, booking_email: null, booking_url: null,
            source_url: "https://… (copied exactly from the candidate list)",
          },
        ],
        sponsor_thesis: "…",
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
    });
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
  };
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

  return { packet: { ...packet, venues: kept }, flags };
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
  tiers?: readonly (keyof typeof SPONSOR_TIER_TARGETS)[];
}): RoomEconomics {
  const priced = input.venues.filter((v) => v.priceLowUsd !== null || v.priceHighUsd !== null);

  // The cheapest sourced venue anchors the low case and the dearest the high case: the realistic
  // spread of "we booked the affordable one" against "we booked the one we actually wanted".
  const lows = priced.map((v) => v.priceLowUsd ?? v.priceHighUsd ?? 0);
  const highs = priced.map((v) => v.priceHighUsd ?? v.priceLowUsd ?? 0);
  const venueLowUsd = lows.length ? Math.min(...lows) : 0;
  const venueHighUsd = highs.length ? Math.max(...highs) : 0;

  const foodPerHeadUsd = input.foodPerHeadUsd ?? 120;
  const targetAttendees = input.targetAttendees;
  const food = foodPerHeadUsd * targetAttendees;

  const tiers = input.tiers ?? (["PRESENTING", "SUPPORTING"] as const);
  let sponsorTargetLowUsd = 0;
  let sponsorTargetHighUsd = 0;
  for (const tier of tiers) {
    sponsorTargetLowUsd += SPONSOR_TIER_TARGETS[tier].low;
    sponsorTargetHighUsd += SPONSOR_TIER_TARGETS[tier].high;
  }

  const estimatedCostLowUsd = venueLowUsd + food;
  const estimatedCostHighUsd = venueHighUsd + food;

  return {
    venueLowUsd,
    venueHighUsd,
    foodPerHeadUsd,
    targetAttendees,
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
