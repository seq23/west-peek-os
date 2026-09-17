import { ANGLE_KINDS, angleKindOf, angleRules, sameSubject, type AngleKind } from "./monthlyPlan";
import { personaPrompt } from "../registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";
/**
 * The Room packet — Parker's proposal, built as a chain (docs/COMMUNITY.md; rebuilt 15 Sep 2026).
 *
 * THE BAR, and where it moved. The first bar was "all the humans have to do is execute": a venue
 * with a phone number, a sponsor with an ask. The operator's verdict on the packet that met it was
 * "sub par", and she showed the standard she meant: research the named sponsor's ACTUAL programme
 * (Harvey AI sponsors the US Open, three NBA/WNBA teams, PSG, Lavender Law), find the PEOPLE who run
 * partnerships by name and title, argue the fit in the sponsor's own strategic language, ideate
 * three concepts and compare them, choose one and say why, propose venues with cultural intent,
 * write the run of show to the minute, budget it line by line with the basis, and end with the cold
 * email to the named contact. That is a chain of research and judgement, not one prompt, and this
 * module is the pure half of it: the prompts for each stage, the parsers, the verifiers and the
 * economics. The worker half (services/roomPacket.ts) runs the stages inside a work card the
 * employee sweep carries, one or two stages per tick, because the whole chain is far more than a
 * Free-plan cron tick can hold.
 *
 * THE FAILURES THIS MODULE EXISTS TO PREVENT are the same as before, applied to more things:
 *
 *   1. A venue with no source URL is DROPPED, not shown with a caveat.
 *   2. A source URL the live search did not actually return is an INVENTED URL and the venue is
 *      dropped. A citation the model made up is worse than no citation, because it looks checked.
 *   3. A sponsor qualifies ONLY with cited evidence of a real sponsorship budget — a past
 *      sponsorship with a URL that answered. No evidence, no rank; a partner-named sponsor with no
 *      sponsorship history is SAID to have none and a replacement is proposed.
 *   4. A contact is a name and a title READ OFF A PAGE that was fetched and searched for the name.
 *      A name the model remembered is not a contact.
 *   5. Everything that survives is UNVERIFIED until a person has called. The packet says so.
 *
 * Pure and I/O-free, so all of it is testable without a network or a model.
 */

export const PACKET_PROMPT_VERSION = "room-packet/3";

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
  /** Sponsor prospects she named. Each is a SEED: researched fully, ranked against what Parker finds. */
  sponsorProspects: string[];
  notes: string | null;
}

export type PacketOrigin = "PARKER" | "PARTNER_BRIEF";

/** Must stay in step with the `category` CHECK in migration 0044. */
export const SPONSOR_CATEGORIES = [
  "CLOUD", "FINTECH_SPEND", "EQUITY_CAPTABLE", "LEGAL", "PAYROLL_HR", "BANKING", "HOSPITALITY", "RECRUITING", "OTHER",
] as const;
export type SponsorCategory = (typeof SPONSOR_CATEGORIES)[number];

/** Must stay in step with the `tier` CHECK in migration 0044. TITLE is stored as PRESENTING. */
export type SponsorTier = "PRESENTING" | "SUPPORTING" | "IN_KIND";

/**
 * THE MONEY, as a TARGET WITH REASONS rather than a law.
 *
 * The operator's rule on 15 Sep 2026 was "$10,000 to us per sponsor; up to four sponsors" — and
 * then, the same day: "'up to 4 sponsors' shouldn't be a hard rule — always push back and tell me
 * if I'm wrong." And her brief for October: "$10,000 pocketed to the firm (maybe 4 sponsors to
 * cover everything + our keep)". So the fixed point is the firm's KEEP: the packet is priced so
 * that sponsorship = the whole cost of the experience + this keep. How many sponsors that takes,
 * and at what price each, is a judgement about what the format honestly carries — one title
 * sponsor with exclusivity is worth more than a fourth logo, and a dinner for forty cannot carry
 * six. `maxSlots` is a sanity ceiling on the parser, not a rule.
 */
export const SPONSORSHIP_TARGET = {
  keepUsd: 10_000,
  /** The reference figure her rule started from; the prompt cites it as a reference, not a price. */
  referencePerSponsorUsd: 10_000,
  referenceSponsors: 4,
  maxSlots: 6,
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
  /** Why THIS place for THIS room — the cultural or thematic reason, when the audience calls for one. */
  whyHere: string | null;
  /** The private-room minimum or buy-out as read or estimated; a comp names its source in estimateBasis. */
  roomMinimumUsd: number | null;
  /** The one venue kept as the fallback if the first choice cannot take the date. */
  isFallback: boolean;
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
  "design_print_decor", "gifting", "photo_video", "staffing", "travel_accommodation", "insurance_permits", "contingency",
] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

export const BUDGET_LABELS: Readonly<Record<BudgetKey, string>> = {
  venue: "Venue hire or room minimum",
  food_beverage: "Food and beverage (incl. tax and service)",
  av_production: "AV and production",
  entertainment_programming: "Entertainment and programming",
  speakers_hosts: "Speaker or host fees",
  design_print_decor: "Design, print, branding and decor",
  gifting: "Gifting and the takeaway",
  photo_video: "Photography and video",
  staffing: "Staffing on the night",
  travel_accommodation: "Travel and accommodation",
  insurance_permits: "Insurance and permits",
  contingency: "Contingency (10%)",
};

/** A sponsorship slot the format honestly carries: how many, at what price, for what. */
export interface SponsorSlot {
  tier: SponsorTier;
  count: number;
  askUsd: number;
  /** What the sponsor gets for it — concretely, and never access to members. */
  gets: string;
}

/**
 * The structure the format supports, priced so that sponsorship = cost + the firm's keep. Title vs
 * supporting; exclusivity as an option priced above the sum of the slots, because one sponsor who
 * owns the room is worth more than a fourth logo on the same wall.
 */
export interface SponsorshipStructure {
  slots: SponsorSlot[];
  /** The price for ONE sponsor to take the whole room, or null when the format does not suit it. */
  exclusiveUsd: number | null;
  exclusiveGets: string | null;
  /** Why this many, at these prices, for this format. */
  rationale: string;
}

/** What is left at N sponsors, so a partner sees the Room at one sponsor, at two, and at all of them. */
export interface SponsorScenario {
  sponsors: number;
  /** Which slots are assumed sold, in the order they would sell (title first). */
  description: string;
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
  estimatedCostLowUsd: number;
  estimatedCostHighUsd: number;
  /** The firm's target keep — the fixed point the structure is priced from. */
  keepTargetUsd: number;
  /** Cost (high case) + keep: what sponsorship has to add up to. */
  requiredUsd: number;
  structure: SponsorshipStructure;
  /** All slots sold. */
  sponsorTargetHighUsd: number;
  /** The first slot sold, alone. */
  sponsorTargetLowUsd: number;
  /** How many sponsors the structure asks for (sum of slot counts). */
  sponsorCount: number;
  scenarios: SponsorScenario[];
  /** The exclusive option, if the structure offers one. */
  exclusiveScenario: SponsorScenario | null;
  /** Sponsor target minus cost. Negative is legal and worth seeing. */
  netLowUsd: number;
  netHighUsd: number;
  /** Does the full structure reach cost + keep? If not, the packet says so rather than rounding. */
  reachesKeep: boolean;
}

/** One of the three concepts Parker ideates before committing to one. */
export interface RoomConcept {
  /** The angle's NAME. The month's SUBJECT lives on the packet, once — see `angleOn`. */
  title: string;
  format: RoomFormat;
  /** The idea in two or three sentences. */
  premise: string;
  tone: string;
  valueToSponsor: string;
  whoItFits: string;
  /** "$18–24K all-in" — a band, so the three can be compared before anything is costed. */
  costBand: string;
  signatureMoment: string;
  /** What to search for: the kind of venue and why, so the venue search is run for THIS concept. */
  venueDirection: string;
  chosen: boolean;
  /**
   * THE MONTH'S TOPIC, copied by the model. Every concept's must be the same subject or the whole
   * answer is discarded — see `parseConcepts`. Optional on the type only because rows stored before
   * 17 Sep 2026 do not carry one and the page must still render them.
   */
  angleOn?: string;
  /** What this angle varies: the name, the framing, the format, the venue, the experience. */
  angleKind?: AngleKind;
}

/** One line of the run of show, to the minute, with the named role. */
export interface RunOfShowLine {
  /** "6:30 PM" */
  time: string;
  minutes: number;
  what: string;
  /** Who carries it: "Sequoia (host)", "moderator", "the sponsor's executive (Harvey — 6 minutes)". */
  who: string;
}

/** The sponsor research a stage of the chain produced, before the packet was written. */
export interface SponsorResearch {
  orgName: string;
  category: SponsorCategory;
  /** True only when at least one evidence URL answered. */
  hasSponsorshipHistory: boolean;
  /** Past sponsorships, each with the page that shows it. Only URLs that answered survive. */
  evidence: Array<{ url: string; note: string }>;
  /** Read off a fetched page that carries the name; null when no page did. */
  contact: { name: string; title: string; sourceUrl: string } | null;
  /** How the sponsor describes its own strategy — phrases to argue the fit in, with the page. */
  strategicLanguage: string[];
  /** One paragraph on the programme as found. */
  summary: string;
  fromBrief: boolean;
}

/**
 * A sponsor prospect as the packet proposes it, after research. `evidenceUrl` is kept only if it is
 * one the research stage verified — the venue rule, applied to the money.
 */
export interface SponsorProspectIdea {
  orgName: string;
  category: SponsorCategory;
  tier: SponsorTier;
  askUsd: number;
  /** 1 = approach first. */
  rank: number;
  /** The fit, argued in the sponsor's own strategic language. */
  fitArgument: string | null;
  /** The one-line pitch angle to open with. */
  pitch: string | null;
  evidenceUrl: string | null;
  evidenceNote: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactSourceUrl: string | null;
  /** True when the partner named them in her brief rather than Parker finding them. */
  fromBrief: boolean;
  /** Parker's note when a named prospect has no sponsorship history, or a prospect replaces one. */
  note: string | null;
}

