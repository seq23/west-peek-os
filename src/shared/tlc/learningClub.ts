import { PARTNERS } from "../registry/partners";
import { fillTemplate } from "./brandFlow";
/**
 * WEST PEEK ROOMS — THE LEARNING CLUB (TLC) EDITION. Owner-approved 22 Oct 2026.
 *
 * In-person learning clubs: 25–40 people deep-diving ONE topic, in New York City only, one event a
 * month, the first in January 2027, selling from early November 2026. Paid for by brand sponsors;
 * every attendee buys a $10 ticket (owner, 22 Oct 2026: "proof to sponsors of real intent and
 * spending"). This file is the whole rulebook as code — the money rule, the go-ahead rule, the
 * drip, the deal stages, the booking pack, the escalation email, the one-pager — so a test can read
 * every rule and no prose document governs anything on its own.
 *
 * PURE. No database, no network. `services/learningClub.ts` is the worker half.
 *
 * TWO PEOPLE CARRY IT:
 *   Parker (Event Marketing Coordinator) — the topics, rolling three ahead, and the booking pack.
 *   Wynn (TLC Sales & Partnerships, un-retired 22 Oct 2026) — the trend story, the brand drip,
 *   the deals, the decision emails, the agreement and the invoice note.
 *
 * THE HARD RULES (each one is enforced below or in the worker, and `validate:tlc` reads them):
 *   1. AGENTS NEVER SPEND MONEY. Hosts, venues, food, materials and photographers are OPTIONS sent
 *      to the partners, who book and pay. Money IN (tickets, sponsor invoices) is fine.
 *   2. NOTHING SENDS TO A BRAND until the owner has approved the one-pager mock AND the sales
 *      playbook, and the brand-send switch (`tlc_setting.brand_send`, default 'off') is on, and the
 *      platform's external-email switch is on. Every send is still an approved external effect.
 *   3. SPONSOR NAMES AND AMOUNTS LIVE ONLY IN THE DATABASE, never in this public repository.
 *   4. VOICE: "we"; no inflated claims; no invented facts; no fake case studies.
 */

// ── The numbers ─────────────────────────────────────────────────────────────────────────────────

export const TLC_CITY = "New York City";
export const TLC_SEATS = { min: 25, max: 40 } as const;
/**
 * THE ROOM IS SIZED TO THE SPONSORS (owner, 22 Oct 2026). 25–40 is the DEFAULT; the partners set
 * each club's own size on the event (60, 100, 150…), and everything that speaks of the room reads
 * the event's value: the drip, both one-pagers, the booking pack, the ticket cap and the go-check.
 */
export type Seats = { min: number; max: number };
export function seatsOf(ev: { seats_min?: number | null; seats_max?: number | null } | null | undefined): Seats {
  const min = ev?.seats_min && ev.seats_min > 0 ? ev.seats_min : TLC_SEATS.min;
  const max = ev?.seats_max && ev.seats_max >= min ? ev.seats_max : Math.max(min, TLC_SEATS.max);
  return { min, max };
}
export const seatsWords = (s: Seats): string => (s.min === s.max ? `${s.min}` : `${s.min}–${s.max}`);
/** Every attendee pays to be there. $10, never more (owner, 22 Oct 2026). */
export const TLC_TICKET_PRICE_USD = 10;
export const TLC_TICKET_PRICE_MAX_USD = 10;
/**
 * The processing fee assumed on each ticket until the payment tool reports the real one: the
 * common card rate (2.9% + $0.30). A ticket row carries its own fee when the payment tool gives
 * one, and that number wins.
 */
export const TLC_TICKET_FEE = { percent: 0.029, fixedUsd: 0.3 } as const;
/**
 * THE MONEY PER CLUB (owner's ruling, 22 Oct 2026, replacing the $5,000 cost cap): raise $25,000
 * from sponsors, spend up to $15,000 (venue, food, decor, materials), net $10,000. An in-kind venue
 * or product lowers cost; it is never part of the $25,000. Sponsor amounts and counts are never
 * capped. The $7,500 floor stays as the ESCALATION line: under it at a go-check, Sequoia hears.
 */
export const TLC_NET_TARGET_USD = 10_000;
/** The escalation line: sponsor net under $7,500 at a go-check escalates. */
export const TLC_NET_FLOOR_USD = 7_500;
export const TLC_SPONSOR_GOAL_USD = 25_000;
export const TLC_COST_BUDGET_USD = 15_000;
/** @deprecated name kept for readers; it is the $15,000 cost budget now. */
export const TLC_COST_CAP_USD = TLC_COST_BUDGET_USD;
export const TLC_FIRST_MONTH = "2027-01";
export const TLC_TOPICS_AHEAD = 3;
/** Days before the event the go-ahead is checked. */
export const TLC_GO_CHECK_DAYS = [21, 14] as const;
/** The paid-ticket gate is checked at the 2-weeks-out point. */
export const TLC_TICKET_GATE_DAYS = 14;
/** The booking pack goes to the partners ~6 weeks out; a topic with no interested brand is flagged then. */
export const TLC_BOOKING_PACK_DAYS = 42;
/** Brand emails: the first pitch, and ONE follow-up four days later (her flow, 26 Oct 2026: "After this, no more follow-ups"). */
export const TLC_DRIP_DAYS = [0, 4] as const;
export const TLC_SPONSOR_CATEGORIES = { min: 5, max: 10 } as const;

/**
 * WHAT A BRAND PAYS (owner's rulings, 22 Oct 2026). Partner $5,000; Lead partner $10,000; Presenting
 * partner $15,000 ("Presented by" billing and top placement); Product partner, in kind: product for
 * the night instead of cash (its value is cost relief, NEVER counted toward the $25,000). A deal may
 * also carry any custom amount; neither the size nor the number of partners is capped. There is NO
 * category exclusivity: no copy, prompt or agreement may promise one.
 */
export const TLC_TIERS = {
  TITLE: { label: "Title partner", priceUsd: 25_000 as number | null, gets: 'One brand funds the whole room, and the club carries its name: "The Learning Club, presented by" your brand, on the pitch, the invitation, the signage and the recap. The only cash partner that night.' },
  PARTNER: { label: "Partner", priceUsd: 5_000 as number | null, gets: "The standard partnership, for most brands." },
  LEAD: { label: "Lead partner", priceUsd: 10_000 as number | null, gets: "A larger role on the day and first placement among the partners." },
  PRESENTING: { label: "Presenting partner", priceUsd: 15_000 as number | null, gets: '"Presented by" billing and top placement on the invitation and on the day.' },
  PRODUCT: { label: "Product partner (in kind)", priceUsd: null as number | null, gets: "For product brands: you supply product for the night instead of cash." },
} as const;
export type TlcTier = keyof typeof TLC_TIERS;
/** Listed in this order everywhere: the Title partner first. */
export const TLC_TIER_KEYS: readonly TlcTier[] = ["TITLE", "PARTNER", "LEAD", "PRESENTING", "PRODUCT"];
/** Tiers that bring cash toward the goal. */
export const TLC_CASH_TIERS: readonly TlcTier[] = ["TITLE", "PARTNER", "LEAD", "PRESENTING"];
/**
 * THE TITLE PARTNER IS THE ONLY CASH SPONSOR THAT NIGHT (owner, 22 Oct 2026). Not a general
 * exclusivity policy: it follows only from one brand buying the whole room. In-kind product partners
 * only with the title partner's OK. Returns why a deal may not be agreed, or null.
 */
export function titleConflict(agreed: ReadonlyArray<{ id: string; tier: string | null }>, candidate: { id: string; tier: string | null }): string | null {
  const others = agreed.filter((d) => d.id !== candidate.id);
  const otherCash = others.filter((d) => d.tier !== "PRODUCT");
  if (candidate.tier === "TITLE" && otherCash.length) return "a Title partner is the only cash partner that night, and another cash partner is already agreed";
  if (candidate.tier !== "PRODUCT" && others.some((d) => d.tier === "TITLE")) return "this club has a Title partner, the only cash partner that night";
  return null;
}
export function isTlcTier(v: unknown): v is TlcTier {
  return typeof v === "string" && (TLC_TIER_KEYS as readonly string[]).includes(v);
}
/** Cash a tier brings toward the $25,000 goal; a product partner brings none (cost relief only). */
export function tierCashUsd(tier: TlcTier | null | undefined): number {
  return tier ? TLC_TIERS[tier].priceUsd ?? 0 : TLC_TIERS.PARTNER.priceUsd!;
}
/** The cash a club needs from sponsors: $25,000 (= $15,000 cost budget + $10,000 net). */
export const TLC_SPONSOR_CASH_TARGET_USD = TLC_SPONSOR_GOAL_USD;
export const TLC_PARTNERS_TO_TARGET = Math.ceil(TLC_SPONSOR_GOAL_USD / TLC_TIERS.PARTNER.priceUsd!);
const k = (n: number): string => `$${n.toLocaleString("en-US")}`;
export const TLC_TARGET_PATH = `Raise ${k(TLC_SPONSOR_GOAL_USD)} from sponsors, spend up to ${k(TLC_COST_BUDGET_USD)}, net ${k(TLC_NET_TARGET_USD)}. Two routes: one Title partner at ${k(TLC_TIERS.TITLE.priceUsd!)}; or a mix: at least ${TLC_PARTNERS_TO_TARGET} partners at ${k(TLC_TIERS.PARTNER.priceUsd!)}, or larger sponsors at ${k(TLC_TIERS.LEAD.priceUsd!)}–${k(TLC_TIERS.PRESENTING.priceUsd!)}, or any mix that reaches ${k(TLC_SPONSOR_GOAL_USD)}. In-kind venue or product lowers cost and never counts toward it.`;
/** The season option (internal recommendation only): the same brand on all three months of a quarter. */
export function seasonOption(): string {
  const t = (x: TlcTier) => `${TLC_TIERS[x].label} ${k(3 * TLC_TIERS[x].priceUsd!)}`;
  return `Season (recommendation, never in the brand pitch): offer a brand that says yes to one month all three months of the quarter: ${t("PARTNER")}, ${t("LEAD")}, ${t("PRESENTING")}, or ${t("TITLE")} for the season.`;
}

