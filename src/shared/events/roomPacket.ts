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
    `Propose ONE Room for ${input.month} in ${input.city}.`,
    methods,
    "",
    brief,
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
    "- Prospects the partner named come first and are never dropped. One category, one sponsor.",
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
          },
        ],
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

  const sponsorCount = Math.min(Math.max(input.sponsorCount ?? SPONSORSHIP_RULE.idealSponsors, 1), SPONSORSHIP_RULE.maxSponsors);
  const sponsorTargetLowUsd = SPONSORSHIP_RULE.perSponsorUsd;
  const sponsorTargetHighUsd = SPONSORSHIP_RULE.perSponsorUsd * sponsorCount;

  const estimatedCostLowUsd = venueLowUsd + food;
  const estimatedCostHighUsd = venueHighUsd + food;

  return {
    venueLowUsd,
    venueHighUsd,
    foodPerHeadUsd,
    targetAttendees,
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