/** What the firm's own network can put in the room, read from its records. Never fabricated. */
export interface InviteCheck {
  totalContacts: number;
  /** Contacts whose record reads as a lawyer or legal role (or whatever the audience calls for). */
  matchingCount: number;
  /** The audience terms that were matched against the records. */
  matchedOn: string[];
  /** Archetypes drawn from the matching records, in words — never individuals unless from our records. */
  archetypes: string[];
  /** Named people FROM THE FIRM'S OWN RECORDS only, as a starting list. */
  namedFromRecords: string[];
  /**
   * Always STARTING_LIST. Until 16 Sep 2026 this could be CANNOT_FILL, and Parker used it to push
   * back on a Room ("only 6 of 4,712 contacts read as lawyers — widen the audience or co-host").
   * Sequoia's ruling: the community records are a partial read — job functions have not been
   * surveyed, and the partners' broader network is far larger than the community snapshot — so the
   * count is a starting list, never a ceiling and never a reason to widen, decline or push back.
   */
  verdict: "STARTING_LIST";
  /** What the count means: where the list starts; the broader network fills the rest. */
  note: string;
}

export interface RoomPacket {
  title: string;
  theme: string;
  centralQuestion: string | null;
  format: RoomFormat;
  targetMin: number;
  targetMax: number;
  audience: string | null;
  /** Kept for the page and older rows; the run of show is the structured lines below. */
  agendaMd: string | null;
  runOfShow: RunOfShowLine[];
  seedQuestions: string[];
  guestIdeas: GuestIdea[];
  venues: PacketVenue[];
  sponsorThesis: string | null;
  economics: RoomEconomics | null;
  structure: SponsorshipStructure;
  /** Slots in the structure (sum of counts). */
  sponsorCount: number;
  sponsorProspects: SponsorProspectIdea[];
  /** What could go wrong, as Parker sees it. */
  risks: string[];
  /** What saying "keep" commits the firm to — spend, people, approaches made in its name. */
  commitmentMd: string | null;
  /** Parker's budget lines, as proposed; computeEconomics fills what is missing and totals it. */
  budgetLines: Array<{ key: BudgetKey; lowUsd: number; highUsd: number; basis: string }>;
  /** Where Parker disagreed with the brief, and why. Null when he did not. */
  pushback: string | null;
  /** Why the chosen concept won, against the other two. */
  conceptChoiceMd: string | null;
  /** The cold email to the #1 sponsor's named contact, in Sequoia's voice. A draft; nothing is sent. */
  pitchEmail: { to: string; subject: string; body: string } | null;
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
    | "no_sponsor_prospects"
    | "sponsor_without_evidence"
    | "no_run_of_show"
    | "structure_short_of_keep";
  detail: string;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function parkerIdentity(): string {
  // Identity from the registry — "Event Planner" is a title nobody holds; the roster says Event
  // Marketing Coordinator. A title written into a prompt is a second roster, and this one had
  // drifted from the first.
  return personaPrompt("Parker", AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker")?.role ?? "AI employee");
}

/** The Room in one line, for the search prompts. */
export function roomOneLiner(brief: RoomBrief | null | undefined, city: string): string {
  return brief
    ? `a West Peek Ventures Room (an invitation-only gathering of 25–45 people hosted by a venture fund) in ${brief.city ?? city} for: ${brief.audience.slice(0, 220)}`
    : `a West Peek Ventures Room (an invitation-only gathering of 25–45 operators, founders and their advisers, hosted by a venture fund) in ${city}`;
}

/**
 * STAGE 1 — SPONSOR DISCOVERY. "Who pays to be in front of these people?" — every packet, prompt or
 * not. Categories are the answer key: the public sponsor lists of the associations this audience
 * belongs to, the vendors who sell to them, the banks who court them, the firms with a pipeline
 * budget for them. Run on the search model; every candidate needs a URL that shows a past
 * sponsorship, and those URLs are checked before anything is kept.
 */
export function buildSponsorDiscoveryPrompt(input: { brief: RoomBrief | null; city: string; month: string; audienceHint?: string | null }): string {
  const audience = input.brief?.audience ?? input.audienceHint ?? "strong operators, first-time founders, startup lawyers, finance leaders, technical builders";
  const named = input.brief?.sponsorProspects.length ? input.brief.sponsorProspects : [];
  return [
    parkerIdentity(),
    "",
    `TASK — find the organisations that PAY TO BE IN FRONT OF this audience, for ${roomOneLiner(input.brief, input.city)} in ${input.month}.`,
    `The audience: ${audience}.`,
    "",
    "Work the categories deliberately, using current sources — the answer key is the PUBLIC SPONSOR",
    "LISTS of the associations, conferences and awards this audience already belongs to. For lawyers:",
    "the National Bar Association, MCCA, LCLD, Lavender Law, NAMWOLF, the bar associations, Chambers",
    "and Legal 500 events, the ABA sections. For founders and operators: SaaStr, the accelerators'",
    "demo days, the operator communities. Read who sponsors those and why.",
    "Categories to cover (aim for two or three candidates in each that applies):",
    "  1. Vendors who SELL to the audience — for lawyers: legal-tech and legal-AI (Harvey, Thomson",
    "     Reuters, LexisNexis, Clio, Ironclad, Everlaw, Relativity, Litera), e-discovery, legal ops.",
    "  2. EMPLOYERS with a DEI / pipeline / recruiting budget for exactly these people — AmLaw firms'",
    "     diversity programmes, in-house legal departments, legal recruiters (Major Lindsey, Lateral Link).",
    "  3. PRIVATE BANKS and WEALTH MANAGERS who court partners and GCs (First Republic's successors,",
    "     J.P. Morgan Private Bank, Citi Private Bank, Northern Trust, Bernstein), insurers, lenders.",
    "  4. The SPONSORS OF THE AUDIENCE'S OWN INSTITUTIONS — read their sponsor pages and name the",
    "     companies on them; those companies have already proved they have the budget.",
    "  5. ADJACENT PREMIUM BRANDS that sponsor curated dinners and salons for professionals — spirits,",
    "     watches, cars, travel, hospitality — where the fit is real.",
    named.length ? `The partner already named: ${named.join("; ")} — include each as a candidate and find its sponsorship evidence like any other; do not assume it has any.` : "",
    "",
    "NAME THE SPONSORS, NOT THE INSTITUTIONS. The National Bar Association, MCCA, LCLD, NAMWOLF, a",
    "bar foundation, a law school and a law firm's own diversity programme ARE the audience's",
    "institutions — they are who the sponsors pay to reach, not sponsors themselves. Open their",
    "sponsor / partner / 'thank you to our sponsors' pages and return the COMPANIES listed on them",
    "(the first run of this returned the associations and the firms; that is the answer key, not",
    "the answer). A law firm counts only as an EMPLOYER with a pipeline budget, and no more than",
    "two firms.",
    "",
    "RULES:",
    "- A candidate qualifies ONLY with a URL that SHOWS a past sponsorship or partnership by that",
    "  organisation (a sponsor page, a press release, an event listing naming them as sponsor). A",
    "  company you believe would sponsor but cannot cite is not a candidate. No URL, no entry.",
    "- Prefer a live HTML page as evidence over a PDF; prefer the last two years.",
    "- One line on what the cited page shows (which event, which year, what tier if stated).",
    "- One line on why THIS audience is the one they pay to reach.",
    `- Category from [${SPONSOR_CATEGORIES.join(", ")}].`,
    "- SEVERAL SOURCES, not one: no more than three candidates from any one sponsor page, and at",
    "  least three different institutions' or events' sponsor lists read. The second run of this",
    "  returned seven names from one NAMWOLF page; that is one list, not a market.",
    "- 10 to 14 candidates, with AT LEAST: two vendors who sell to the audience (LEGAL for",
    "  lawyers), one BANKING (private bank, wealth manager, insurer or lender), one RECRUITING or",
    "  employer with a pipeline budget, and one adjacent premium brand (HOSPITALITY or OTHER) —",
    "  where evidence exists. Three vendors from one category in a room compete and none renews.",
    "- Do NOT name a person here; contacts are found separately.",
    "",
    'Return ONLY JSON: {"results":[{"org_name":"…","category":"LEGAL","evidence_url":"https://…","evidence_note":"…","why_this_audience":"…"}]}',
  ].filter((l) => l !== "").join("\n");
}

export interface SponsorCandidate {
  orgName: string;
  category: SponsorCategory;
  evidenceUrl: string;
  evidenceNote: string;
  whyThisAudience: string;
  fromBrief: boolean;
}

/** How many candidates one sponsor page may contribute: one list is an answer key, not a market. */
export const CANDIDATES_PER_PAGE = 4;

/** A note that says the page does NOT show the sponsor — the model attached a URL anyway (third production run). */
const NOT_EVIDENCED = /\b(no|not|without)\b[^.]{0,60}\b(evidence|evidenced|sponsor[- ]page|qualifying|listing|returned)\b|not (listed|found|shown)/i;

export function parseSponsorCandidates(raw: string, brief: RoomBrief | null): SponsorCandidate[] {
  const p = jsonBody(raw);
  const out: SponsorCandidate[] = [];
  const perPage = new Map<string, number>();
  for (const r of Array.isArray(p?.results) ? (p!.results as Record<string, unknown>[]) : []) {
    const orgName = str(r.org_name) ?? str(r.name);
    const evidenceUrl = httpUrl(r.evidence_url) ?? httpUrl(r.url);
    const evidenceNote = str(r.evidence_note) ?? "";
    // No evidence URL, no candidate. The whole value of discovery over memory is the citation —
    // and a note that says "no sponsor evidence was found" with a URL attached is no citation.
    if (!orgName || !evidenceUrl || NOT_EVIDENCED.test(evidenceNote)) continue;
    if (out.some((o) => sameOrg(o.orgName, orgName))) continue;
    const page = normaliseUrl(evidenceUrl);
    const fromBrief = (brief?.sponsorProspects ?? []).some((named) => sameOrg(named, orgName));
    if (!fromBrief && (perPage.get(page) ?? 0) >= CANDIDATES_PER_PAGE) continue;
    perPage.set(page, (perPage.get(page) ?? 0) + 1);
    const rawCat = str(r.category)?.toUpperCase() ?? "OTHER";
    out.push({
      orgName,
      category: (SPONSOR_CATEGORIES as readonly string[]).includes(rawCat) ? (rawCat as SponsorCategory) : "OTHER",
      evidenceUrl,
      evidenceNote,
      whyThisAudience: str(r.why_this_audience) ?? "",
      fromBrief,
    });
  }
  // Hers first, so a seed is researched before the budget of stages runs out.
  out.sort((a, b) => Number(b.fromBrief) - Number(a.fromBrief));
  return out;
}

/** Merge a second discovery pass into the first: new organisations only, the per-page cap still held. */
export function mergeCandidates(first: readonly SponsorCandidate[], second: readonly SponsorCandidate[]): SponsorCandidate[] {
  const out = [...first];
  const perPage = new Map<string, number>();
  for (const c of first) { const k = normaliseUrl(c.evidenceUrl); perPage.set(k, (perPage.get(k) ?? 0) + 1); }
  for (const c of second) {
    if (out.some((o) => sameOrg(o.orgName, c.orgName))) continue;
    const k = normaliseUrl(c.evidenceUrl);
    if (!c.fromBrief && (perPage.get(k) ?? 0) >= CANDIDATES_PER_PAGE) continue;
    perPage.set(k, (perPage.get(k) ?? 0) + 1);
    out.push(c);
  }
  out.sort((a, b) => Number(b.fromBrief) - Number(a.fromBrief));
  return out;
}

/**
 * Which candidates get the full research treatment: hers first, then ROUND-ROBIN BY CATEGORY, so
 * six slots do not go to six legal vendors when a bank and a recruiter were found too.
 */
export function pickForResearch(candidates: readonly SponsorCandidate[], max: number): SponsorCandidate[] {
  const picked: SponsorCandidate[] = candidates.filter((c) => c.fromBrief).slice(0, max);
  const rest = candidates.filter((c) => !c.fromBrief);
  const byCat = new Map<string, SponsorCandidate[]>();
  for (const c of rest) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
  const cats = [...byCat.keys()];
  let added = true;
  while (picked.length < max && added) {
    added = false;
    for (const cat of cats) {
      const next = byCat.get(cat)!.shift();
      if (next) { picked.push(next); added = true; if (picked.length >= max) break; }
    }
  }
  return picked;
}

/**
 * The SECOND discovery search: other lists, other categories. The third production run took all
 * thirteen names off NAPABA's 2026 sponsor page — a fine answer key, one list. This asks for the
 * same thing from sources it has not used, naming what it already has so it does not repeat.
 */
export function buildSponsorDiscoveryMorePrompt(input: { brief: RoomBrief | null; city: string; month: string; already: readonly SponsorCandidate[] }): string {
  const pages = Array.from(new Set(input.already.map((c) => { try { return new URL(c.evidenceUrl).hostname; } catch { return c.evidenceUrl; } })));
  const cats = Array.from(new Set(input.already.map((c) => c.category)));
  return [
    buildSponsorDiscoveryPrompt(input),
    "",
    "THIS IS THE SECOND PASS. Already found (do NOT repeat these organisations):",
    input.already.map((c) => `- ${c.orgName} (${c.category})`).join("\n"),
    `Sources already used (do NOT cite these hosts again): ${pages.join(", ")}.`,
    `Categories already covered: ${cats.join(", ")}. Favour the ones missing from [${SPONSOR_CATEGORIES.join(", ")}] — especially BANKING, RECRUITING, HOSPITALITY and adjacent premium brands.`,
    "Read DIFFERENT sponsor lists: the National Bar Association convention, MCCA's gala, LCLD's symposium, Lavender Law, the Black In-House Counsel Network, Black law student associations' galas, legal-tech conferences (ILTACON, Legalweek, CLOC), the city bar's diversity events.",
    "6 to 10 more candidates, no more than three from any one page.",
  ].join("\n");
}

/** Matching an organisation name loosely: "Harvey AI (harvey.ai)" ≈ "Harvey". */
export function sameOrg(a: string, b: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/\(.*?\)/g, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\b(inc|llc|ltd|corp|co|ai|the)\b/g, "").replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

/**
 * STAGE 2 — SPONSOR RESEARCH, one organisation at a time, on the search model. What the worker does
 * with the answer is the discipline: every evidence URL is fetched and must answer; the contact's
 * page is fetched and must CONTAIN the name; otherwise the contact is null and the packet says
 * "no named contact on a public page" rather than a plausible guess.
 */
export function buildSponsorResearchPrompt(input: { orgName: string; roomLine: string; audience: string }): string {
  return [
    `Research ${input.orgName} as a sponsor for ${input.roomLine}. The audience is: ${input.audience}.`,
    "",
    "Find, from current public pages:",
    "1. SPONSORSHIP HISTORY — the events, teams, associations, conferences or awards this organisation",
    "   has actually sponsored or partnered with (a sponsor page, a press release, an event listing",
    "   naming them). Each with the URL that shows it and one line on what it shows. Up to 5.",
    "2. THE PEOPLE WHO RUN PARTNERSHIPS — the person responsible for brand partnerships, sponsorships,",
    "   events or community marketing (titles like Director of Brand Partnerships, Head of Events, VP",
    "   Marketing, CMO). Name and title AND THE URL OF THE PAGE THAT SHOWS THEM (a team page, a",
    "   LinkedIn-derived profile on the company site, a press release quoting them, a conference",
    "   speaker page). Up to 3, most relevant first. The page must actually display the name — it is",
    "   fetched and checked. A PERSON'S NAME, never a role or a team ('Partner Program Lead' and",
    "   'the partnerships team' are dropped). Never an email address.",
    "3. STRATEGIC LANGUAGE — 3 to 5 short phrases in which the organisation describes its own",
    "   strategy, positioning or the audiences it courts, quoted from its pages (e.g. 'the AI platform",
    "   for elite law firms', 'we partner with the institutions that shape the profession'). Each with",
    "   its URL.",
    "4. A one-paragraph summary of the sponsorship programme as found, and whether it looks like a",
    "   budget that would fund a hosted dinner or salon for professionals.",
    "",
    "RULES: no URL, no entry. If there is no sponsorship history on any public page, say so plainly",
    "in the summary and return an empty history — that is a finding, not a failure.",
    "",
    'Return ONLY JSON: {"history":[{"url":"https://…","note":"…"}],"contacts":[{"name":"…","title":"…","source_url":"https://…"}],"strategic_language":[{"phrase":"…","url":"https://…"}],"summary":"…","category":"LEGAL"}',
  ].join("\n");
}

export interface SponsorResearchRaw {
  history: Array<{ url: string; note: string }>;
  contacts: Array<{ name: string; title: string; sourceUrl: string }>;
  strategicLanguage: Array<{ phrase: string; url: string | null }>;
  summary: string;
  category: SponsorCategory | null;
}

export function parseSponsorResearch(raw: string): SponsorResearchRaw {
  const p = jsonBody(raw);
  const history: SponsorResearchRaw["history"] = [];
  for (const h of Array.isArray(p?.history) ? (p!.history as Record<string, unknown>[]) : []) {
    const url = httpUrl(h.url);
    if (!url) continue;
    if (history.some((x) => x.url === url)) continue;
    history.push({ url, note: str(h.note) ?? "" });
  }
  const contacts: SponsorResearchRaw["contacts"] = [];
  for (const c of Array.isArray(p?.contacts) ? (p!.contacts as Record<string, unknown>[]) : []) {
    const name = str(c.name);
    const sourceUrl = httpUrl(c.source_url) ?? httpUrl(c.url);
    // A role is not a contact: "Partner Program Lead" with a team page is where a person LOOKS,
    // not somebody a partner can write to.
    if (!name || !sourceUrl || !looksLikePersonName(name)) continue;
    contacts.push({ name, title: str(c.title) ?? "title not stated", sourceUrl });
  }
  const strategicLanguage: SponsorResearchRaw["strategicLanguage"] = [];
  for (const s of Array.isArray(p?.strategic_language) ? (p!.strategic_language as unknown[]) : []) {
    if (typeof s === "string" && s.trim()) { strategicLanguage.push({ phrase: s.trim(), url: null }); continue; }
    const o = s as Record<string, unknown>;
    const phrase = str(o?.phrase);
    if (phrase) strategicLanguage.push({ phrase, url: httpUrl(o.url) });
  }
  const rawCat = str(p?.category)?.toUpperCase();
  return {
    history: history.slice(0, 6),
    contacts: contacts.slice(0, 4),
    strategicLanguage: strategicLanguage.slice(0, 6),
    summary: str(p?.summary) ?? "",
    category: rawCat && (SPONSOR_CATEGORIES as readonly string[]).includes(rawCat) ? (rawCat as SponsorCategory) : null,
  };
}

/**
 * Is this a PERSON'S name, and not a role? The first production run kept "Partner Program Lead"
 * as Harvey's contact because the page carried those words. A contact is two or more capitalised
 * words with no role or team vocabulary in them; anything else is a title and is dropped.
 */
const ROLE_WORDS = /\b(lead|leader|head|director|manager|team|partnerships?|partner|program|programme|marketing|events?|sponsorships?|officer|chief|vp|president|group|department|office|contact|inquiries|press|media|brand|community|sales|general|counsel|associate|coordinator|specialist|the|of|and|for)\b/i;
export function looksLikePersonName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  if (n.length < 4 || n.length > 60) return false;
  const words = n.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (ROLE_WORDS.test(n)) return false;
  if (/[@\d/:]/.test(n)) return false;
  // Every word starts with a capital (or is a particle like "de", "van"), and at least two do.
  const caps = words.filter((w) => /^[A-Z]/.test(w.replace(/^["'(]/, "")));
  return caps.length >= 2 && words.every((w) => /^[A-Za-z][A-Za-z'.-]*$/.test(w.replace(/^["'(]|[")',]$/g, "")));
}

/**
 * Does a fetched page carry the contact's name? Loose on whitespace and HTML (a name split across
 * tags still counts), strict on the words: both the first and the last name have to be there.
 */
export function pageCarriesName(pageText: string, name: string): boolean {
  const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return false;
  const text = pageText.toLowerCase().replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
  const first = words[0]!;
  const last = words[words.length - 1]!;
  // The full name as written, or first + last with a middle name or initial dropped.
  return text.includes(words.join(" ")) || (words.length >= 2 && text.includes(`${first} ${last}`));
}

/**
 * STAGE 3 — IDEATE, COMPARE, COMMIT. Three concepts, compared on tone, value to the sponsor, who
 * it fits and cost band; one chosen, with the reason. The winner's `venue_direction` is what the
 * venue search is run for, so the venue is chosen for the concept and not the other way round.
 */
export function buildConceptsPrompt(input: {
  month: string;
  city: string;
  /** The month's ONE subject, or null when nobody set one and Parker picks it in this call. */
  topic: string | null;
  setBy: "PARTNERS" | "PARKER";
  /** What the partners want out of the angles, in their words. */
  steer: string | null;
  brief: RoomBrief | null;
  /** What ACTUALLY ran in the adjacency window — not what was proposed. */
  ran: readonly { month: string; topic: string; note: string }[];
  recentThemes: readonly string[];
  inviteCheck: InviteCheck | null;
  sponsors: readonly SponsorResearch[];
  guidance?: string;
}): string {
  const methods = input.guidance && input.guidance.trim().length > 0 ? `\n${input.guidance}\n` : "";
  const brief = input.brief
    ? [
        "THE PARTNER ASKED FOR THIS ROOM, in her words:",
        `- Audience / theme: ${input.brief.audience}`,
        input.brief.city ? `- City: ${input.brief.city}` : null,
        input.brief.sponsorProspects.length ? `- Sponsors she named: ${input.brief.sponsorProspects.join("; ")}` : null,
        input.brief.notes ? `- Her notes: ${input.brief.notes}` : null,
        "Build what she asked for — and PUSH BACK where the facts argue against it (she asked you to).",
      ].filter(Boolean).join("\n")
    : "Nobody asked for a particular Room this month — propose the one the community needs now.";
  const invite = input.inviteCheck
    ? [
        "A STARTING GUEST LIST FROM THE FIRM'S RECORDS (information for planning the ask — NOT a constraint on the Room):",
        `- ${input.inviteCheck.matchingCount} of ${input.inviteCheck.totalContacts} community contacts read as ${input.inviteCheck.matchedOn.join(" / ")}.`,
        `- ${input.inviteCheck.note}`,
        "- Never cite this count as a reason to widen the audience, co-host instead, or push back. The partners fill Rooms from their broader network.",
        input.inviteCheck.archetypes.length ? `- Archetypes present: ${input.inviteCheck.archetypes.join("; ")}` : null,
      ].filter(Boolean).join("\n")
    : "";
  const sponsors = input.sponsors.length
    ? input.sponsors.map((s) => `- ${s.orgName} (${s.category}${s.fromBrief ? ", named by the partner" : ""}): ${s.hasSponsorshipHistory ? `sponsorship history found (${s.evidence.length} cited)` : "NO sponsorship history found on any public page"}${s.contact ? `; partnerships contact ${s.contact.name}, ${s.contact.title}` : "; no named contact on a public page yet"}. ${s.summary.slice(0, 240)}`).join("\n")
    : "(no sponsor research is available; ideate on the audience alone)";
  /*
   * ADJACENCY MEASURES WHAT RAN. `ran` is the caller's list of sessions that actually happened or
   * were kept in the window — never a proposal, and never a declined one. `recentThemes` stays for
   * callers that have not been updated, as a weaker hint, and is labelled as such.
   */
  const adjacency = input.ran.length
    ? `\nWHAT ACTUALLY RAN LAST MONTH — a LIGHT rule, one month back: do not propose a topic that is nearly the same as one of these. Adjacent is fine; near-identical is not. This is what RAN, not what was proposed.\n${input.ran.map((r) => `- ${r.month}: ${r.topic} (${r.note})`).join("\n")}`
    : "";
  const avoid = input.recentThemes.length ? `\nTITLES ALREADY USED — do not reuse a title:\n${input.recentThemes.map((t) => `- ${t}`).join("\n")}` : "";
  const topicRules = input.topic
    ? angleRules({ topic: input.topic, stream: "ROOM", setBy: input.setBy })
    : [
        `NOBODY HAS SET A TOPIC FOR THE ${input.month} ROOM, SO YOU CHOOSE ONE. Do not ask and do not wait.`,
        "Pick the ONE subject this community needs now — something NEW and fresh — name it in `topic`, and",
        "then give THREE ANGLES ON THAT ONE SUBJECT.",
        "",
        "An angle varies the NAME, the FRAMING, the FORMAT, the VENUE or the EXPERIENCE. It NEVER varies",
        "what the Room is about.",
        "",
        "The partner's own example, verbatim: \"Black lawyers is a topic. Community is a topic. but angles",
        "are things like names / venues / type of event.\"",
        "",
        "EVERY concept MUST carry `angle_on` set to the topic you chose, copied EXACTLY, and `angle_kind`",
        `from ${ANGLE_KINDS.join(" / ")}. Three different \`angle_on\` values is three subjects, and the whole`,
        "answer is DISCARDED and asked for again.",
      ].join("\n");
  return [
    parkerIdentity(),
    `Work up THREE ANGLES on the ${input.month} Room's ONE topic, in ${input.brief?.city ?? input.city}, compare them, and choose one.`,
    methods,
    topicRules,
    input.steer ? `\nWHAT THE PARTNERS WANT OUT OF THE ANGLES, in their words:\n${input.steer}` : "",
    brief,
    "",
    invite,
    "",
    "SPONSORS ALREADY RESEARCHED (the money the concept has to make sense to):",
    sponsors,
    adjacency,
    avoid,
    "",
    "A Room is a curated experience built around a single important question, for 25–45 people.",
    "Conversation is the product, not presentations. West Peek convenes; it does not lecture.",
    "",
    "THE MANDATE, from a Managing Partner: \"i need this employee to get creative and think of unique",
    "experiences and rooms that could make people remember west peek ventures… unique venues and runs",
    "of show that make for memorable experiences that keep people talking for months and years.\"",
    "- The three ANGLES must differ in NAME, FORMAT, VENUE and in the memory a guest carries out —",
    "  and must NOT differ in subject. Each `title` is a catchy NAME for the same Room. E.g. a live",
    "  working session or 'war room' with the sponsor's tool in hand; an executive dinner and think",
    "  tank under Chatham House rules with one decision on the table; a speed-format that pairs",
    "  people who need each other (founders with the advocates who could represent them); a private",
    "  tour then a salon; a morning at a courtroom, kitchen, studio or archive; a screening with its",
    "  maker; a build night; a chef's table with a purpose; a match-day box; a rooftop at dawn.",
    "- Dinner is ALLOWED when it is the right answer for this audience and this sponsor — a senior",
    "  professional crowd often wants a serious table — but it must be argued for, never the default.",
    "- Each concept has ONE signature moment people will describe to someone who was not there, and",
    "  a takeaway that leaves with every guest.",
    "- For each concept say what kind of venue it wants and WHY — culturally resonant when the",
    "  audience calls for it, specific enough that a search for it returns real places. WHEN THE",
    "  AUDIENCE IS DEFINED BY WHO THEY ARE (a room of Black lawyers, of women founders), the venue",
    "  direction MUST carry that identity — a Black-owned or Black-led restaurant, a Black cultural",
    "  institution's private room, a chef the audience would recognise — and name the reason. The",
    "  third production run drifted to a townhouse and a members' club for a room of Black lawyers;",
    "  the second had the Schomburg Center and Charlie Mitchell's room. The second is the standard.",
    "- Compare the three honestly on: tone; value to the sponsor (what their executive gets to do in",
    "  the room, and for how long); who it fits (which of the audience it actually draws); cost band.",
    "- CHOOSE ONE. Say why it wins and what the other two lose on. The other two go in the appendix.",
    "- PUSHBACK: if the named sponsor has no sponsorship history, or the money asked for does not fit",
    "  the format, say so in `pushback` in plain words and propose the adjustment (replace the sponsor,",
    "  restructure the ask). The size of the starting guest list is NEVER pushback — the partners",
    "  fill the room from their broader network. Empty string if none.",
    "",
    'Return ONLY JSON:',
    JSON.stringify({
      concepts: [
        { title: "the catchy NAME for this angle", angle_on: input.topic ?? "the one subject you chose", angle_kind: "NAME", format: "SALON", premise: "…", tone: "…", value_to_sponsor: "…", who_it_fits: "…", cost_band: "$18–24K all-in", signature_moment: "…", venue_direction: "what to search for and why", chosen: true },
      ],
      topic: input.topic ?? "the one subject you chose",
      choice_rationale: "why the chosen angle wins, and what the other two lose on",
      pushback: "",
    }, null, 1),
  ].filter((l) => l !== "").join("\n");
}

/**
 * THREE ANGLES ON ONE TOPIC, EXACTLY ONE CHOSEN — and a three-subject answer is REJECTED here.
 *
 * The Room half of the guarantee described at length in `workshopPacket.parseWorkshopConcepts`:
 * the packet holds ONE topic, a concept's `title` is the angle's NAME and carries no subject of its
 * own, and every concept must echo `angle_on`. Three different `angle_on` values — which is what a
 * model listing three subjects actually produces — returns null, which fails the stage rather than
 * storing anything.
 *
 * `setTopic` null means the month was open and Parker chose: the topic is read from the answer's
 * own `topic` field, and the echo rule still applies.
 */
export function parseConcepts(raw: string, setTopic: string | null): { topic: string; concepts: RoomConcept[]; choiceRationale: string | null; pushback: string | null } | null {
  const p = jsonBody(raw);
  if (!p) return null;
  const rows = Array.isArray(p.concepts) ? (p.concepts as Record<string, unknown>[]) : [];
  if (rows.length === 0) return null;
  const declared = rows.map((c) => str(c.angle_on));
  const topic = setTopic ?? str(p.topic) ?? declared.find((d): d is string => Boolean(d)) ?? null;
  if (!topic) return null;
  if (declared.some((d) => !sameSubject(d, topic))) return null;
  const concepts: RoomConcept[] = [];
  for (const c of rows) {
    const title = str(c.title);
    if (!title) continue;
    const rawFormat = str(c.format)?.toUpperCase() ?? "SALON";
    concepts.push({
      title,
      format: (ROOM_FORMATS as readonly string[]).includes(rawFormat) ? (rawFormat as RoomFormat) : "SALON",
      premise: str(c.premise) ?? "",
      tone: str(c.tone) ?? "",
      valueToSponsor: str(c.value_to_sponsor) ?? "",
      whoItFits: str(c.who_it_fits) ?? "",
      costBand: str(c.cost_band) ?? "",
      signatureMoment: str(c.signature_moment) ?? "",
      venueDirection: str(c.venue_direction) ?? "",
      chosen: c.chosen === true,
      angleOn: topic,
      angleKind: angleKindOf(c.angle_kind),
    });
  }
  if (concepts.length === 0) return null;
  // Exactly one winner. A model that ticked two, or none, gets the first ticked or the first.
  const firstChosen = concepts.findIndex((c) => c.chosen);
  concepts.forEach((c, i) => { c.chosen = i === (firstChosen === -1 ? 0 : firstChosen); });
  return { topic, concepts: concepts.slice(0, 3), choiceRationale: str(p.choice_rationale), pushback: str(p.pushback) };
}

/** The venue search brief for the chosen concept: what to look for and why, in the search model's terms. */
export function venueSearchBrief(concept: RoomConcept | null, brief: RoomBrief | null, targetHeads = 40): string {
  const direction = concept?.venueDirection?.trim();
  const who = brief?.audience ? ` for ${brief.audience.slice(0, 160)}` : "";
  if (direction) return `${direction} — a private room or buy-out for about ${targetHeads} people${who}; include the venue's own private-events page where one exists`;
  return `a private room or unusual space for a curated gathering of about ${targetHeads} people${who}`;
}

/**
 * STAGE 5 — THE PACKET for the chosen concept. The rules in here are duplicated by verifyPacket()
 * below on purpose. A prompt is a request and a verifier is a guarantee; asking a model not to
 * invent a phone number reduces how often it does, and checking afterwards is what makes it safe.
 *
 * The signature keeps the fields the earlier prompt had (month, recentThemes, venueCandidates,
 * city, guidance, brief) and adds the chain's outputs. With none of the new inputs it still writes
 * a complete packet from the brief alone, so the one-shot path and the tests keep working.
 */
export function buildPacketPrompt(input: {
  month: string;
  recentThemes: readonly string[];
  venueCandidates: readonly { name: string; url: string; description?: string | null }[];
  city: string;
  guidance?: string;
  brief?: RoomBrief | null;
  concepts?: readonly RoomConcept[];
  choiceRationale?: string | null;
  pushback?: string | null;
  sponsors?: readonly SponsorResearch[];
  inviteCheck?: InviteCheck | null;
}): string {
  // THE FIRM'S METHODS COME FIRST, because they say what a good proposal IS. Everything below is
  // how to format one.
  const methods = input.guidance && input.guidance.trim().length > 0 ? `\n${input.guidance}\n` : "";
  const chosen = (input.concepts ?? []).find((c) => c.chosen) ?? null;

  // HER BRIEF COMES BEFORE EVERYTHING ELSE about the Room, because it IS the Room.
  const brief = input.brief
    ? [
        "THE PARTNER ASKED FOR THIS ROOM. Build what she asked for; where you push back, say so in `pushback`.",
        `- Audience / theme, in her words: ${input.brief.audience}`,
        input.brief.city ? `- City: ${input.brief.city}` : null,
        input.brief.sponsorProspects.length
          ? `- Sponsor prospects she named (seeds — researched below, ranked against the rest): ${input.brief.sponsorProspects.join("; ")}`
          : "- She named no sponsor prospects.",
        input.brief.notes ? `- Her notes: ${input.brief.notes}` : null,
      ].filter(Boolean).join("\n")
    : "Nobody asked for a particular Room this month — propose the one you think the community needs now.";

  const concept = chosen
    ? [
        "THE CONCEPT YOU CHOSE (build the packet for this one, and only this one):",
        `- ${chosen.title} — ${chosen.format}. ${chosen.premise}`,
        `- Tone: ${chosen.tone}. Value to the sponsor: ${chosen.valueToSponsor}. Who it fits: ${chosen.whoItFits}. Cost band: ${chosen.costBand}.`,
        `- Signature moment: ${chosen.signatureMoment}`,
        input.choiceRationale ? `- Why it won: ${input.choiceRationale}` : null,
        input.pushback ? `- Your pushback on the brief, to carry into the packet: ${input.pushback}` : null,
      ].filter(Boolean).join("\n")
    : "";

  const invite = input.inviteCheck
    ? `STARTING GUEST LIST, from the firm's records: ${input.inviteCheck.matchingCount} of ${input.inviteCheck.totalContacts} community contacts read as ${input.inviteCheck.matchedOn.join(" / ")}. ${input.inviteCheck.note}${input.inviteCheck.archetypes.length ? ` Archetypes present: ${input.inviteCheck.archetypes.join("; ")}.` : ""} Use it in the guest ideas as where the list starts. It is NOT a risk, NOT a reason to widen the audience, and NOT pushback — the partners fill the room from their broader network.`
    : "";

  const sponsors = (input.sponsors ?? []).length
    ? [
        "SPONSORS RESEARCHED (rank ALL of them; every field below is checked against this research):",
        ...(input.sponsors ?? []).map((s) => [
          `- ${s.orgName} (${s.category}${s.fromBrief ? ", NAMED BY THE PARTNER" : ""}) — ${s.hasSponsorshipHistory ? "sponsorship history: YES" : "sponsorship history: NONE FOUND on any public page — say so, rank it accordingly, and propose a replacement in its category if it was named"}`,
          ...s.evidence.map((e) => `    evidence: ${e.url} — ${e.note}`),
          s.contact ? `    contact (read off ${s.contact.sourceUrl}): ${s.contact.name}, ${s.contact.title}` : "    contact: none found on a public page — leave contact fields null",
          s.strategicLanguage.length ? `    their own words: ${s.strategicLanguage.map((x) => `"${x}"`).join("; ")}` : null,
          s.summary ? `    programme: ${s.summary.slice(0, 400)}` : null,
        ].filter(Boolean).join("\n")),
      ].join("\n")
    : "SPONSORS: no research is available for this build. Name prospects by category with why_fit; leave evidence_url and contact fields null.";

  const avoid = input.recentThemes.length
    ? `\nRECENT THEMES — this Room must be different:\n${input.recentThemes.map((t) => `- ${t}`).join("\n")}`
    : "";

  const venues = input.venueCandidates.length
    ? input.venueCandidates.map((v) => `- ${v.name} — ${v.url}${v.description ? ` — ${v.description}` : ""}`).join("\n")
    : "(none found — return an empty venues array rather than inventing any)";

  const ref = SPONSORSHIP_TARGET;
  return [
    parkerIdentity(),
    `Write the complete Room packet for ${input.month}${input.brief?.city ? ` in ${input.city}` : ` — ${input.city} unless the audience argues for another city, and say why`}.`,
    methods,
    "",
    brief,
    "",
    concept,
    "",
    invite,
    "",
    sponsors,
    "",
    "A Room is a curated experience built around a single important question, for 25–45 people:",
    "strong operators, first-time founders, startup lawyers, finance leaders, technical builders.",
    "Conversation is the product, not presentations. West Peek convenes; it does not lecture.",
    "",
    "THE MANDATE, from a Managing Partner: \"i need this employee to get creative and think of unique",
    "experiences and rooms that could make people remember west peek ventures… unique venues and runs",
    "of show that make for memorable experiences that keep people talking for months and years.\"",
    "- Do NOT default to a seated dinner. Dinner is allowed when it is the right answer, argued for.",
    "- The venue is part of the story: culturally resonant when the audience calls for it, and say why.",
    "- The run of show has ONE signature moment people will describe to someone else, and a takeaway",
    "  (a thing, a list, an introduction) that leaves with every guest.",
    avoid,
    "",
    "VENUE CANDIDATES — the only venues you may use. Each line is a real search result:",
    venues,
    "",
    "RULES THAT ARE CHECKED AFTER YOU ANSWER:",
    "- Every venue MUST carry a source_url copied EXACTLY from the candidate list above. 2–4 venues:",
    "  a first choice, a comp, and ONE marked is_fallback for if the first cannot take the date.",
    "- WHEN THE AUDIENCE IS DEFINED BY WHO THEY ARE, the FIRST-CHOICE venue carries that identity",
    "  (Black-owned, Black-led, or a Black cultural institution for a room of Black lawyers) and",
    "  why_here names the person or the history; the comp and the fallback may be plainer.",
    "- For each venue: why_here (the cultural or thematic reason, one line), capacity, the private-room",
    "  minimum or buy-out as room_minimum_usd (read from the page, else your comp), and price_note.",
    "- Do NOT invent a venue, a phone number, an email or a URL. Only give a phone or email if it",
    "  appears at that source. Otherwise null. Null is a correct answer; a plausible wrong number is not.",
    "- Every venue ALSO carries estimate_low_usd / estimate_high_usd / estimate_basis: what it costs",
    "  for THIS Room. No venue is $0. Where the page states a price, the estimate is that price;",
    "  otherwise a comparable, NAMED with its source (\"private dining for 40 at a Michelin-starred",
    "  NYC room, $250/head incl. tax and 22% service — comp: <venue> private-events page\").",
    "- run_of_show: TO THE MINUTE, from arrival to nightcap, 8–14 lines, each with `who` — the host",
    "  who opens (a Managing Partner, by name: Sequoia Taylor or Scooter Taylor), the moderator, where",
    "  the sponsor's executive speaks and for HOW LONG (never more than 8 minutes), the signature",
    "  moment, the takeaway. Say 'Chatham House rule' in the line where it applies, if it fits.",
    "- agenda_md: the same run of show as short markdown, for the page.",
    "- budget: a full budget as a senior event designer would lay it out, one line per key from",
    `  [${BUDGET_KEYS.filter((k) => k !== "contingency").join(", ")}], each with low_usd, high_usd and a basis:`,
    "  per-head × headcount INCLUDING tax and service (\"$250/head × 40 incl. tax and 22% service\"),",
    "  the room minimum, AV, branding and print, gifting, photography/video, staffing, entertainment",
    "  or speaker, travel. The system adds 10% contingency and totals it — honest, not flattering.",
    "",
    "SPONSORSHIP — priced from the concept, honestly:",
    `- The firm's fixed point is its KEEP: target $${ref.keepUsd.toLocaleString("en-US")} to West Peek after every cost. That is a target`,
    "  with reasons, not a law — if the format cannot honestly carry it, say so and show the number it can.",
    "- Design the STRUCTURE the format honestly supports: how many slots the room can carry without",
    "  the sponsors competing (title / supporting / in-kind), what each gets (their executive's minutes",
    "  in the run of show, the underwriting credit, the clinic afterwards, the recap — NEVER an",
    "  attendee list), and the ask for each, so that ALL SLOTS SOLD = total cost (high case) + the keep.",
    `- The partner's reference was $${ref.referencePerSponsorUsd.toLocaleString("en-US")} a sponsor × up to ${ref.referenceSponsors}. Use it as a reference, not a`,
    "  price: a title slot at $18–25K with the executive's six minutes is worth more than a fourth logo,",
    "  and a room of forty carries two or three sponsors gracefully, rarely more.",
    "- Offer EXCLUSIVITY as an option: one sponsor takes the whole room at exclusive_usd, priced above",
    "  the sum of the slots (say why), or null if the format does not suit it.",
    "- sponsor_prospects: RANK every researched organisation (rank 1 = approach first), tier",
    "  (PRESENTING for title, SUPPORTING, IN_KIND), ask_usd matching its slot, fit_argument written in",
    "  the sponsor's OWN strategic language (quote their phrases), the one-line pitch, evidence_url and",
    "  evidence_note copied from the research, contact_name / contact_title / contact_source_url copied",
    "  from the research or null. A prospect with no sponsorship history ranks last and its note says",
    "  so; a partner-named prospect with none gets a proposed replacement in `note`.",
    "- One category, one sponsor per slot: three legal sponsors in one room compete and none renews.",
    "- THE AUDIENCE'S OWN INSTITUTIONS ARE NOT CASH SPONSORS. A bar association, a diversity",
    "  council, a foundation or a law school of this audience (NAMWOLF, LCLD, MCCA, the NBA, a bar",
    "  foundation) holds the LIST — rank it as IN_KIND with ask_usd 0 and a note 'co-host candidate:",
    "  holds the invite list', never in a cash slot. The first production packet asked three of",
    "  them for $12,000 each. Cash slots go to the companies that pay to reach the audience.",
    "- sponsor_thesis: what a sponsor is underwriting. Never access to members.",
    "",
    "THE PITCH — pitch_email: the cold email to the rank-1 CASH prospect's named contact — a person's",
    "name from the research; if none was found, address it to 'the partnerships team at <org>' and",
    "say in `note` that a person must be found first — in SEQUOIA TAYLOR's voice as a Managing Partner",
    "of West Peek Ventures: 120–180 words, first person, no flattery, the room in two lines, why them in",
    "their own strategic language, the slot and the number, one specific ask (a 20-minute call), her",
    "sign-off. A DRAFT for her to send; nothing is sent from the system.",
    "",
    "ALSO:",
    "- 4–8 seed questions, phrased the way this audience would actually ask them.",
    "- guest_ideas: KINDS of people — archetypes with an example PROFILE (\"a sixth-year litigation",
    "  associate at an AmLaw 50 firm who just made partner\"), never a named individual unless the",
    "  invite-list note names one from the firm's records. Leave person_id null.",
    "- risks: 3–5 things that could go wrong with THIS Room, one line each.",
    "- commitment_md: what saying \"keep\" commits the firm to — spend, whose time, which organisations",
    "  get approached in West Peek's name, by when. Plain, short, honest.",
    "- pushback: where you disagree with the brief and why (audience width, the named sponsor, the",
    "  money). Empty string if none.",
    "- concept_choice_md: why the chosen concept won, in 3–5 sentences, for the packet's cover.",
    "",
    'Return ONLY JSON:',
    JSON.stringify(
      {
        title: "The … Room",
        theme: "short theme",
        central_question: "the one question the evening is organised around",
        format: "SALON",
        target_min: 30,
        target_max: 40,
        audience: "who should be in the room",
        agenda_md: "markdown run of the evening",
        run_of_show: [{ time: "6:30 PM", minutes: 30, what: "Arrival, cocktails", who: "Sequoia Taylor (host) greets; Parker on the door" }],
        seed_questions: ["…"],
        guest_ideas: [{ description: "archetype — example profile", why: "…" }],
        venues: [
          {
            name: "…", city: "…", address: "…", capacity: 40, why_here: "…", room_minimum_usd: 5500,
            price_low_usd: 0, price_high_usd: 0, price_note: "…",
            booking_phone: null, booking_email: null, booking_url: null,
            source_url: "https://… (copied exactly from the candidate list)",
            estimate_low_usd: 0, estimate_high_usd: 0, estimate_basis: "the comp this rests on, with its source",
            is_fallback: false,
          },
        ],
        budget: [{ key: "food_beverage", low_usd: 0, high_usd: 0, basis: "$250/head × 40 incl. tax and 22% service" }],
        sponsorship: {
          slots: [{ tier: "PRESENTING", count: 1, ask_usd: 20000, gets: "…" }, { tier: "SUPPORTING", count: 2, ask_usd: 10000, gets: "…" }],
          exclusive_usd: 42000, exclusive_gets: "…", rationale: "why this many, at these prices, for this format",
        },
        sponsor_thesis: "…",
        sponsor_prospects: [
          {
            org_name: "…", category: "LEGAL", tier: "PRESENTING", ask_usd: 20000, rank: 1,
            fit_argument: "…", pitch: "…", evidence_url: "https://…", evidence_note: "…",
            contact_name: null, contact_title: null, contact_source_url: null, note: null,
          },
        ],
        pitch_email: { to: "Name, Title, Org", subject: "…", body: "…" },
        risks: ["…"],
        commitment_md: "…",
        pushback: "",
        concept_choice_md: "…",
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

function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

function jsonBody(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normaliseUrl(url: string): string {
  return url.trim().replace(/[.,;)\]]+$/, "").replace(/\/+$/, "").toLowerCase();
}

function tierOf(v: unknown, fallback: SponsorTier): SponsorTier {
  const t = str(v)?.toUpperCase();
  if (t === "TITLE" || t === "PRESENTING") return "PRESENTING";
  if (t === "SUPPORTING") return "SUPPORTING";
  if (t === "IN_KIND" || t === "IN-KIND" || t === "INKIND") return "IN_KIND";
  return fallback;
}

export function parseStructure(raw: unknown): SponsorshipStructure {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const slots: SponsorSlot[] = [];
  let total = 0;
  for (const s of Array.isArray(p.slots) ? (p.slots as Record<string, unknown>[]) : []) {
    const count = Math.max(1, Math.round(num(s.count) ?? 1));
    const askUsd = Math.max(0, num(s.ask_usd) ?? num(s.askUsd) ?? 0);
    if (askUsd === 0 && tierOf(s.tier, "SUPPORTING") !== "IN_KIND") continue;
    if (total + count > SPONSORSHIP_TARGET.maxSlots) break;
    total += count;
    slots.push({ tier: tierOf(s.tier, "SUPPORTING"), count, askUsd, gets: str(s.gets) ?? "" });
  }
  // Title first, then supporting, then in kind — the order they sell in.
  const order: Record<SponsorTier, number> = { PRESENTING: 0, SUPPORTING: 1, IN_KIND: 2 };
  slots.sort((a, b) => order[a.tier] - order[b.tier] || b.askUsd - a.askUsd);
  let exclusiveUsd = num(p.exclusive_usd) ?? num(p.exclusiveUsd);
  let rationale = str(p.rationale) ?? "";
  // EXCLUSIVITY IS WORTH MORE THAN THE SLOTS IT REPLACES. The first production packet priced the
  // exclusive at $42K against $48K of cash slots — a discount for owning the room. Raised to ten
  // percent above the cash slots, and the rationale says so, rather than shipping the contradiction.
  const cashSum = slots.filter((s) => s.tier !== "IN_KIND").reduce((t, s) => t + s.askUsd * s.count, 0);
  if (exclusiveUsd && exclusiveUsd > 0 && cashSum > 0 && exclusiveUsd < cashSum) {
    exclusiveUsd = Math.ceil((cashSum * 1.1) / 500) * 500;
    rationale = `${rationale} (Exclusive raised to $${exclusiveUsd.toLocaleString("en-US")}: Parker had priced it below the $${cashSum.toLocaleString("en-US")} the cash slots bring together, and owning the room cannot cost less than sharing it.)`.trim();
  }
  return {
    slots,
    exclusiveUsd: exclusiveUsd && exclusiveUsd > 0 ? exclusiveUsd : null,
    exclusiveGets: str(p.exclusive_gets) ?? str(p.exclusiveGets),
    rationale,
  };
}

/** The structure Parker falls back to when the model wrote none: one title, two supporting, at the reference. */
export function defaultStructure(): SponsorshipStructure {
  return {
    slots: [
      { tier: "PRESENTING", count: 1, askUsd: 20_000, gets: "the executive's six minutes in the run of show, the underwriting credit on every printed piece, the recap" },
      { tier: "SUPPORTING", count: 2, askUsd: SPONSORSHIP_TARGET.referencePerSponsorUsd, gets: "a seat at the table, the underwriting credit, the recap" },
    ],
    exclusiveUsd: null,
    exclusiveGets: null,
    rationale: "Parker wrote no structure; this is the firm's default shape — one title, two supporting — until he does.",
  };
}

export function parsePacket(raw: string): RoomPacket | null {
  const p = jsonBody(raw);
  if (!p) return null;

  const title = str(p.title);
  const theme = str(p.theme);
  if (!title || !theme) return null;

  const rawFormat = str(p.format)?.toUpperCase() ?? "DINNER";
  const format = (ROOM_FORMATS as readonly string[]).includes(rawFormat) ? (rawFormat as RoomFormat) : "DINNER";

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
    const roomMin = num(v.room_minimum_usd);
    // NEVER $0. A published price is the estimate; a model estimate is kept with its basis; and a
    // venue with neither gets the room-size comp below, labelled as such, rather than a blank.
    const estimate = estimateVenueCost({ priceLow, priceHigh, estLow: estLow ?? roomMin, estHigh: estHigh ?? roomMin, basis: str(v.estimate_basis), city: str(v.city), capacity: num(v.capacity) });
    venues.push({
      name,
      city: str(v.city),
      address: str(v.address),
      capacity: num(v.capacity),
      priceLowUsd: priceLow,
      priceHighUsd: priceHigh,
      priceNote: str(v.price_note),
      bookingPhone: str(v.booking_phone),
      bookingEmail: str(v.booking_email),
      bookingUrl: str(v.booking_url),
      sourceUrl,
      estimateLowUsd: estimate.low,
      estimateHighUsd: estimate.high,
      estimateBasis: estimate.basis,
      whyHere: str(v.why_here),
      roomMinimumUsd: roomMin && roomMin > 0 ? roomMin : null,
      isFallback: v.is_fallback === true,
    });
  }
  // One fallback at most, and only when there is a first choice to fall back from.
  let seenFallback = false;
  for (const v of venues) {
    if (v.isFallback && (seenFallback || venues.length === 1)) v.isFallback = false;
    if (v.isFallback) seenFallback = true;
  }

  const budgetLines: RoomPacket["budgetLines"] = [];
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
    // person_id is never taken from the model. It cannot know our ids.
    guestIdeas.push({ description, personId: null, why: str(g.why) });
  }

  const runOfShow: RunOfShowLine[] = [];
  for (const r of Array.isArray(p.run_of_show) ? (p.run_of_show as Record<string, unknown>[]) : []) {
    const time = str(r.time);
    const what = str(r.what);
    if (!time || !what) continue;
    runOfShow.push({ time, minutes: Math.max(0, Math.round(num(r.minutes) ?? 0)), what, who: str(r.who) ?? "" });
  }

  const seedQuestions = (Array.isArray(p.seed_questions) ? p.seed_questions : []).map((q) => str(q)).filter((q): q is string => q !== null);

  const targetMin = num(p.target_min) ?? 25;
  const targetMax = num(p.target_max) ?? 35;

  const structure = p.sponsorship ? parseStructure(p.sponsorship) : defaultStructure();
  if (structure.slots.length === 0) structure.slots = defaultStructure().slots;

  const sponsorProspects: SponsorProspectIdea[] = [];
  for (const sp of Array.isArray(p.sponsor_prospects) ? (p.sponsor_prospects as Record<string, unknown>[]) : []) {
    const orgName = str(sp.org_name);
    if (!orgName) continue;
    if (sponsorProspects.some((x) => sameOrg(x.orgName, orgName))) continue;
    const rawCat = str(sp.category)?.toUpperCase() ?? "OTHER";
    const category = (SPONSOR_CATEGORIES as readonly string[]).includes(rawCat) ? (rawCat as SponsorCategory) : "OTHER";
    const rawContact = str(sp.contact_name);
    const contactName = rawContact && looksLikePersonName(rawContact) ? rawContact : null;
    sponsorProspects.push({
      orgName,
      category,
      tier: tierOf(sp.tier, sponsorProspects.length === 0 ? "PRESENTING" : "SUPPORTING"),
      askUsd: num(sp.ask_usd) ?? SPONSORSHIP_TARGET.referencePerSponsorUsd,
      rank: Math.max(1, Math.round(num(sp.rank) ?? sponsorProspects.length + 1)),
      fitArgument: str(sp.fit_argument) ?? str(sp.why_fit),
      pitch: str(sp.pitch),
      evidenceUrl: httpUrl(sp.evidence_url) ?? httpUrl(sp.source_url),
      evidenceNote: str(sp.evidence_note),
      contactName,
      contactTitle: contactName ? str(sp.contact_title) : null,
      contactSourceUrl: contactName ? httpUrl(sp.contact_source_url) : null,
      fromBrief: false,
      note: str(sp.note),
    });
  }
  sponsorProspects.sort((a, b) => a.rank - b.rank);
  sponsorProspects.forEach((s, i) => { s.rank = i + 1; });

  const risks = (Array.isArray(p.risks) ? p.risks : []).map((r) => str(r)).filter((r): r is string => r !== null);

  const pe = (p.pitch_email && typeof p.pitch_email === "object" ? p.pitch_email : null) as Record<string, unknown> | null;
  const pitchEmail = pe && str(pe.body) ? { to: str(pe.to) ?? "", subject: str(pe.subject) ?? "", body: str(pe.body)! } : null;

  return {
    title,
    theme,
    centralQuestion: str(p.central_question),
    format,
    targetMin,
    targetMax,
    audience: str(p.audience),
    agendaMd: str(p.agenda_md) ?? (runOfShow.length ? runOfShow.map((l) => `- ${l.time} · ${l.what}${l.who ? ` — ${l.who}` : ""}`).join("\n") : null),
    runOfShow,
    seedQuestions,
    guestIdeas,
    venues,
    sponsorThesis: str(p.sponsor_thesis),
    economics: null,
    structure,
    sponsorCount: structure.slots.reduce((t, s) => t + s.count, 0),
    sponsorProspects,
    risks,
    commitmentMd: str(p.commitment_md),
    budgetLines,
    pushback: str(p.pushback),
    conceptChoiceMd: str(p.concept_choice_md),
    pitchEmail,
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
 * The partner's named prospects are SEEDS and never lost.
 *
 * A seed she typed that the packet left out is added, ranked LAST, with a note saying Parker found
 * no sponsorship history for it (or did not research it) — so the page shows her name with the
 * honest finding beside it rather than silently forgetting the one name she cared about.
 */
export function mergeBriefSponsors(packet: RoomPacket, brief: RoomBrief | null | undefined, research: readonly SponsorResearch[] = []): RoomPacket {
  if (!brief || brief.sponsorProspects.length === 0) return packet;
  const merged = packet.sponsorProspects.map((s) => ({ ...s }));
  for (const named of brief.sponsorProspects) {
    const hit = merged.find((s) => sameOrg(s.orgName, named));
    if (hit) {
      hit.fromBrief = true;
      continue;
    }
    const r = research.find((x) => sameOrg(x.orgName, named));
    merged.push({
      orgName: named,
      category: r?.category ?? "OTHER",
      tier: "SUPPORTING",
      askUsd: SPONSORSHIP_TARGET.referencePerSponsorUsd,
      rank: merged.length + 1,
      fitArgument: null,
      pitch: null,
      evidenceUrl: r?.evidence[0]?.url ?? null,
      evidenceNote: r?.evidence[0]?.note ?? null,
      contactName: r?.contact?.name ?? null,
      contactTitle: r?.contact?.title ?? null,
      contactSourceUrl: r?.contact?.sourceUrl ?? null,
      fromBrief: true,
      note: r
        ? r.hasSponsorshipHistory
          ? "Named by the partner; Parker's packet left it out of the ranking — decide whether it belongs."
          : "Named by the partner. No sponsorship history was found on any public page; Parker proposes approaching it last, if at all."
        : "Named by the partner; not researched in this build.",
    });
  }
  merged.sort((a, b) => a.rank - b.rank);
  merged.forEach((s, i) => { s.rank = i + 1; });
  return { ...packet, sponsorProspects: merged };
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Check a parsed packet against the sources it was given.
 *
 * Venues: dropped when their source is not among the search results. Sponsors: an evidence URL is
 * kept only if the research stage verified it (or the search returned it); a contact is kept only
 * if the research read that name off that page. Everything else survives with a flag, because a
 * name is a lead a person can check and an invented citation is worse than none.
 */
export function verifyPacket(
  packet: RoomPacket,
  allowedUrls: readonly string[],
  research: readonly SponsorResearch[] = [],
): { packet: RoomPacket; flags: PacketFlag[] } {
  const flags: PacketFlag[] = [];
  const allowed = new Set(allowedUrls.map(normaliseUrl));
  const inAllowed = (u: string) => {
    const source = normaliseUrl(u);
    return allowed.has(source) || [...allowed].some((a) => source.startsWith(a) || a.startsWith(source));
  };

  const kept: PacketVenue[] = [];
  for (const venue of packet.venues) {
    // An empty allow-list means no live search ran; fall back to requiring a URL and nothing more,
    // rather than dropping everything and returning a packet with no venues at all.
    if (allowed.size > 0 && !inAllowed(venue.sourceUrl)) {
      flags.push({ code: "invented_url", detail: `${venue.name}: source ${venue.sourceUrl} was not among the search results — dropped` });
      continue;
    }
    kept.push(venue);
  }
  if (kept.length === 0) {
    flags.push({ code: "no_venues", detail: "No venue survived sourcing. The Room is proposable but a person must find the space." });
  }
  for (const venue of kept) {
    if ((venue.bookingPhone || venue.bookingEmail) && !venue.bookingUrl) {
      flags.push({ code: "contact_without_source", detail: `${venue.name}: contact details are UNVERIFIED — confirm by phone before relying on them` });
    }
  }

  const sponsorProspects = packet.sponsorProspects.map((sp) => {
    const r = research.find((x) => sameOrg(x.orgName, sp.orgName));
    let out = { ...sp };
    // EVIDENCE: only a URL the research verified (it answered) or the search returned.
    if (out.evidenceUrl) {
      const verified = (r?.evidence ?? []).some((e) => normaliseUrl(e.url) === normaliseUrl(out.evidenceUrl!)) || (allowed.size > 0 && inAllowed(out.evidenceUrl));
      if (!verified) {
        flags.push({ code: "invented_url", detail: `${sp.orgName}: evidence ${out.evidenceUrl} was not verified by research — citation removed, prospect kept` });
        out = { ...out, evidenceUrl: r?.evidence[0]?.url ?? null, evidenceNote: r?.evidence[0]?.note ?? null };
      }
    } else if (r?.evidence[0]) {
      out = { ...out, evidenceUrl: r.evidence[0].url, evidenceNote: out.evidenceNote ?? r.evidence[0].note };
    }
    if (!out.evidenceUrl) {
      flags.push({ code: "sponsor_without_evidence", detail: `${sp.orgName}: no cited sponsorship history — not a qualified prospect until a person finds one` });
    }
    // CONTACT: only the name the research read off a page. Anything else is a guess.
    if (out.contactName) {
      const ok = r?.contact && r.contact.name.toLowerCase() === out.contactName.toLowerCase();
      out = ok
        ? { ...out, contactTitle: out.contactTitle ?? r!.contact!.title, contactSourceUrl: r!.contact!.sourceUrl }
        : { ...out, contactName: r?.contact?.name ?? null, contactTitle: r?.contact?.title ?? null, contactSourceUrl: r?.contact?.sourceUrl ?? null };
      if (!ok) flags.push({ code: "contact_without_source", detail: `${sp.orgName}: the contact named was not read off a fetched page — ${r?.contact ? `replaced with ${r.contact.name}` : "removed"}` });
    } else if (r?.contact) {
      out = { ...out, contactName: r.contact.name, contactTitle: r.contact.title, contactSourceUrl: r.contact.sourceUrl };
    }
    return out;
  });
  // Evidence first: an unevidenced prospect ranks below every evidenced one, whatever the model said.
  sponsorProspects.sort((a, b) => Number(Boolean(b.evidenceUrl)) - Number(Boolean(a.evidenceUrl)) || a.rank - b.rank);
  sponsorProspects.forEach((s, i) => { s.rank = i + 1; });

  if (sponsorProspects.length === 0) {
    flags.push({ code: "no_sponsor_prospects", detail: "No sponsor prospect was named, so nobody can be approached for the money." });
  }
  if (packet.seedQuestions.length < 3) {
    flags.push({ code: "no_seed_questions", detail: "Fewer than three seed questions — the room will not start itself." });
  }
  if (!packet.sponsorThesis) {
    flags.push({ code: "no_sponsor_thesis", detail: "No sponsor thesis, so this Room has no funding story." });
  }
  if (packet.runOfShow.length < 5) {
    flags.push({ code: "no_run_of_show", detail: "The run of show has fewer than five lines — it is not to the minute." });
  }
  if (packet.targetMin < 8 || packet.targetMax > 80 || packet.targetMin > packet.targetMax) {
    flags.push({ code: "target_out_of_range", detail: `Target ${packet.targetMin}–${packet.targetMax} is outside what a Room can hold as a conversation.` });
  }

  return { packet: { ...packet, venues: kept, sponsorProspects }, flags };
}

// ── Economics ────────────────────────────────────────────────────────────────

/**
 * Per-Room economics. Not firm accounting — the question is only whether this Room pays for itself
 * AND returns the firm's keep, and how many sponsors have to say yes before it does.
 */
export function computeEconomics(input: {
  venues: readonly PacketVenue[];
  targetAttendees: number;
  foodPerHeadUsd?: number;
  /** The structure the packet proposes; the scenarios sell its slots in order (title first). */
  structure?: SponsorshipStructure;
  /** Parker's lines. Anything missing is filled from the rules of thumb below and labelled so. */
  budgetLines?: readonly { key: BudgetKey; lowUsd: number; highUsd: number; basis: string }[];
  keepTargetUsd?: number;
}): RoomEconomics {
  const lows = input.venues.map((v) => v.estimateLowUsd);
  const highs = input.venues.map((v) => v.estimateHighUsd);
  const venueLowUsd = lows.length ? Math.min(...lows) : 0;
  const venueHighUsd = highs.length ? Math.max(...highs) : 0;

  const foodPerHeadUsd = input.foodPerHeadUsd ?? 150;
  const targetAttendees = input.targetAttendees;
  const n = Math.max(targetAttendees, 1);

  /*
   * THE FULL BUDGET, "from the POV of a senior event designer and coordinator". Parker's lines win
   * where he wrote them; each rule of thumb below fills a line he left out, and says so in its
   * basis, so a partner can tell an estimate from a guess.
   */
  const given = new Map((input.budgetLines ?? []).map((l) => [l.key, l]));
  const defaults: Record<BudgetKey, { low: number; high: number; basis: string }> = {
    venue: venueLowUsd > 0
      ? { low: venueLowUsd, high: venueHighUsd, basis: "cheapest to dearest sourced venue estimate" }
      : { low: VENUE_COMP.perHeadLowUsd * n, high: VENUE_COMP.perHeadHighUsd * n, basis: `rule of thumb: $${VENUE_COMP.perHeadLowUsd}–${VENUE_COMP.perHeadHighUsd}/head private-room minimum × ${n} — no venue was priced` },
    food_beverage: { low: foodPerHeadUsd * n, high: Math.round(foodPerHeadUsd * 1.6) * n, basis: `$${foodPerHeadUsd}–${Math.round(foodPerHeadUsd * 1.6)}/head food and drink incl. tax and service × ${n} (rule of thumb; often inside the venue minimum)` },
    av_production: { low: 1200, high: 3500, basis: "rule of thumb: mics, a speaker, a screen and an operator for a room of this size" },
    entertainment_programming: { low: 0, high: 2500, basis: "rule of thumb: none, or one performer or facilitated segment" },
    speakers_hosts: { low: 0, high: 3000, basis: "rule of thumb: one honorarium at most; the hosts and most guests speak for free" },
    design_print_decor: { low: 800, high: 2500, basis: "rule of thumb: invitations, place cards, menus, one branded piece, table decor" },
    gifting: { low: 800, high: 2500, basis: "rule of thumb: one takeaway per guest at $20–60 × headcount" },
    photo_video: { low: 1000, high: 3000, basis: "rule of thumb: one photographer for the evening; video at the top of the range" },
    staffing: { low: 600, high: 1800, basis: "rule of thumb: a coordinator and one runner on the night" },
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

  const keepTargetUsd = input.keepTargetUsd ?? SPONSORSHIP_TARGET.keepUsd;
  const requiredUsd = estimatedCostHighUsd + keepTargetUsd;
  const structure = input.structure && input.structure.slots.length > 0 ? input.structure : defaultStructure();

  // Sell the slots in order — title first — and show what is left after each one lands. The
  // partner's question is not "does it pay" but "how many have to say yes before it does".
  const sold: Array<{ tier: SponsorTier; askUsd: number }> = [];
  for (const s of structure.slots) for (let i = 0; i < s.count; i++) sold.push({ tier: s.tier, askUsd: s.askUsd });
  const scenarios: SponsorScenario[] = [];
  // IN KIND IS NOT CASH. An in-kind partner lowers a cost line; it never lands in the firm's
  // account. The first production packet counted a $4K in-kind slot toward the keep. Cash slots
  // add to sponsorship; in-kind adds to what is left, and the description says which.
  let cash = 0;
  let offset = 0;
  const tally: Record<SponsorTier, number> = { PRESENTING: 0, SUPPORTING: 0, IN_KIND: 0 };
  sold.forEach((s, i) => {
    if (s.tier === "IN_KIND") offset += s.askUsd; else cash += s.askUsd;
    tally[s.tier] += 1;
    const description = (["PRESENTING", "SUPPORTING", "IN_KIND"] as SponsorTier[])
      .filter((t) => tally[t] > 0)
      .map((t) => `${tally[t]} ${t === "PRESENTING" ? "title" : t === "SUPPORTING" ? "supporting" : `in-kind (offsets $${offset.toLocaleString("en-US")} of cost)`}`)
      .join(" + ");
    scenarios.push({ sponsors: i + 1, description, sponsorshipUsd: cash, netLowUsd: cash + offset - estimatedCostHighUsd, netHighUsd: cash + offset - estimatedCostLowUsd });
  });
  const sponsorCount = sold.length;
  const sponsorTargetHighUsd = cash;
  const sponsorTargetLowUsd = sold.find((s) => s.tier !== "IN_KIND")?.askUsd ?? 0;
  const exclusiveScenario: SponsorScenario | null = structure.exclusiveUsd
    ? { sponsors: 1, description: "one exclusive sponsor", sponsorshipUsd: structure.exclusiveUsd, netLowUsd: structure.exclusiveUsd - estimatedCostHighUsd, netHighUsd: structure.exclusiveUsd - estimatedCostLowUsd }
    : null;

  return {
    venueLowUsd,
    venueHighUsd,
    foodPerHeadUsd,
    targetAttendees,
    lines,
    estimatedCostLowUsd,
    estimatedCostHighUsd,
    keepTargetUsd,
    requiredUsd,
    structure,
    sponsorTargetHighUsd,
    sponsorTargetLowUsd,
    sponsorCount,
    scenarios,
    exclusiveScenario,
    // Worst case against best case: low revenue with high cost, high revenue with low cost.
    netLowUsd: sponsorTargetLowUsd - estimatedCostHighUsd,
    netHighUsd: sponsorTargetHighUsd + offset - estimatedCostLowUsd,
    reachesKeep: sponsorTargetHighUsd + offset >= requiredUsd,
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

// ── The invite-list reality check ────────────────────────────────────────────

/**
 * Which words in the firm's records mean "this person is one of the audience". The audience text
 * picks the vocabulary: a room of lawyers matches legal roles; a room of founders matches founders
 * and operators; anything else falls back to the whole community. Pure, so the worker's SQL is
 * built from a list that can be tested.
 */
export function audienceTerms(audience: string | null | undefined): { label: string; terms: string[] } {
  const a = (audience ?? "").toLowerCase();
  if (/\b(lawyer|attorney|counsel|legal|law firm|partner track|associate|gc\b|general counsel)/.test(a)) {
    return { label: "lawyers and legal roles", terms: ["lawyer", "attorney", "counsel", "legal", "law firm", " llp", "esq", "paralegal", "law school", "j.d."] };
  }
  if (/\b(investor|lp\b|limited partner|allocator|family office)/.test(a)) {
    return { label: "investors and allocators", terms: ["investor", "family office", "allocator", "limited partner", "fund"] };
  }
  if (/\b(founder|operator|ceo|startup|start-up)/.test(a)) {
    return { label: "founders and operators", terms: ["founder", "operator", "ceo", "co-founder", "cofounder", "startup"] };
  }
  return { label: "the community at large", terms: [] };
}

/**
 * The count as a starting list. It never vetoes a Room: the records under-read job functions (a
 * survey is owed) and the partners' network is larger than the community — Sequoia, 16 Sep 2026.
 */
export function inviteVerdict(matching: number, targetMax: number): { verdict: InviteCheck["verdict"]; note: string } {
  // A room fills at roughly one accept in three invitations; the number is for planning the ask, not for judging the Room.
  const needed = targetMax * 3;
  return {
    verdict: "STARTING_LIST",
    note: `${matching} contact(s) in the community records read as this audience, against ~${needed} invitations for ${targetMax} seats. This is a starting list, not a ceiling: job functions in the community have not been surveyed yet, and the partners' broader network is larger than the community snapshot. The partners fill the room from that network; do not widen the audience, decline, or push back on the Room because of this number.`,
  };
}