/**
 * PACE (owner, 22 Oct 2026: escalate if committed dollars are behind pace). Before the 21- and
 * 14-day go-checks, two pace checks: by 60 days out at least 40% of the $25,000 goal is agreed
 * ($10,000), by 42 days out at least 60% ($15,000). Behind pace, Sequoia is told; nothing else moves.
 */
export const TLC_PACE_CHECKS: ReadonlyArray<{ daysOut: number; share: number }> = [
  { daysOut: 60, share: 0.4 },
  { daysOut: 42, share: 0.6 },
];
export function paceCheck(daysOut: number, committedCashUsd: number, goalUsd: number = TLC_SPONSOR_GOAL_USD): { checkpoint: number; neededUsd: number; behind: boolean } | null {
  const c = TLC_PACE_CHECKS.find((p) => p.daysOut === daysOut);
  if (!c) return null;
  const neededUsd = Math.round(goalUsd * c.share);
  return { checkpoint: c.daysOut, neededUsd, behind: committedCashUsd < neededUsd };
}

/** A club's own sponsor goal (the partners may change it on the event); its cost budget is that goal less the $10,000 net. */
export function goalOf(ev: { sponsor_goal_usd?: number | null } | null | undefined): { goalUsd: number; costBudgetUsd: number } {
  const goalUsd = ev?.sponsor_goal_usd && ev.sponsor_goal_usd > TLC_NET_TARGET_USD ? ev.sponsor_goal_usd : TLC_SPONSOR_GOAL_USD;
  return { goalUsd, costBudgetUsd: goalUsd - TLC_NET_TARGET_USD };
}

/**
 * SPONSORS IN A CLUB ARE COMPLEMENTARY, NEVER COMPETITORS (owner, 22 Oct 2026). A month's categories
 * are one of each kind of product that would compete; two categories in the same family (two drink
 * bases, two AI assistants, two fragrance houses…) are flagged on the internal one-pager. A category
 * may also name brands we must never approach for that month (`excluded_brands`: they compete with a
 * featured partner) and may be on the bench (offered only if the lead agrees).
 */
export interface TlcSponsorCategory {
  category: string;
  why: string;
  example_brands: readonly string[];
  /** Suggested tier for this slot (e.g. PRESENTING for a big wellness brand, PRODUCT for food). */
  tier?: TlcTier | null;
  /** On the bench: approached only if the lead partner agrees. */
  bench?: boolean;
  /** The AI partner slot every non-AI club carries; cash at any tier or in kind. */
  ai_partner?: boolean;
  /** A frontier-model company: one per club, first yes is seated. */
  frontier_model?: boolean;
  /** Brands never to approach this month (they compete with a featured partner). */
  excluded_brands?: readonly string[];
  /** A featured partner already in place for this slot (e.g. a startup giving product in kind). */
  featured?: string | null;
}
const FAMILIES: ReadonlyArray<[string, RegExp]> = [
  ["a drink base (spirit, beer or wine, with or without alcohol)", /zero[- ]proof spirit|non[- ]alcoholic (spirit|beer|wine)|\bNA (spirit|beer|wine)|dealcohol|alcohol[- ]free (spirit|beer|wine)|\bspirits?\b|aperitif|\bbeer\b|\bwine\b/i],
  ["an AI assistant", /\bAI assistant|chatbot|\bLLM\b/i],
  ["a fragrance house", /fragrance house|perfum/i],
  ["a coffee brand", /\bcoffee (brand|roaster)|espresso machine/i],
];
export function familyOf(category: string): string | null {
  return FAMILIES.find(([, re]) => re.test(category))?.[0] ?? null;
}
/** Pairs of non-bench categories in one month that would compete. [] when the month is complementary. */
export function competingCategories(cats: ReadonlyArray<Pick<TlcSponsorCategory, "category" | "bench">>): string[] {
  const out: string[] = [];
  const live = cats.filter((c) => !c.bench);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = familyOf(live[i]!.category);
      if (a && a === familyOf(live[j]!.category)) out.push(`"${live[i]!.category}" and "${live[j]!.category}" are both ${a}: they compete`);
    }
  }
  return out;
}

/**
 * TOPICS WE DO NOT RUN, AND SPONSORS THAT NEVER MIX (owner, 22 Oct 2026).
 *  - Peptides: do not run (FDA warning letters to research-use sellers; contested status in 2026).
 *  - Betting brands (sportsbooks, casinos) stay out of Q1 2027.
 *  - Prediction markets are NOT betting here (owner, 23 Oct 2026: "the rule about no prediction in q1 is
 *    stupid to me"): Kalshi, Polymarket and Robinhood may be pitched in any month, Q1 included, for
 *    investing or money topics (Money Reset).
 *  - Betting and trading brands never share an event.
 */
export const TLC_DO_NOT_RUN: ReadonlyArray<{ match: RegExp; why: string }> = [
  { match: /peptide/i, why: "Do not run: FDA warning letters to research-use peptide sellers, and a contested status in 2026." },
];
export function doNotRun(topic: string): string | null {
  return TLC_DO_NOT_RUN.find((d) => d.match.test(topic))?.why ?? null;
}
const PEPTIDE_SELLER = /peptide/i;
const BETTING = /sportsbook|sports betting|\bbetting\b|casino|gambling|draftkings|fanduel|betmgm/i;
const TRADING = /\btrading\b|brokerage|\bbroker\b|investing app|stock app|\bcrypto exchange/i;
/** The last month of Q1 2027: two months after the first club. */
export const TLC_NO_BETTING_THROUGH = addMonths(TLC_FIRST_MONTH, 2);
/** Why a month's sponsor mix may not stand, or [] (betting in Q1 2027; betting beside trading). */
export function sponsorMixProblems(month: string, categories: ReadonlyArray<{ category: string; bench?: boolean }>): string[] {
  const live = categories.filter((c) => !c.bench);
  const betting = live.filter((c) => BETTING.test(c.category));
  const trading = live.filter((c) => TRADING.test(c.category));
  const out: string[] = [];
  const peptide = live.find((c) => PEPTIDE_SELLER.test(c.category));
  if (peptide) out.push(`no peptide sellers as sponsors ("${peptide.category}")`);
  if (betting.length && month <= TLC_NO_BETTING_THROUGH) out.push(`betting brands stay out of Q1 2027 ("${betting[0]!.category}")`);
  if (betting.length && trading.length) out.push(`betting and trading brands never share an event ("${betting[0]!.category}" and "${trading[0]!.category}")`);
  return out;
}
export function isBettingCategory(category: string): boolean {
  return BETTING.test(category);
}

/**
 * EVERY CLUB HAS AN AI ANGLE (owner, 22 Oct 2026). A topic that is not explicitly about AI must
 * carry (a) one AI segment in its run of show (`packet.ai_segment`) and (b) an "AI partner" sponsor
 * category (`ai_partner: true`). The AI partner may pay cash at any tier, or give in kind (credits
 * or subscriptions for every attendee, an expert who runs the segment, or both): in-kind value is
 * cost relief, never toward the cash goal. ONE frontier-model company per club: pitch more than one,
 * seat whoever says yes first (`frontier_model: true` on the category; see `frontierConflict`).
 */
export function isAiTopic(topic: string): boolean {
  return /\bAI\b|\bagents?\b|automation/i.test(topic);
}
export function aiRuleProblems(topic: string, packet: { ai_segment?: unknown } | null | undefined, categories: ReadonlyArray<{ category: string; ai_partner?: boolean }>): string[] {
  if (isAiTopic(topic)) return [];
  const out: string[] = [];
  if (!(typeof packet?.ai_segment === "string" && packet.ai_segment.trim())) out.push(`"${topic}" is not an AI topic, so its run of show needs one AI segment`);
  if (!categories.some((c) => c.ai_partner)) out.push(`"${topic}" is not an AI topic, so it needs an "AI partner" sponsor category`);
  return out;
}
/** A second frontier-model company may not say yes to a club that already has one. */
export function frontierConflict(yesDeals: ReadonlyArray<{ id: string; frontier: boolean }>, candidate: { id: string; frontier: boolean }): string | null {
  if (!candidate.frontier) return null;
  return yesDeals.some((d) => d.frontier && d.id !== candidate.id) ? "one frontier-model company per club: another already said yes" : null;
}

/**
 * WHEN AN IDEA MAY BE A PRIMARY (owner, 22 Oct 2026). Every club must raise $25,000, so:
 *  - an idea with an `earliest_month` waits for that month (hands-on ideas with a designed AI
 *    angle: from April 2027, chosen on their merits like any alternative);
 *  - a topic that is NOT about AI and carries NO designed AI angle may be a primary only after at
 *    least 6 TLC clubs have each raised $25,000 in cash. Even then its slate must reach $25,000.
 */
/** Owner correction, 22 Oct 2026: six clubs, each with $25,000 raised in cash, before a no-AI-angle topic may be a primary. */
export const TLC_FUNDED_EVENTS_BEFORE_NON_AI = 6;
export function hasAiAngle(packet: { ai_angle?: unknown; ai_segment?: unknown } | null | undefined): boolean {
  return [packet?.ai_angle, packet?.ai_segment].some((x) => typeof x === "string" && x.trim().length > 0);
}
export function ideaEligibility(
  idea: { topic: string; earliest_month?: string | null; packet?: { ai_angle?: unknown; ai_segment?: unknown } | null },
  month: string,
  fundedEvents: number,
): { eligible: boolean; why: string | null } {
  if (idea.earliest_month && month < idea.earliest_month) return { eligible: false, why: `not before ${idea.earliest_month}` };
  if (!isAiTopic(idea.topic) && !hasAiAngle(idea.packet) && fundedEvents < TLC_FUNDED_EVENTS_BEFORE_NON_AI) {
    return { eligible: false, why: `no AI angle: waits until ${TLC_FUNDED_EVENTS_BEFORE_NON_AI} clubs have each raised $${TLC_SPONSOR_GOAL_USD.toLocaleString("en-US")} (${fundedEvents} so far)` };
  }
  return { eligible: true, why: null };
}

/**
 * EVERY MONTH HAS A PRIMARY AND A BACKUP TOPIC, WITH A DATED SWITCH (owner, 22 Oct 2026). One
 * mechanism for every month: `tlc_event.backup_json` holds the backup club (topic, angle, packet,
 * categories, room size) and `tlc_event.switch_deadline` the date. On that date, if fewer than 2
 * cash sponsors and no Title partner have said yes, the backup takes over automatically and the
 * owner (only) is told what switched and why. A go-check, never a question. Wynn sells the primary
 * first; the brand pitch shows only the primary. The backup names sponsors, so it lives only in the
 * database.
 */
export const TLC_SWITCH_MIN_CASH_YES = 2;
export interface TlcBackup {
  topic: string;
  angle: string;
  packet: Record<string, unknown>;
  categories: readonly TlcSponsorCategory[];
  seats_min?: number;
  seats_max?: number;
  applied_at?: string | null;
  kept_at?: string | null;
}
export function switchVerdict(backup: TlcBackup | null, deadline: string | null, now: Date, said: { cashYes: number; titleYes: boolean }): "NO_BACKUP" | "NOT_DUE" | "SWITCH" | "KEEP" | "DONE" {
  if (!backup || !deadline) return "NO_BACKUP";
  if (backup.applied_at || backup.kept_at) return "DONE";
  if (now.toISOString().slice(0, 10) < deadline.slice(0, 10)) return "NOT_DUE";
  return said.titleYes || said.cashYes >= TLC_SWITCH_MIN_CASH_YES ? "KEEP" : "SWITCH";
}

/**
 * WHO HEARS ABOUT TLC (owner, 22 Oct 2026): Sequoia, and nobody else. "this is my project"; she
 * tells Scooter herself. THE ONE LIST: every TLC email to a partner is addressed from it, and the
 * partner-mail door (`services/execEmail.ts`) re-addresses any TLC message to it, so a path that
 * forgets cannot reach anyone else. Only her reply counts as a veto. Scooter keeps his OS screens.
 * Brand emails are signed by her and replies come to her.
 */
const OWNER_PARTNER = PARTNERS.find((p) => p.firstName === "Sequoia")!;
export const TLC_OWNER = { firmUserId: OWNER_PARTNER.firmUserId, email: OWNER_PARTNER.email, name: OWNER_PARTNER.fullName, firm: "West Peek Ventures" } as const;
export const TLC_RECIPIENTS: readonly string[] = [TLC_OWNER.email];
export const TLC_DECIDER_IDS: readonly string[] = [TLC_OWNER.firmUserId];
/** Whether a partner email is about the Learning Club: a TLC card kind, or a TLC object. */
export function isTlcMail(input: { cardKind?: string | null; objectType?: string | null }): boolean {
  return isTlcKind(input.cardKind) || /^tlc_/.test(input.objectType ?? "");
}

/**
 * THE SHAPE OF ONE CLUB (owner, 22 Oct 2026): a 3–4 hour deep dive on one topic, one afternoon
 * (e.g. Saturday 1–5 pm) or one evening (e.g. Thursday 6–10 pm). Everyone leaves with something
 * they made or learned. Parker's packet and booking pack are priced for this length: a real meal
 * for 25–40, the host and venue for four hours, the expert paid for the afternoon — all inside the
 * $5,000 cap.
 */
export const TLC_SLOTS = [
  { key: "AFTERNOON", label: "Saturday afternoon, 1–5 pm", weekday: 6, start: "13:00", end: "17:00" },
  { key: "EVENING", label: "Thursday evening, 6–10 pm", weekday: 4, start: "18:00", end: "22:00" },
] as const;
export const TLC_HOURS = { min: 3, max: 4 } as const;
export const TLC_BOOKING_HOURS = 4;
export const TLC_RUN_OF_SHOW: ReadonlyArray<{ part: string; minutes: readonly [number, number] }> = [
  { part: "Arrive", minutes: [20, 20] },
  { part: "Learn", minutes: [45, 45] },
  { part: "Hands-on", minutes: [60, 60] },
  { part: "Break with food, and the sponsor's 5 minutes", minutes: [20, 30] },
  { part: "Go deeper", minutes: [45, 45] },
  { part: "Share", minutes: [20, 20] },
  { part: "Close", minutes: [10, 10] },
];
/** 220–230 minutes: inside the 3–4 hours, never outside it. */
export function runOfShowMinutes(): { min: number; max: number } {
  return TLC_RUN_OF_SHOW.reduce((a, r) => ({ min: a.min + r.minutes[0], max: a.max + r.minutes[1] }), { min: 0, max: 0 });
}
export function runOfShowLines(aiSegment?: string | null): string[] {
  return TLC_RUN_OF_SHOW.map((r) => `${r.part === "Go deeper" && aiSegment ? `Go deeper, with AI: ${aiSegment}` : r.part}: ${r.minutes[0] === r.minutes[1] ? r.minutes[0] : `${r.minutes[0]}–${r.minutes[1]}`} min`);
}

// ── Months ──────────────────────────────────────────────────────────────────────────────────────

export function addMonths(yyyyMm: string, n: number): string {
  const [y, m] = yyyyMm.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * The three months Parker holds a topic for. Two to four months out, never before January 2027:
 * on 1 Nov 2026 that is Jan, Feb, Mar; on 1 Dec it adds Apr. A month already held keeps its topic.
 */
export function rollingTopicMonths(now: Date): string[] {
  let start = addMonths(monthOf(now), 2);
  if (start < TLC_FIRST_MONTH) start = TLC_FIRST_MONTH;
  return Array.from({ length: TLC_TOPICS_AHEAD }, (_, i) => addMonths(start, i));
}

/** Whole days from `now` to the event date (an ISO date). Negative once it has passed. */
export function daysUntil(eventDate: string, now: Date): number {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ev = Date.parse(`${eventDate.slice(0, 10)}T00:00:00Z`);
  return Math.round((ev - day) / 86_400_000);
}

/**
 * The default date for a month's club: its third Thursday. A partner moves it by editing the row;
 * "move the date" is one of the three escalation answers, so it must be a field, not a constant.
 */
export function defaultEventDate(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const firstThursday = 1 + ((4 - first.getUTCDay() + 7) % 7);
  return `${yyyyMm}-${String(firstThursday + 14).padStart(2, "0")}`;
}

// ── Money ───────────────────────────────────────────────────────────────────────────────────────

export function ticketFeeUsd(priceUsd: number = TLC_TICKET_PRICE_USD): number {
  return Math.round((priceUsd * TLC_TICKET_FEE.percent + TLC_TICKET_FEE.fixedUsd) * 100) / 100;
}

export interface TicketLine {
  amount_usd: number;
  fee_usd: number | null;
}

export interface EventMoney {
  /** Sponsor cash that is AGREED, PAID or DELIVERED. In-kind is never cash. */
  sponsorCashUsd: number;
  /** Costs the partners have committed (booked). Options not yet booked are not costs. */
  committedCostsUsd: number;
  tickets: readonly TicketLine[];
  /** This club's cost budget: its sponsor goal less the $10,000 net. Default $15,000. */
  costBudgetUsd?: number;
  /** What donated space and product would have cost. Lowers cost; never counted as net. */
  inKindValueUsd?: number;
}

export interface EventEconomics {
  sponsorNetUsd: number;
  paidTickets: number;
  ticketNetUsd: number;
  /** Sponsor cash − committed costs + ticket revenue after fees. */
  netUsd: number;
  /** The target and the floor are judged on SPONSOR net alone: the $10K never depends on tickets. */
  hitsTarget: boolean;
  hitsFloor: boolean;
  overCostCap: boolean;
  inKindValueUsd: number;
}

export function eventEconomics(m: EventMoney): EventEconomics {
  const sponsorNetUsd = m.sponsorCashUsd - m.committedCostsUsd;
  const paid = m.tickets.filter((t) => t.amount_usd > 0);
  const ticketNetUsd = Math.round(paid.reduce((s, t) => s + t.amount_usd - (t.fee_usd ?? ticketFeeUsd(t.amount_usd)), 0) * 100) / 100;
  return {
    sponsorNetUsd,
    paidTickets: paid.length,
    ticketNetUsd,
    netUsd: Math.round((sponsorNetUsd + ticketNetUsd) * 100) / 100,
    hitsTarget: sponsorNetUsd >= TLC_NET_TARGET_USD,
    hitsFloor: sponsorNetUsd >= TLC_NET_FLOOR_USD,
    overCostCap: m.committedCostsUsd > (m.costBudgetUsd ?? TLC_COST_BUDGET_USD),
    inKindValueUsd: m.inKindValueUsd ?? 0,
  };
}

// ── The go-ahead rule ───────────────────────────────────────────────────────────────────────────

export type GoVerdict = "NOT_YET" | "GO" | "ESCALATE";

export interface GoCheck {
  verdict: GoVerdict;
  /** Which checkpoint this is (21 or 14), or null when today is not one. */
  checkpoint: number | null;
  reasons: string[];
  /** The three answers to a shortfall, always offered together. */
  options: string[];
}

export const ESCALATION_OPTIONS = [
  "Add a sponsor: Wynn takes the next brand in the queue to a call this week.",
  "Cut cost: drop the most expensive booking-pack option for the next one down.",
  "Move the date: push the club a month and keep every agreed sponsor on it.",
] as const;

/**
 * GO when sponsor cash minus committed costs is at least $7,500 AND (at two weeks out) at least 25
 * tickets are PAID. Checked at 21 and 14 days out; anything short escalates to both partners with
 * the three ways out. Between checkpoints the verdict is NOT_YET.
 */
export function goAheadCheck(input: { daysOut: number; economics: EventEconomics; seats?: Seats; costBudgetUsd?: number }): GoCheck {
  const seats = input.seats ?? TLC_SEATS;
  const checkpoint = (TLC_GO_CHECK_DAYS as readonly number[]).includes(input.daysOut) ? input.daysOut : null;
  if (checkpoint === null) return { verdict: "NOT_YET", checkpoint, reasons: [], options: [] };
  const e = input.economics;
  const reasons: string[] = [];
  if (!e.hitsFloor) {
    reasons.push(`Sponsor cash minus committed costs is $${e.sponsorNetUsd.toLocaleString("en-US")}, under the $${TLC_NET_FLOOR_USD.toLocaleString("en-US")} floor.`);
  }
  if (checkpoint <= TLC_TICKET_GATE_DAYS && e.paidTickets < seats.min) {
    reasons.push(`${e.paidTickets} paid ticket(s), under the ${seats.min} needed two weeks out.`);
  }
  if (e.overCostCap) reasons.push(`Committed costs are over the $${(input.costBudgetUsd ?? TLC_COST_BUDGET_USD).toLocaleString("en-US")} budget.`);
  return reasons.length
    ? { verdict: "ESCALATE", checkpoint, reasons, options: [...ESCALATION_OPTIONS] }
    : { verdict: "GO", checkpoint, reasons: [], options: [] };
}

// ── Tickets ─────────────────────────────────────────────────────────────────────────────────────

export type TicketVerdict = "OPEN" | "FULL";

/** 40 seats. A ticket past 40 is refused before payment is taken; 25 paid is the go-ahead floor. */
export function ticketVerdict(paid: number, seats: Seats = TLC_SEATS): { verdict: TicketVerdict; seatsLeft: number; meetsFloor: boolean } {
  return { verdict: paid >= seats.max ? "FULL" : "OPEN", seatsLeft: Math.max(0, seats.max - paid), meetsFloor: paid >= seats.min };
}

export function ticketPriceProblem(amountUsd: number): string | null {
  if (!(amountUsd > 0)) return "a ticket is paid; a free seat is not a ticket";
  if (amountUsd > TLC_TICKET_PRICE_MAX_USD) return `a ticket is at most $${TLC_TICKET_PRICE_MAX_USD}`;
  return null;
}

// ── Deal stages ─────────────────────────────────────────────────────────────────────────────────

/** PROSPECT is found but not yet written to. The six stages the owner named follow it. */
export const DEAL_STAGES = ["PROSPECT", "PITCHED", "CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED"] as const;
export const DEAL_END_STATES = ["DECLINED", "STOPPED"] as const;
export type DealStage = (typeof DEAL_STAGES)[number] | (typeof DEAL_END_STATES)[number];

/** Forward one or more stages, or out to DECLINED / STOPPED. Never backwards, except a counter (to CALL). */
export function stageMoveProblem(from: DealStage, to: DealStage, opts: { counter?: boolean } = {}): string | null {
  if (from === to) return null;
  if ((DEAL_END_STATES as readonly string[]).includes(from)) return `the deal is ${from}`;
  if ((DEAL_END_STATES as readonly string[]).includes(to)) return null;
  const a = DEAL_STAGES.indexOf(from as (typeof DEAL_STAGES)[number]);
  const b = DEAL_STAGES.indexOf(to as (typeof DEAL_STAGES)[number]);
  if (b > a) return null;
  if (opts.counter && from === "WAITING_ON_OWNERS" && to === "CALL") return null;
  return `a deal moves forward: ${from} cannot go back to ${to}`;
}

/** A brand that has answered, or got further, is "interested" for the swap rule. */
export function isInterested(deal: { stage: string; replied_at?: string | null }): boolean {
  return Boolean(deal.replied_at) || ["CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED"].includes(deal.stage);
}

/** Six weeks out with no interested brand: Parker is told to swap the topic. */
export function needsSwap(daysOut: number, deals: ReadonlyArray<{ stage: string; replied_at?: string | null }>): boolean {
  return daysOut <= TLC_BOOKING_PACK_DAYS && daysOut > 0 && !deals.some(isInterested);
}

// ── The drip ────────────────────────────────────────────────────────────────────────────────────

export type DripStop = "REPLIED" | "BOUNCED" | "UNSUBSCRIBED" | "DECLINED";

/**
 * When the next email in the sequence is due. `step` is how many have gone; null means the drip is
 * over (all four sent) or stopped. Day N counts from the first send, so a held day-0 does not
 * squeeze the rest together.
 */
/** The model's own picks per club, per batch. Brands we must pitch (tlc_must_pitch) are outside it. */
export const TLC_BRANDS_PER_CLUB = 5;

/**
 * Wynn's own picks asked for in ONE search (24 Oct 2026). Five plus the must-pitch brands ran past the seat's
 * 230 s search window (272 s measured in the claimer's directory), so each search asks for three, and a second search
 * the next tick asks for the rest of TLC_BRANDS_PER_CLUB (owner, 24 Oct 2026: about five new brands per club per week).
 */
export const TLC_BRANDS_PER_SEARCH = 3;

export function nextDripAt(step: number, firstSentAt: string | null, now: Date, stopped: DripStop | null): string | null {
  if (stopped) return null;
  if (step >= TLC_DRIP_DAYS.length) return null;
  if (step === 0 || !firstSentAt) return now.toISOString();
  return new Date(Date.parse(firstSentAt) + TLC_DRIP_DAYS[step]! * 86_400_000).toISOString();
}

/**
 * SLOW WARM-UP. A new sending address that starts at full volume is filed as spam. Week one of
 * sending allows 5 a day, week two 10, week three 20, then 30. Counted from the first brand email
 * the firm ever sent for TLC.
 */
export function warmupDailyCap(firstEverSentAt: string | null, now: Date): number {
  if (!firstEverSentAt) return 5;
  const weeks = Math.floor((now.getTime() - Date.parse(firstEverSentAt)) / (7 * 86_400_000));
  return weeks <= 0 ? 5 : weeks === 1 ? 10 : weeks === 2 ? 20 : 30;
}

/** What an arriving message means for a deal's drip, from its From and Subject alone. */
export function classifyBrandMail(input: { from: string; subject: string }): DripStop {
  const from = input.from.toLowerCase();
  const subject = input.subject.toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery|bounce/.test(from) || /undeliverable|delivery status notification|returned mail|delivery failure/.test(subject)) return "BOUNCED";
  if (/\bunsubscribe\b|\bremove me\b|\bstop\b/.test(subject)) return "UNSUBSCRIBED";
  return "REPLIED";
}

export interface DripEmailInput {
  step: number;
  brand: string;
  contactName: string | null;
  topic: string;
  month: string;
  eventDate: string;
  why: string | null;
  /** The club's own room size; the default when not set. */
  seats?: Seats;
}

/**
 * THE FOUR BRAND EMAILS (owner, 22 Oct 2026). Signed by Sequoia Taylor, West Peek Ventures; replies
 * come to her. Email 1 leads with the brand's own reason, gives one proof line, and asks one
 * question: "Would you be open to exploring a partnership?". No pitch, no price and no attachment
 * until they reply; the pitch PDF goes only in answer to a yes. Email 2 adds a short picture of the
 * room. No exclusivity line anywhere. A quiet subject, the same on all four so they thread.
 */
export const TLC_DRIP_PROOF_LINE = "Our community of more than 5,000 founders, operators and creatives meets in person through West Peek Rooms, our event series in New York.";
export const TLC_DRIP_ASK = "Would you be open to exploring a partnership?";
/** Every brand email says 25–40 guests per event, flexible to the brand's needs (owner, 26 Oct 2026), whatever the club's planned size. */
export const BRAND_GUESTS = `${TLC_SEATS.min} to ${TLC_SEATS.max} people per event (flexible to your goals)`;
/**
 * THE NEXT STEP IS THREE SAMPLES, NEVER A CALL (owner, 26 Oct 2026). Wynn never suggests or asks for a call; deals
 * close over email. Email 2 (the one follow-up to a brand that has not replied) and every answer Wynn drafts offer
 * these three things instead, with no price.
 */
export const TLC_SAMPLES_OFFER =
  "If it would help, I can send you three things: a sample run of show for the evening, a sketch of what a series of six could look like, and a breakdown of the kind of people in the room.";
/*
 * THE OPT-OUT IS A SOFT, HUMAN P.S. (owner, 24 Oct 2026), one per drip step, and it still works: a reply that
 * says it is not a fit (replyLooksLikeNo) stops the sequence for good. The template carries no postal address.
 */
export const TLC_PS_BY_STEP: readonly string[] = [
  "P.S. If this isn't a fit, just let me know and I won't follow up.",
  "P.S. If it isn't a fit, just say so and I won't follow up.",
  "P.S. If this isn't a fit, a quick note back is all it takes and I won't follow up.",
  "P.S. If it isn't a fit, no need to reply at all; this is my last note.",
];
export const TLC_OPT_OUT_LINE = TLC_PS_BY_STEP[0]!;
export const TLC_SIGNATURE: readonly string[] = [TLC_OWNER.name, TLC_OWNER.firm, TLC_OWNER.email];
/*
 * THE BRAND SEES ONE SENTENCE OF WHY, NEVER THE RESEARCH NOTE (partner tail, 24 Oct 2026). `why_fit` is Parker's
 * note to Sequoia: the reason, then "Limits:", "Caveat:", which tier it fits, who it must not compete with, whether
 * the inbox is shared. The first batch (TLC-ZF84KK) pasted all of it into seven brand emails ("Caveat: McClaran
 * works at Hyperice's PR agency…") and lowercased the brand ("garmin makes…"). The email takes the first sentence
 * alone, and none at all when that sentence is itself internal; Approvals still shows her the whole note.
 */
export const TLC_INTERNAL_NOTE = /\b(?:limits?|caveats?|note|check that|never-approach|must not approach|compet\w*|tier|(?:title|lead|product|presenting) partner|partner seat|inbox|press contact|media contact|PR agency|not (?:a )?partnerships?|job title|newsroom|on the page|the page)\b/i;
const SENTENCE_STARTERS = new Set(["The", "A", "An", "It", "Its", "This", "These", "That", "Their", "They", "Your", "On", "In", "With", "As", "After", "Since", "Last", "Every", "Each"]);
export function brandFacingReason(why: string | null | undefined): string | null {
  const text = (why ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const first = (/^.+?[.!?](?=\s+[A-Z(]|$)/.exec(text)?.[0] ?? text).trim();
  if (!first || TLC_INTERNAL_NOTE.test(first)) return null;
  const sentence = first.replace(/[.!?]?$/, ".");
  const word = /^\S+/.exec(sentence)?.[0] ?? "";
  // Lowercase only an ordinary opening word ("The", "Its"); a name ("Garmin", "InsideTracker") keeps its capital.
  return SENTENCE_STARTERS.has(word) ? `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : sentence;
}

/**
 * THE BRAND'S NAME AS A PERSON WOULD WRITE IT (owner, 24 Oct 2026). The stored brand keeps Parker's qualifier,
 * "Osmo (Generation)" or "Quest Diagnostics (questhealth.com)", because it tells deals apart; an email to the
 * brand says "Osmo" and "Quest Diagnostics". Parentheticals are dropped, the stored row is never changed, and a
 * name that would come out empty stays as it was.
 */
export function brandDisplayName(brand: string): string {
  const shown = brand.replace(/\s*\([^()]*\)/g, "").replace(/\s+/g, " ").trim();
  return shown || brand.trim();
}

export function dripEmail(raw: DripEmailInput): { subject: string; text: string } {
  const input = { ...raw, brand: brandDisplayName(raw.brand) };
  const hi = input.contactName ? `Hi ${input.contactName.split(" ")[0]},` : "Hi,";
  const when = monthWords(input.month);
  const subject = `${input.brand} + a small room in New York`;
  const reason = brandFacingReason(input.why);
  const lead = reason ? `I am writing because ${reason}` : `I am writing because ${input.brand} feels like a natural fit for a room we are building.`;
  const bodies = [
    [
      hi,
      "",
      lead,
      `In ${when} we are hosting The Learning Club in New York: ${BRAND_GUESTS} spending an afternoon or evening going deep on ${input.topic}, hands-on. We are looking for a few founding partners for the first clubs.`,
      TLC_DRIP_PROOF_LINE,
      "",
      TLC_DRIP_ASK,
    ],
    // Step 2 of her flow (shared/tlc/brandFlow.ts): the ONE follow-up, which offers the three samples. After it,
    // no more follow-ups, and it carries no P.S. (her template).
    [fillTemplate("followUp", { hi, brand: input.brand })],
  ];
  const step = Math.min(input.step, bodies.length - 1);
  const text = [...bodies[step]!, "", ...TLC_SIGNATURE, ...(step === 0 ? ["", TLC_PS_BY_STEP[0]!] : [])].join("\n");
  return { subject, text };
}

/**
 * AN OWNER-APPROVED FIRST EMAIL, WORD FOR WORD (owner, 23 Oct 2026, ElevenLabs). Her text is used as it
 * was approved: "[Name]" becomes the contact's first name, and "Hi [Name]," becomes "Hi," when there is
 * none. Only the opt-out line every brand email carries is added after it. Emails 2 to 4 stay generated.
 */
export function approvedDayZeroEmail(approved: { subject: string; body: string }, contactName: string | null): { subject: string; text: string } {
  const first = contactName?.trim().split(/\s+/)[0] ?? "";
  const body = (first ? approved.body.replace(/\[Name\]/g, first) : approved.body.replace(/Hi \[Name\],/g, "Hi,").replace(/\s?\[Name\]/g, "")).trimEnd();
  return { subject: approved.subject, text: [body, "", TLC_OPT_OUT_LINE].join("\n") };
}

/** Replies that say no, read from the subject alone; anything else that is a reply may be a yes. */
export function replyLooksLikeNo(subject: string): boolean {
  // The words a brand uses to say no, answering the P.S. — any of them stops the sequence for good.
  return /\b(no,? thanks?|no thank you|not interested|not a (?:good )?fit|isn'?t a (?:good )?fit|not the right fit|not for us|we(?:'ll| will) pass|pass on this|decline|declined|unsubscribe|remove me|stop emailing|please stop|don'?t follow up|do not follow up)\b/i.test(subject.replace(/[’]/g, "'"));
}

export function monthWords(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number) as [number, number];
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}

// ── The send gate ───────────────────────────────────────────────────────────────────────────────

/** THE SWITCH. `tlc_setting.brand_send`; anything but exactly 'on' is off, and no row is off. */
export const BRAND_SEND_SETTING = "brand_send";
/** Retired 22 Oct 2026: a time, not tied to any content. Never read as an approval again. */
export const ONEPAGER_APPROVAL_SETTING = "onepager_mock_approved_at";
export const PLAYBOOK_APPROVAL_SETTING = "playbook_approved_at";
/**
 * AN APPROVAL IS OF EXACT CONTENT (owner, 22 Oct 2026). Approving stores the SHA-256 of what she
 * saw; the gate compares it to the hash of what would be sent now. Any change to the brand pitch or
 * the playbook clears that approval, and the gate says so. The old time-stamped approvals above
 * predate the content and read as not approved.
 */
export const PITCH_APPROVAL_HASH_SETTING = "pitch_approved_hash";
export const PLAYBOOK_APPROVAL_HASH_SETTING = "playbook_approved_hash";
export interface ContentHashes {
  pitch: string;
  playbook: string;
}

export function approvalState(settings: Record<string, string | null | undefined>, key: string, current: string): "APPROVED" | "CHANGED" | "NOT_APPROVED" {
  const stored = settings[key];
  if (!stored) return "NOT_APPROVED";
  return stored === current ? "APPROVED" : "CHANGED";
}

/**
 * The words the Brand sending panel shows when TLC brand sales is not on her Outside email list
 * (owner, 23 Oct 2026). The panel turns this line into the link to that screen.
 */
export const TLC_NOT_ON_OUTSIDE_LIST = "TLC brand sales is not on your Outside email list — tap to allow.";

/**
 * THE GATE. `outside` is `outsideEmailAllowed(env, { job: TLC_BRAND_SALES_JOB })`'s answer — the one
 * function that decides outside email. This gate never reads an env var or the list itself.
 */
export function brandSendGate(
  settings: Record<string, string | null | undefined>,
  outside: { allowed: boolean; code: string; reason: string },
  hashes: ContentHashes,
): { open: boolean; reasons: string[]; outside_email_allowed: boolean } {
  const reasons: string[] = [];
  const pitch = approvalState(settings, PITCH_APPROVAL_HASH_SETTING, hashes.pitch);
  const playbook = approvalState(settings, PLAYBOOK_APPROVAL_HASH_SETTING, hashes.playbook);
  if (pitch === "NOT_APPROVED") reasons.push("the owner has not approved the brand pitch");
  if (pitch === "CHANGED") reasons.push("the brand pitch changed after it was approved; approve it again");
  if (playbook === "NOT_APPROVED") reasons.push("the owner has not approved the sales playbook");
  if (playbook === "CHANGED") reasons.push("the sales playbook changed after it was approved; approve it again");
  if (settings[BRAND_SEND_SETTING] !== "on") reasons.push("the TLC brand-send switch is off");
  if (!outside.allowed) reasons.push(outside.code === "NOT_ON_LIST" ? TLC_NOT_ON_OUTSIDE_LIST : `${outside.reason} — tap to open your Outside email list.`);
  return { open: reasons.length === 0, reasons, outside_email_allowed: outside.allowed };
}

// ── The partners' decision ──────────────────────────────────────────────────────────────────────

export type Decision = { kind: "YES" } | { kind: "NO" } | { kind: "COUNTER"; amountUsd: number } | { kind: "UNCLEAR" };

/** "yes", "no", or "counter $6,000" (or "counter 6k"). The first word decides; a counter needs a number. */
export function parseDecisionReply(text: string | null | undefined): Decision {
  const t = String(text ?? "").trim().toLowerCase();
  const counter = /\bcounter\b[^0-9$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k)?/.exec(t);
  if (counter) {
    const n = Number(counter[1]!.replace(/,/g, "")) * (counter[2] ? 1000 : 1);
    if (n > 0) return { kind: "COUNTER", amountUsd: Math.round(n) };
  }
  if (/^(yes|yep|yeah|approved|approve|go|do it|agreed|ok|okay)\b/.test(t)) return { kind: "YES" };
  if (/^(no|nope|pass|decline|declined|don't|do not)\b/.test(t)) return { kind: "NO" };
  return { kind: "UNCLEAR" };
}

export interface DealOffer {
  brand: string;
  topic: string;
  month: string;
  cashUsd: number;
  inKind: string | null;
  inKindValueUsd: number;
  wants: string | null;
}

/** What the club nets if the partners say yes to this one, given what is already agreed and booked. */
export function netIfYes(offer: Pick<DealOffer, "cashUsd">, current: EventEconomics): { netUsd: number; sponsorNetUsd: number; vsTarget: number; vsFloor: number } {
  const sponsorNetUsd = current.sponsorNetUsd + offer.cashUsd;
  return {
    sponsorNetUsd,
    netUsd: Math.round((current.netUsd + offer.cashUsd) * 100) / 100,
    vsTarget: sponsorNetUsd - TLC_NET_TARGET_USD,
    vsFloor: sponsorNetUsd - TLC_NET_FLOOR_USD,
  };
}

export function recommendation(offer: DealOffer, current: EventEconomics): string {
  const after = netIfYes(offer, current);
  if (offer.cashUsd <= 0) return "Say no unless the in-kind removes a cost we would otherwise pay: it adds no cash.";
  if (after.vsTarget >= 0) return "Say yes: with this one the club reaches the $10,000 target.";
  if (after.vsFloor >= 0) return "Say yes: with this one the club clears the $7,500 floor.";
  return "Say yes and keep selling: it moves us toward the floor, and the next brand in the queue is already being written to.";
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

/** The escalation to BOTH partners when a brand is ready. Their reply is the permission. */
export function decisionEmail(offer: DealOffer, current: EventEconomics): { what: string; tldr: string; tldrBullets: string[]; sections: Array<{ label: string; bullets: string[] }> } {
  const after = netIfYes(offer, current);
  return {
    what: `TLC sponsor ${offer.brand.slice(0, 28)}: yes, no or counter?`,
    tldr: `${offer.brand} offers ${usd(offer.cashUsd)} cash${offer.inKind ? ` plus ${offer.inKind}` : ""}. If we say yes the club nets ${usd(after.netUsd)}.`,
    tldrBullets: ['Reply "yes" to agree', 'Reply "no" to pass', 'Reply "counter $X" to ask for a different amount'],
    sections: [
      {
        label: "The offer",
        bullets: [
          `Cash: ${usd(offer.cashUsd)}`,
          `In kind: ${offer.inKind ?? "none"}${offer.inKindValueUsd ? ` (worth about ${usd(offer.inKindValueUsd)}; lowers cost, not counted as net)` : ""}`,
          `What they want: ${offer.wants ?? "nothing beyond the standard sponsor package"}`,
        ],
      },
      {
        label: "Net if we say yes",
        bullets: [
          `Club net: ${usd(after.netUsd)} (sponsor net ${usd(after.sponsorNetUsd)} plus ticket revenue after fees)`,
          `Against the $10,000 target: ${after.vsTarget >= 0 ? "met" : `${usd(-after.vsTarget)} short`}`,
          `Against the $7,500 floor: ${after.vsFloor >= 0 ? "met" : `${usd(-after.vsFloor)} short`}`,
        ],
      },
      { label: "Recommendation", bullets: [recommendation(offer, current)] },
    ],
  };
}

// ── The booking pack (options only — never a booking) ──────────────────────────────────────────

export interface BookingOption {
  name: string;
  priceUsd: number;
  /** The last day it can be booked at that price. */
  bookBy: string;
  url: string;
  note?: string;
}

export interface MaterialLine {
  item: string;
  url: string;
  qty: number;
  unitUsd: number;
}

export interface BookingPack {
  hosts: BookingOption[];
  donatedVenueLeads: BookingOption[];
  paidVenues: BookingOption[];
  teachers: BookingOption[];
  food: BookingOption[];
  materials: MaterialLine[];
  photographers: BookingOption[];
}

export const BOOKING_PACK_SHAPE: Readonly<Record<Exclude<keyof BookingPack, "materials">, { min: number; max: number; label: string }>> = {
  hosts: { min: 3, max: 3, label: "NYC paid host (4 hours)" },
  donatedVenueLeads: { min: 0, max: 5, label: "donated-venue lead" },
  paidVenues: { min: 2, max: 3, label: "paid venue (4 hours)" },
  teachers: { min: 2, max: 3, label: "expert teacher (paid for the afternoon)" },
  food: { min: 2, max: 3, label: "real meal for 25–40" },
  photographers: { min: 2, max: 2, label: "photographer" },
};

/** What is short or malformed. Empty means the pack is complete. */
export function bookingPackProblems(pack: BookingPack): string[] {
  const out: string[] = [];
  for (const [key, shape] of Object.entries(BOOKING_PACK_SHAPE) as Array<[keyof typeof BOOKING_PACK_SHAPE, (typeof BOOKING_PACK_SHAPE)[keyof typeof BOOKING_PACK_SHAPE]]>) {
    const list = pack[key];
    if (list.length < shape.min) out.push(`${list.length} ${shape.label} option(s); ${shape.min} wanted`);
    for (const o of list) {
      if (!(o.priceUsd >= 0)) out.push(`${o.name}: no price`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.bookBy)) out.push(`${o.name}: no "book by" date`);
    }
  }
  if (pack.materials.length === 0) out.push("no materials list");
  return out;
}

export function materialsTotalUsd(pack: Pick<BookingPack, "materials">): number {
  return Math.round(pack.materials.reduce((s, m) => s + m.qty * m.unitUsd, 0) * 100) / 100;
}

const cheapest = (list: readonly BookingOption[]): BookingOption | null => (list.length ? [...list].sort((a, b) => a.priceUsd - b.priceUsd)[0]! : null);

/**
 * The cheapest complete plan, against the cap and the sponsor cash. A donated venue, when there is
 * a lead, is assumed at $0 only as the BEST case; the paid venue is the plan the totals use, because
 * a lead is not a yes.
 */
export function bookingPackTotals(pack: BookingPack, sponsorCashUsd: number): {
  lines: Array<{ what: string; name: string; priceUsd: number }>;
  costUsd: number;
  bestCaseCostUsd: number;
  sponsorCashUsd: number;
  netUsd: number;
  vsTarget: number;
  vsFloor: number;
  underCap: boolean;
} {
  const lines: Array<{ what: string; name: string; priceUsd: number }> = [];
  const add = (what: string, o: BookingOption | null): void => {
    if (o) lines.push({ what, name: o.name, priceUsd: o.priceUsd });
  };
  add("Host", cheapest(pack.hosts));
  add("Venue (paid)", cheapest(pack.paidVenues));
  add("Teacher", cheapest(pack.teachers));
  add("Food", cheapest(pack.food));
  add("Photographer", cheapest(pack.photographers));
  const materials = materialsTotalUsd(pack);
  lines.push({ what: "Materials", name: `${pack.materials.length} item(s)`, priceUsd: materials });
  const costUsd = Math.round(lines.reduce((s, l) => s + l.priceUsd, 0) * 100) / 100;
  const venue = cheapest(pack.paidVenues)?.priceUsd ?? 0;
  const bestCaseCostUsd = pack.donatedVenueLeads.length ? Math.round((costUsd - venue) * 100) / 100 : costUsd;
  const netUsd = sponsorCashUsd - costUsd;
  return { lines, costUsd, bestCaseCostUsd, sponsorCashUsd, netUsd, vsTarget: netUsd - TLC_NET_TARGET_USD, vsFloor: netUsd - TLC_NET_FLOOR_USD, underCap: costUsd <= TLC_COST_BUDGET_USD };
}

// ── The sponsorship agreement (a template; NOT legal advice) ───────────────────────────────────

export const AGREEMENT_DISCLAIMER = "TEMPLATE ONLY. NOT LEGAL ADVICE. Have counsel review before anyone signs.";

export function sponsorshipAgreement(input: { brand: string; topic: string; eventDate: string; cashUsd: number; inKind: string | null; deliverables: string | null; dueDate: string }): string {
  return [
    AGREEMENT_DISCLAIMER,
    "",
    "SPONSORSHIP AGREEMENT — WEST PEEK ROOMS: THE LEARNING CLUB",
    "",
    `1. Parties. West Peek Ventures ("West Peek") and ${input.brand} ("Sponsor").`,
    `2. Event. The Learning Club: ${input.topic}, New York City, on ${input.eventDate} (or a date West Peek gives at least 14 days' notice of).`,
    `3. Sponsorship. Sponsor pays ${usd(input.cashUsd)} in cash${input.inKind ? ` and provides in kind: ${input.inKind}` : ""}.`,
    `4. Payment. Due by ${input.dueDate} against West Peek's invoice. The sponsorship is confirmed when payment is received.`,
    `5. What Sponsor receives. ${input.deliverables ?? "Its product in attendees' hands during the hands-on session where it fits the topic, five minutes during the food break, photographs from the day for its own channels, opt-in lead capture (only attendees who choose to share their details), a mention in the invitation and on the day, and a recap with attendance numbers afterwards."}`,
    "6. Attendee privacy. West Peek does not share attendee names, emails or any list of attendees with Sponsor.",
    "7. Cancellation. If West Peek cancels and does not offer a new date, West Peek refunds the cash paid. If Sponsor withdraws within 14 days of the event, the payment is not refundable.",
    "8. Brand use. Each party may use the other's name and logo only to describe this sponsorship, and only as the other approves.",
    "9. No other promises. This is the whole agreement. Neither party promises any particular attendance, outcome or result.",
    "",
    "West Peek Ventures: ____________________   Date: ________",
    `${input.brand}: ____________________   Date: ________`,
  ].join("\n");
}

/** The invoice note that goes with a yes. The payment link is West Peek's own; the OS never moves money out. */
export function invoiceNote(input: { brand: string; topic: string; month: string; cashUsd: number; dueDate: string; paymentUrl: string | null }): string {
  return [
    `Invoice: ${input.brand}, sponsorship of The Learning Club, ${input.topic} (${monthWords(input.month)})`,
    `Amount: ${usd(input.cashUsd)}`,
    `Due: ${input.dueDate}`,
    input.paymentUrl ? `Pay here: ${input.paymentUrl}` : "Payment link: not set yet. A partner adds it from West Peek's own payment account (it is the one thing only you hold).",
  ].join("\n");
}

// ── The one-pager ───────────────────────────────────────────────────────────────────────────────

export interface Citation {
  title: string;
  publisher: string | null;
  url: string;
  claim: string;
}

// The one-pagers (the brand pitch and the internal one-pager) are rendered in ./pitch.ts.

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── The sales playbook (Wynn's), as the prompts read it ────────────────────────────────────────

/**
 * WYNN'S PLAYBOOK. Every TLC prompt carries this text, so the playbook the owner approves IS the
 * instruction the model is given — never a document beside it.
 */
export const TLC_PLAYBOOK: readonly string[] = [
  "Who we sell to: brands whose customers are the people a club on this topic draws, in categories Parker named for it. Several partners per club, each in its own role.",
  "What we sell: real hands-on time with the product, in a room sized to the partners' goals (set per club; 25 to 40 by default, 60 to 150 when the club calls for it), each guest paid to be there, for a 3 to 4 hour deep dive on one topic in New York (one afternoon or one evening). Product in hands during the 60-minute hands-on session where it fits, five minutes during the food break, photo and content rights, opt-in lead capture, a mention in the invitation and on the day, and a recap with numbers.",
  "Price: Title partner $25,000: one brand funds the whole room, the club is \"presented by\" that brand, it is the only cash partner that night, and in-kind partners need its OK. In January the Title partner is the primary route to $25K. Partner $5,000, the standard for most brands. Lead partner $10,000. Presenting partner $15,000, for a big brand only, with \"Presented by\" billing and top placement. Product partner, in kind, for a product brand that supplies product instead of cash. Custom amounts are fine; neither size nor count is capped.",
  "Goal per club: $25,000 raised from sponsors, costs up to $15,000, $10,000 net; under $7,500 net at a go-check escalates. At least 5 partners at $5,000, or larger sponsors at $10,000 to $15,000, or any mix. In-kind venue or product lowers cost and never counts toward the $25,000. Tickets add to the net but the goal never depends on them.",
  "Sponsors in a club are complementary, never competitors: one brand per kind of product that would compete (one drink base, then mixers, glassware, wellness, food). Never approach a brand that competes with an agreed or featured partner. This is how we put a room together, not a promise to a brand: we never offer or claim category exclusivity.",
  "Who we write to: a named person at the brand whose job is partnerships, events, community or brand marketing, at an address read off a live page. Never a guessed address. Never a contact without an email.",
  "How we write: signed by Sequoia Taylor, West Peek Ventures; replies go to her. Short, plain, warm, professional. Lead with the brand's own reason. One ask: \"Would you be open to exploring a partnership?\" No pitch, price or attachment until they reply. No inflated claims, no numbers we cannot show, no invented case studies. Before the first club runs we describe the format and West Peek Rooms' real history; after it, the real recap.",
  "Cadence: four emails at day 0, 4, 10 and 18. Stop the moment they reply, bounce or ask us to stop. Warm up slowly: 5 a day the first week, then 10, 20, 30.",
  "When a brand replies yes: send them the brand pitch PDF and a call link, and tell Sequoia. After the call, write up their cash, their in-kind and what they want, and send Sequoia one email with a recommendation and the club's net if we say yes. Her reply decides: yes, no, or counter with an amount.",
  "Money: we invoice and send West Peek's own payment link. We never book, buy or pay for anything; hosts, venues, food, materials and photographers go to the partners as options with prices and book-by dates.",
  "Privacy: no attendee name, email or list ever goes to a sponsor.",
];

export function renderPlaybook(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TLC Sales Playbook</title>
<style>:root{--bg:#FFFFFF;--ink:#050505;--muted:#5F5B55;--accent:#F05A1A}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A}}:root[data-theme="dark"]{--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}main{max-width:760px;margin:0 auto;padding:40px 16px}h1{margin:0 0 6px}p.s{color:var(--muted)}li{margin:10px 0}.e{color:var(--accent);font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px}</style></head>
<body><main><div class="e">The Learning Club · for the owner's approval</div><h1>Wynn's sales playbook</h1><p class="s">This exact text is what every TLC prompt carries. Nothing is sent to any brand until you approve this and the brand pitch.</p><ol>${TLC_PLAYBOOK.map((l) => `<li>${esc(l)}</li>`).join("")}</ol></main></body></html>`;
}

// ── Parker's topics: he chooses; the partners may veto within 3 days ───────────────────────────

/** Owner's seed list, 22 Oct 2026. Parker may add better ones; these are a start, not a cage. */
export const TLC_TOPIC_SEEDS: readonly string[] = [
  'Trading & Investing ("Money Reset")',
  "Fragrance Lab",
  "Matcha & Tea",
  "Zero-Proof Home Bar",
  "Home Espresso & Coffee",
  "Skincare Science",
  "Knife Skills & Home Cooking",
  "Sleep & Recovery",
  "Film Photography",
  "Sewing & Visible Mending",
  "AI Tools for Your Work",
  "Buying Your First NYC Home",
];

/** How Parker picks. Every pick is argued against all four. */
export const TLC_TOPIC_CRITERIA: readonly string[] = [
  "A sponsor's product is actually used in the session (the hands-on hour runs on it).",
  "The category already spends on in-person events.",
  "Two or three NON-competing sponsors fit the same club.",
  "People would happily pay $10 to spend 3–4 hours on it.",
];

/** Parker's picks proceed unless either partner says no within this window. Nothing waits on the owners. */
export const TLC_VETO_DAYS = 3;

export function vetoUntil(sentAt: Date): string {
  return new Date(sentAt.getTime() + TLC_VETO_DAYS * 86_400_000).toISOString();
}

/**
 * Which proposed months a partner's reply vetoes. No negative word: none. A negative word naming a
 * month ("no to February") or a topic ("not Fragrance Lab"): those. A bare "no": all of them — the
 * cautious reading of an unspecific no.
 */
export function vetoedMonths(text: string, proposed: ReadonlyArray<{ month: string; topic: string }>): string[] {
  const t = ` ${text.toLowerCase()} `;
  if (!/\b(no|not|veto|swap|pass|don't|do not|skip|change)\b/.test(t)) return [];
  const named = proposed.filter((p) => {
    const monthName = monthWords(p.month).split(" ")[0]!.toLowerCase();
    const topicWords = p.topic.toLowerCase().replace(/\(.*?\)|"/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    return t.includes(monthName) || t.includes(monthName.slice(0, 3) + " ") || topicWords.some((w) => t.includes(w));
  });
  return (named.length ? named : proposed).map((p) => p.month);
}

// ── Card kinds ──────────────────────────────────────────────────────────────────────────────────

export const TLC_CARD_KINDS = ["TLC_TOPICS", "TLC_BOOKING_PACK", "TLC_BRAND_BATCH", "TLC_TREND_STORY", "TLC_SPONSOR_DECISION"] as const;
export type TlcCardKind = (typeof TLC_CARD_KINDS)[number];
export function isTlcKind(kind: string | null | undefined): kind is TlcCardKind {
  return (TLC_CARD_KINDS as readonly string[]).includes(kind ?? "");
}

export function quarterOf(at: Date): string {
  return `${at.getUTCFullYear()}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`;
}

export { TLC_ABOUT_WEST_PEEK, TLC_ABOUT_COMMUNITY } from "./aboutWestPeek";

/** The real history the one-pager leans on before the first club has run. No invented case study. */
export const TLC_PRE_LAUNCH_PROOF: readonly string[] = [
  "West Peek Rooms: the firm's in-person gatherings. The Learning Club is their monthly New York edition.",
  "The West Peek community: more than 5,000 founders, operators, investors, creatives and builders.",
];

// ── Parker's topics email to both partners (owner, 22 Oct 2026) ─────────────────────────────────

/**
 * WHAT THE PARTNERS GET: the 3 picks (one per month, each with the glossy one-sheet a brand would see)
 * and 9 alternatives as a plain list, each with a one-line reason and the brands that would pay.
 * Her words: "the deliverable should be the glossy 1 sheet to sell a brand the idea for us to see and
 * approve + 9 more alt ideas in a list in the email", and "I don't need to see that he rejected
 * trading for Jan". Parker's working notes — what he turned down and why — stay on the card.
 */
export const TLC_ALTERNATIVES = 9;

// ── Where an idea came from (owner, 22 Oct 2026) ────────────────────────────────────────────────

/**
 * Every topic idea carries its origin, on the card, in the Rooms tab's ideas list and in the email:
 * a partner's own idea; one reverse-engineered from a brand that is clearly spending right now; or
 * what people are searching for and curious about. Parker weighs them all on merit — a partner's
 * idea is considered, never automatically picked (owner's correction, 22 Oct 2026).
 */
/**
 * WHERE AN IDEA CAME FROM. SUGGESTED_LIST (22 Oct 2026): a list that arrived in a partner's email
 * but was not written by a partner, such as the assistant's planning-doc list mailed from the owner's
 * address. It is never a partner idea. An idea is OWNER_IDEA only in a partner's own words.
 */
export const TLC_IDEA_ORIGINS = ["OWNER_IDEA", "BRANDS_SPENDING", "TREND", "SUGGESTED_LIST"] as const;
export type TlcIdeaOrigin = (typeof TLC_IDEA_ORIGINS)[number];
export const TLC_IDEA_ORIGIN_LABEL: Record<TlcIdeaOrigin, string> = {
  OWNER_IDEA: "Partner idea",
  BRANDS_SPENDING: "Brands spending now",
  TREND: "Trend",
  SUGGESTED_LIST: "Suggested list (written by the assistant, 22 Oct)",
};

/**
 * WHO WROTE A LISTED IDEA. A topic found in a partner's email is the partner's idea only when it is
 * in their own sentence, or the email itself says the list is theirs ("my list", "my ideas", "I
 * want…"). A bullet or numbered list with no such claim is a SUGGESTED_LIST, never a partner idea.
 */
export function creditForQuote(text: string, quote: string): "OWNER_IDEA" | "SUGGESTED_LIST" {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const line = text.split(/\r?\n/).find((l) => norm(l).includes(norm(quote).slice(0, 40))) ?? "";
  const listItem = /^\s*(?:[-*•·]|\d+[.)])\s+/.test(line);
  if (!listItem) return "OWNER_IDEA";
  const claimsIt = /\b(my|our) (own )?(ideas?|list|picks|topics)\b|\bI (want|would like|'d like|suggest|propose|think we should)\b|\bideas? (I|we) (had|have)\b/i.test(text);
  return claimsIt ? "OWNER_IDEA" : "SUGGESTED_LIST";
}
export function isIdeaOrigin(v: unknown): v is TlcIdeaOrigin {
  return typeof v === "string" && (TLC_IDEA_ORIGINS as readonly string[]).includes(v);
}
/** An idea's status on the ideas list. DROPPED stays listed: an idea is never deleted or hidden. */
/** MERGED (22 Oct 2026): folded into a bigger idea (`merged_into`), not dropped. */
export const TLC_IDEA_STATUSES = ["LATER", "PICKED", "ALTERNATIVE", "DROPPED", "MERGED"] as const;
export type TlcIdeaStatus = (typeof TLC_IDEA_STATUSES)[number];
/** One key per topic, so "Trading & Investing" and "trading and investing" are one idea. */
export function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The topic's name alone: a trailing "(Saturday afternoon, 1–5 pm)" or "(November 2026 Room)" is scheduling, not the name.
 * 22 Oct 2026: alternatives came back as "Sewing & Visible Mending (Saturday afternoon, 1–5 pm)".
 */
export function topicName(topic: string): string {
  return topic.replace(/\s*\((?=[^)]*\b(?:am|pm|saturday|thursday|friday|sunday|evening|afternoon|morning|room|20\d\d)\b)[^)]*\)\s*$/i, "").trim();
}

/**
 * The same idea under another name? "Peptides & Biohacking: New Year Reset" is the partners' "Peptides and biohacking";
 * "Trading & Investing: Money Reset" is 'Trading & Investing ("Money Reset")'. Parenthesised words and a subtitle after
 * a colon do not make a new idea.
 */
export function sameTopic(a: string, b: string): boolean {
  const k = (t: string) => topicKey(topicName(t).replace(/\(([^)]*)\)/g, " $1 "));
  const head = (t: string) => topicKey(topicName(t).split(":")[0]!.replace(/\(.*?\)/g, " "));
  const ka = k(a), kb = k(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.startsWith(`${kb} `) || kb.startsWith(`${ka} `) || head(a) === head(b);
}

/** Where the owner-approved playbook lives: a Documents entry whose id is kept in `tlc_setting` under this key. */
export const PLAYBOOK_DOCUMENT_SETTING = "playbook_document_id";

export interface TopicsEmailPick {
  month: string;
  topic: string;
  origin: TlcIdeaOrigin;
  angle: string;
  categories: readonly string[];
  /** The glossy one-sheet, as a brand would see it. */
  onePagerUrl: string;
}
export interface TopicsEmailAlternative {
  topic: string;
  origin: TlcIdeaOrigin;
  reason: string;
  brands: readonly string[];
}

/** Words that only ever describe Parker's internal reasoning. None may reach a partner's email. */
const WORKING_NOTES = /\b(reject(?:ed|s|ing)?|not picked|why not|ruled out|turned down|passed over)\b/i;

/**
 * Why this email must not go, or [] when it may. Every month present exactly once, exactly nine
 * alternatives (none repeating a pick), each with a reason and at least one brand, a one-sheet link
 * per pick, and no working notes anywhere in what the partners read.
 */
export function topicsEmailProblems(months: readonly string[], picks: readonly TopicsEmailPick[], alts: readonly TopicsEmailAlternative[]): string[] {
  const out: string[] = [];
  for (const m of months) {
    const n = picks.filter((p) => p.month === m).length;
    if (n !== 1) out.push(`${monthWords(m)} has ${n} picks; it needs exactly one`);
  }
  for (const p of picks) if (!months.includes(p.month)) out.push(`a pick for ${p.month}, which this email is not for`);
  for (const p of picks) if (!/^https:\/\//.test(p.onePagerUrl)) out.push(`${monthWords(p.month)} has no one-sheet link`);
  for (const x of [...picks, ...alts]) if (!isIdeaOrigin(x.origin)) out.push(`"${x.topic}" has no origin label`);
  if (alts.length !== TLC_ALTERNATIVES) out.push(`${alts.length} alternatives; it needs ${TLC_ALTERNATIVES}`);
  const pickNames = new Set(picks.map((p) => p.topic.toLowerCase()));
  const seen = new Set<string>();
  for (const a of alts) {
    const k = a.topic.toLowerCase();
    if (!a.topic || !a.reason) out.push(`an alternative without a topic or a reason`);
    if (a.brands.length === 0) out.push(`the alternative "${a.topic}" names no brand that would pay`);
    if (pickNames.has(k)) out.push(`the alternative "${a.topic}" repeats a pick`);
    if (seen.has(k)) out.push(`the alternative "${a.topic}" is listed twice`);
    seen.add(k);
  }
  const text = [...picks.flatMap((p) => [p.topic, p.angle, ...p.categories]), ...alts.flatMap((a) => [a.topic, a.reason, ...a.brands])].join("\n");
  const note = WORKING_NOTES.exec(text);
  if (note) out.push(`it carries Parker's working notes ("${note[0]}"); those stay on the card`);
  return out;
}

/** The email itself, from data. Throws when `topicsEmailProblems` says it must not go. */
export function topicsEmail(input: { months: readonly string[]; picks: readonly TopicsEmailPick[]; alternatives: readonly TopicsEmailAlternative[]; goAheadOn: string }): {
  what: string;
  tldr: string;
  tldrBullets: string[];
  sections: Array<{ label: string; bullets: string[] }>;
  details: string;
} {
  const problems = topicsEmailProblems(input.months, input.picks, input.alternatives);
  if (problems.length) throw new Error(`the TLC topics email must not go: ${problems.join("; ")}`);
  const picks = [...input.picks].sort((a, b) => a.month.localeCompare(b.month));
  const year = picks[0]!.month.slice(0, 4);
  const alts = input.alternatives.map((a) => `${a.topic} (${TLC_IDEA_ORIGIN_LABEL[a.origin]}): ${a.reason} Brands that would pay: ${a.brands.join(", ")}.`);
  const chunks: string[][] = [];
  for (let i = 0; i < alts.length; i += 3) chunks.push(alts.slice(i, i + 3));
  return {
    what: `TLC topics for ${picks.map((p) => monthWords(p.month).slice(0, 3)).join(", ")} ${year}`,
    tldr: `My ${picks.length} picks for ${picks.map((p) => monthWords(p.month)).join(", ")}, each with the one-sheet a brand would see, plus ${input.alternatives.length} alternatives. They go ahead on ${input.goAheadOn} unless you say no.`,
    tldrBullets: ['Reply "no" to stop all of them', 'Reply "no to <month>" or "swap <month> for <alternative>" to change one', "Silence means go"],
    sections: [
      ...picks.map((p) => ({
        label: `${monthWords(p.month)}: ${p.topic}`,
        bullets: [p.angle, `Where the idea came from: ${TLC_IDEA_ORIGIN_LABEL[p.origin]}`, `Sponsor categories: ${p.categories.join(", ")}`, `The brand pitch and your internal one-pager: ${p.onePagerUrl} (both attached as PDFs)`],
      })),
      ...chunks.map((c, i) => ({ label: `${input.alternatives.length} alternatives (${i * 3 + 1}–${i * 3 + c.length})`, bullets: c })),
    ],
    details: `Brand sending stays off. Nothing goes to any brand until you approve the brand pitch and the playbook on the Rooms page and turn sending on.`,
  };
}
